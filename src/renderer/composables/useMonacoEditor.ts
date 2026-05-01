import { onBeforeUnmount, onMounted, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import * as monaco from "monaco-editor";
import { registerExtraThemes } from "../lib/themes";
import type { Settings } from "../../shared/ipc";

interface UseMonacoEditorOptions {
    hostEl: Readonly<Ref<HTMLElement | null>>;
    settings: Readonly<Ref<Settings | null>>;
    /** URI for the model attached on mount. */
    initialUri: () => string;
    /** Initial code for the model on mount. */
    initialCode: () => string;
}

export interface MonacoEditorHandle {
    editor: ShallowRef<monaco.editor.IStandaloneCodeEditor | null>;
    currentModel: ShallowRef<monaco.editor.ITextModel | null>;
    /**
     * Switch the editor to a different model, saving the previous model's
     * view state and restoring the new one if seen before. Creates the
     * model on first use.
     */
    setModel(uri: string, code: string): monaco.editor.ITextModel;
    /** Persist the editor's current view state under the given URI key. */
    saveViewState(uri: string): void;
}

/**
 * Owns the lifecycle of one Monaco editor instance: creation, theme +
 * font + tab + word-wrap + line-numbers options (kept in sync with
 * `settings.editor.*` via watchers), per-URI view-state persistence,
 * and disposal on unmount.
 *
 * Deliberately knows nothing about LSPs, the run-line glyph, AI
 * completion, or the run-line shortcut — those are wired separately by
 * the parent component so the dependency graph stays one-way.
 */
export function useMonacoEditor(opts: UseMonacoEditorOptions): MonacoEditorHandle {
    const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const currentModel = shallowRef<monaco.editor.ITextModel | null>(null);
    const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

    /**
     * Drop the caret at the end of `model` and scroll it into view. For a
     * fresh scratch tab (seeded with `<?php\n\n`) the end is line 3 col 1,
     * which is where the user wants to start typing — not line 1 col 1
     * where Monaco defaults a newly-attached model. Focus is grabbed too
     * so the first keystroke after opening a tab reaches the editor
     * instead of whatever previously held focus (toolbar, palette).
     */
    function placeCursorAtEnd(ed: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel): void {
        const line = model.getLineCount();
        const column = model.getLineMaxColumn(line);
        ed.setPosition({ lineNumber: line, column });
        ed.revealPosition({ lineNumber: line, column });
        ed.focus();
    }

    function getOrCreateModel(uri: string, value: string): monaco.editor.ITextModel {
        const parsed = monaco.Uri.parse(uri);
        const existing = monaco.editor.getModel(parsed);
        if (existing) {
            if (existing.getValue() !== value) existing.setValue(value);
            return existing;
        }
        return monaco.editor.createModel(value, "php", parsed);
    }

    function setModel(uri: string, code: string): monaco.editor.ITextModel {
        const ed = editor.value;
        const model = getOrCreateModel(uri, code);
        currentModel.value = model;
        if (ed) {
            ed.setModel(model);
            const saved = viewStates.get(uri);
            if (saved) ed.restoreViewState(saved);
            else placeCursorAtEnd(ed, model);
        }
        return model;
    }

    function saveViewState(uri: string): void {
        const ed = editor.value;
        if (!ed) return;
        viewStates.set(uri, ed.saveViewState());
    }

    onMounted(() => {
        if (!opts.hostEl.value) return;
        registerExtraThemes(monaco);

        const model = getOrCreateModel(opts.initialUri(), opts.initialCode());
        currentModel.value = model;
        const settings = opts.settings.value;

        editor.value = monaco.editor.create(opts.hostEl.value, {
            model,
            theme: settings?.editor.theme ?? "vs-dark",
            minimap: { enabled: false },
            fontFamily:
                "SF Mono, ui-monospace, Menlo, Monaco, " +
                "Cascadia Mono, Consolas, " +
                "DejaVu Sans Mono, Liberation Mono, Ubuntu Mono, " +
                "monospace",
            fontSize: settings?.editor.fontSize ?? 13,
            tabSize: settings?.editor.tabSize ?? 4,
            insertSpaces: true,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fixedOverflowWidgets: true,
            bracketPairColorization: { enabled: true },
            suggestOnTriggerCharacters: true,
            // Deliberately `strings: false` — the popup still opens when the
            // user types the opening quote (a trigger character), but Monaco
            // then filters the list *client-side* as they keep typing. If we
            // enabled strings-level quickSuggestions, Monaco would re-query
            // the server on every keystroke inside the string, and laravel-ls
            // re-filters its route/view/config maps by prefix server-side —
            // which clobbers Monaco's fuzzy filter and empties the popup as
            // soon as the typed text doesn't prefix-match any item.
            quickSuggestions: { other: true, comments: false, strings: false },
            smoothScrolling: true,
            wordWrap: settings?.editor.wordWrap ? "on" : "off",
            lineNumbers: settings?.editor.lineNumbers === false ? "off" : "on",
            glyphMargin: true,
            renderValidationDecorations: "on",
            lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
            suggest: { preview: false, showIcons: true },
            stickyScroll: { enabled: false },
            inlineSuggest: { enabled: true, mode: "subwordSmart" },
            // Disable Monaco's built-in right-click context menu. The default OS
            // text-edit menu (Cut/Copy/Paste) is still reachable via standard
            // Cmd+X/C/V, and the app's own ⌘K palette covers anything users
            // would otherwise reach for under "Command Palette". Avoids a
            // half-empty menu of editor-internal actions that don't fit a
            // scratchpad workflow.
            contextmenu: false,
        });

        const mountedModel = editor.value.getModel();
        if (mountedModel) placeCursorAtEnd(editor.value, mountedModel);
    });

    onBeforeUnmount(() => {
        editor.value?.dispose();
        editor.value = null;
        currentModel.value = null;
    });

    // Theme + font + tab + word-wrap + line-numbers reflect the live
    // settings value. Theme is global (monaco.editor.setTheme); the rest
    // are per-editor and need updateOptions.
    watch(
        () => opts.settings.value?.editor.theme,
        (theme) => {
            if (theme) monaco.editor.setTheme(theme);
        },
    );

    watch(
        () =>
            [
                opts.settings.value?.editor.fontSize,
                opts.settings.value?.editor.tabSize,
                opts.settings.value?.editor.wordWrap,
                opts.settings.value?.editor.lineNumbers,
            ] as const,
        () => {
            const ed = editor.value;
            const settings = opts.settings.value;
            if (!ed || !settings) return;
            ed.updateOptions({
                fontSize: settings.editor.fontSize,
                tabSize: settings.editor.tabSize,
                wordWrap: settings.editor.wordWrap ? "on" : "off",
                lineNumbers: settings.editor.lineNumbers ? "on" : "off",
            });
        },
    );

    return { editor, currentModel, setModel, saveViewState };
}
