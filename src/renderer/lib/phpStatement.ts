import * as monaco from "monaco-editor";

/**
 * Run-line glyph — pure logic for the "click the gutter to run just this
 * statement" affordance in `EditorPane.vue`. Lives outside the component so
 * it can be unit-tested without spinning up a Monaco editor.
 *
 * The grammar this recognises is the *post-bootstrap* PHP eval'd by the
 * scratchpad: a sequence of top-level statements terminated by `;`,
 * possibly spanning multiple physical lines. Anything more ambitious
 * (control-flow blocks, function bodies, classes) deliberately falls out
 * of the "single statement" notion and shows no glyph.
 */

export interface StatementRange {
    startLine: number;
    endLine: number;
    startCol: number;
    endCol: number;
    code: string;
}

/**
 * Read line `n` (1-indexed) with trailing `// comment` and trailing
 * whitespace stripped. Returns `null` when `n` is out of range so callers
 * can use it as a quick "out of buffer" signal.
 */
export function strippedEnd(model: monaco.editor.ITextModel, n: number): string | null {
    if (n < 1 || n > model.getLineCount()) return null;
    return model
        .getLineContent(n)
        .replace(/\/\/.*$/, "")
        .trimEnd();
}

/**
 * Is line `n` a statement boundary? True for blank lines, the `<?php` /
 * `?>` markers, and any line ending in `;`, `{`, or `}`. Used to walk
 * outward from a hover line and find the start of the enclosing statement.
 */
export function isBoundary(model: monaco.editor.ITextModel, n: number): boolean {
    const t = strippedEnd(model, n);
    if (t === null) return true;
    const trimmed = t.trim();
    if (trimmed === "") return true;
    if (/^<\?(php)?\b/i.test(trimmed) || trimmed === "?>") return true;
    return t.endsWith(";") || t.endsWith("{") || t.endsWith("}");
}

/**
 * Resolve the statement enclosing the given hover line, or null if the
 * line isn't part of a runnable statement (boundary, opener, brace).
 *
 * Walks backwards to a boundary, then forwards to a `;`-terminated line,
 * and returns the full statement text plus the column range to highlight
 * in Monaco. Returning `null` is the "no glyph" signal for the caller.
 */
export function resolveStatement(model: monaco.editor.ITextModel, hovered: number): StatementRange | null {
    const t = strippedEnd(model, hovered);
    if (t === null) return null;
    const trimmed = t.trim();
    if (trimmed === "") return null;
    if (/^<\?(php)?\b/i.test(trimmed) || trimmed === "?>") return null;
    if (trimmed === "{" || trimmed === "}") return null;

    let startLine = hovered;
    while (startLine > 1 && !isBoundary(model, startLine - 1)) startLine--;

    let endLine = hovered;
    const lineCount = model.getLineCount();
    while (endLine <= lineCount) {
        const et = strippedEnd(model, endLine);
        if (et === null) return null;
        if (et.endsWith(";")) break;
        if (et.endsWith("{") || et.endsWith("}")) return null;
        if (et.trim() === "") return null;
        endLine++;
    }
    if (endLine > lineCount) return null;

    const startText = model.getLineContent(startLine);
    const firstNonWs = startText.search(/\S/);
    const startCol = firstNonWs < 0 ? 1 : firstNonWs + 1;

    const endText = model.getLineContent(endLine);
    const endCol = endText.lastIndexOf(";") + 2;

    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) lines.push(model.getLineContent(i));
    return { startLine, endLine, startCol, endCol, code: lines.join("\n") };
}
