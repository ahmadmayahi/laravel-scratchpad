import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { isBoundary, resolveStatement, strippedEnd } from "./phpStatement";

/**
 * Build a minimal stub that quacks like `monaco.editor.ITextModel` for
 * the three methods phpStatement actually calls. Keeps the tests free
 * of monaco's DOM/worker bring-up cost (and lets them run in node).
 */
function fakeModel(source: string): monaco.editor.ITextModel {
    const lines = source.split("\n");
    return {
        getLineCount: () => lines.length,
        getLineContent: (n: number) => lines[n - 1] ?? "",
        getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    } as unknown as monaco.editor.ITextModel;
}

describe("strippedEnd", () => {
    it("returns null for out-of-range line numbers", () => {
        const m = fakeModel("a\nb");
        expect(strippedEnd(m, 0)).toBeNull();
        expect(strippedEnd(m, 3)).toBeNull();
    });

    it("strips // line comments and trailing whitespace", () => {
        const m = fakeModel("foo();   // comment   ");
        expect(strippedEnd(m, 1)).toBe("foo();");
    });

    it("preserves embedded // inside string-ish content (we don't tokenise)", () => {
        // Limitation: the regex is naive and will strip a // inside a string
        // literal. That's acceptable for the run-line glyph (worst case the
        // glyph misses a statement) and documented here so a future change
        // can find this constraint via the test.
        const m = fakeModel('echo "//not a comment";');
        expect(strippedEnd(m, 1)).toBe('echo "');
    });
});

describe("isBoundary", () => {
    it("treats blank lines as boundaries", () => {
        const m = fakeModel("$x = 1;\n\n$y = 2;");
        expect(isBoundary(m, 2)).toBe(true);
    });

    it("treats <?php and ?> markers as boundaries", () => {
        const m = fakeModel("<?php\n$x = 1;\n?>");
        expect(isBoundary(m, 1)).toBe(true);
        expect(isBoundary(m, 3)).toBe(true);
    });

    it("treats statement terminators (; { }) as boundaries", () => {
        const m = fakeModel("$x = 1;\nfn () => {\n};");
        expect(isBoundary(m, 1)).toBe(true);
        expect(isBoundary(m, 2)).toBe(true);
        expect(isBoundary(m, 3)).toBe(true);
    });

    it("does not treat plain expressions as boundaries", () => {
        const m = fakeModel("$x = collect([1, 2])\n    ->map(fn ($n) => $n)");
        expect(isBoundary(m, 1)).toBe(false);
    });
});

describe("resolveStatement", () => {
    it("returns null for the <?php opener", () => {
        const m = fakeModel("<?php\n$x = 1;");
        expect(resolveStatement(m, 1)).toBeNull();
    });

    it("returns null for blank lines", () => {
        const m = fakeModel("$x = 1;\n\n$y = 2;");
        expect(resolveStatement(m, 2)).toBeNull();
    });

    it("returns null for lone braces", () => {
        const m = fakeModel("function foo() {\n    return 1;\n}");
        expect(resolveStatement(m, 1)).toBeNull();
        expect(resolveStatement(m, 3)).toBeNull();
    });

    it("captures a single-line statement", () => {
        const m = fakeModel("<?php\n$x = collect([1, 2])->sum();");
        const stmt = resolveStatement(m, 2);
        expect(stmt).not.toBeNull();
        expect(stmt!.startLine).toBe(2);
        expect(stmt!.endLine).toBe(2);
        expect(stmt!.code).toBe("$x = collect([1, 2])->sum();");
    });

    it("walks backwards/forwards to capture a multi-line statement", () => {
        const source = [
            "<?php",
            "",
            "$x = collect([1, 2, 3])",
            "    ->map(fn ($n) => $n * 2)",
            "    ->sum();",
        ].join("\n");
        const m = fakeModel(source);
        const stmt = resolveStatement(m, 4);
        expect(stmt).not.toBeNull();
        expect(stmt!.startLine).toBe(3);
        expect(stmt!.endLine).toBe(5);
        expect(stmt!.code).toContain("collect([1, 2, 3])");
        expect(stmt!.code.endsWith(";")).toBe(true);
    });

    it("returns null when the hover line never reaches a `;` terminator", () => {
        const m = fakeModel("$x = collect([1, 2])");
        expect(resolveStatement(m, 1)).toBeNull();
    });

    it("returns null when the run terminates in a brace block (control flow)", () => {
        const m = fakeModel("if ($x) {\n    return;\n}");
        expect(resolveStatement(m, 1)).toBeNull();
    });
});
