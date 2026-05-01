import * as monaco from "monaco-editor";

interface EditorShortcutHandlers {
    onRun(): void;
    onCancel(): void;
}

/**
 * Bind the editor-internal keyboard shortcuts. Two emits go straight to
 * the parent (`Run`, `Cancel`); the rest re-dispatch as global keydown
 * events so `useKeyboardShortcuts` can pick them up alongside the OS
 * menu shortcuts. Without the bridge, hitting ⌘K inside Monaco would
 * surface Monaco's own command palette instead of ours.
 *
 * Find / Replace shortcuts are bound to no-ops — bottom-anchoring
 * Monaco's find widget couldn't be made reliable, and a top-anchored
 * find covers the first lines of the buffer. Net negative for a
 * scratchpad workflow.
 */
export function bindEditorShortcuts(
    editor: monaco.editor.IStandaloneCodeEditor,
    handlers: EditorShortcutHandlers,
): void {
    const isMac = window.platform === "darwin";
    const dispatchGlobalShortcut = (key: string, shift = false): void => {
        window.dispatchEvent(
            new KeyboardEvent("keydown", {
                key,
                metaKey: isMac,
                ctrlKey: !isMac,
                shiftKey: shift,
                bubbles: true,
            }),
        );
    };

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => handlers.onRun());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, () => handlers.onCancel());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => dispatchGlobalShortcut("k"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT, () => dispatchGlobalShortcut("t"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => dispatchGlobalShortcut("w"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA, () =>
        dispatchGlobalShortcut("a", true),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () =>
        dispatchGlobalShortcut("s", true),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Slash, () =>
        dispatchGlobalShortcut("/", true),
    );

    const noop = (): void => {
        /* swallow */
    };
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, noop);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, noop);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, noop);
}
