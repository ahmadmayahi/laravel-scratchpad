import { onBeforeUnmount, shallowRef } from "vue";
import * as monaco from "monaco-editor";

/**
 * Tiny imperative bus: at most one EditorPane is mounted at a time
 * (tabs swap models on a shared editor, but only the selected tab's
 * pane exists in the DOM), so a single shallow ref to the active
 * editor is enough to let UI surfaces — command palette, snippet
 * dialogs — reach into it without piping reactive state through
 * Pinia. Replaces the previous `snippetInsertRequest` command-bus ref.
 */
const activeEditor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);

/** Register the current EditorPane's editor instance; auto-deregisters on unmount. */
export function registerActiveEditor(ed: monaco.editor.IStandaloneCodeEditor): void {
    activeEditor.value = ed;
    onBeforeUnmount(() => {
        if (activeEditor.value === ed) activeEditor.value = null;
    });
}

/**
 * Insert `code` at the active editor's caret (or replace the current
 * selection if any), then re-focus it. No-op when no editor is mounted —
 * callers shouldn't need to gate on it.
 */
export function insertSnippetIntoActiveEditor(code: string): void {
    const ed = activeEditor.value;
    if (!ed) return;
    const selection = ed.getSelection();
    if (!selection) return;
    ed.executeEdits("snippet", [
        {
            range: selection,
            text: code,
            forceMoveMarkers: true,
        },
    ]);
    ed.focus();
}
