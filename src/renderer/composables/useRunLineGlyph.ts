import * as monaco from "monaco-editor";
import { watch, type ShallowRef } from "vue";
import { resolveStatement } from "../lib/phpStatement";

/**
 * Run-line glyph: hover a complete statement → show a play glyph in the
 * gutter and highlight the statement; click the glyph → emit `runLine`
 * with the statement text. Owns the decoration collection lifecycle.
 *
 * Watches the editor ref so it can attach as soon as the instance
 * exists; safe to call during component setup before the editor mounts.
 */
export function useRunLineGlyph(
    editor: ShallowRef<monaco.editor.IStandaloneCodeEditor | null>,
    onRunLine: (code: string) => void,
): void {
    watch(
        editor,
        (ed) => {
            if (!ed) return;
            attach(ed, onRunLine);
        },
        { immediate: true },
    );
}

function attach(ed: monaco.editor.IStandaloneCodeEditor, onRunLine: (code: string) => void): void {
    const decos = ed.createDecorationsCollection();
    let lastHoveredLine = -1;

    ed.onMouseMove((e) => {
        const lineNumber = e.target.position?.lineNumber ?? -1;
        if (lineNumber === lastHoveredLine) return;
        lastHoveredLine = lineNumber;

        const model = ed.getModel();
        if (!model || lineNumber < 1) {
            decos.clear();
            return;
        }
        const stmt = resolveStatement(model, lineNumber);
        if (!stmt) {
            decos.clear();
            return;
        }
        decos.set([
            {
                range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                options: { glyphMarginClassName: "run-line-glyph" },
            },
            {
                range: new monaco.Range(stmt.startLine, stmt.startCol, stmt.endLine, stmt.endCol),
                options: { className: "run-line-highlight" },
            },
        ]);
    });

    ed.onMouseLeave(() => {
        decos.clear();
        lastHoveredLine = -1;
    });

    ed.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const lineNumber = e.target.position?.lineNumber;
        const model = ed.getModel();
        if (!lineNumber || !model) return;
        const stmt = resolveStatement(model, lineNumber);
        if (!stmt) return;
        onRunLine(stmt.code);
    });
}
