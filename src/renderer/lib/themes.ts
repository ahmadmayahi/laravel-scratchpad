import type { editor } from "monaco-editor";

/**
 * Extra Monaco themes beyond the built-in `vs` / `vs-dark` / `hc-black`.
 * Registered once on app start — `registerExtraThemes(monaco)`.
 */
interface ThemeDescriptor {
    id: string; // what we pass to `monaco.editor.setTheme(id)`
    label: string; // shown in settings picker
    builtin: boolean; // if true, id is one of vs/vs-dark/hc-black/hc-light
    data?: editor.IStandaloneThemeData;
}

const DRACULA: editor.IStandaloneThemeData = {
    base: "vs-dark",
    inherit: true,
    rules: [
        { token: "comment", foreground: "6272a4", fontStyle: "italic" },
        { token: "keyword", foreground: "ff79c6" },
        { token: "string", foreground: "f1fa8c" },
        { token: "number", foreground: "bd93f9" },
        { token: "type", foreground: "8be9fd" },
        { token: "variable", foreground: "ffb86c" },
        { token: "function", foreground: "50fa7b" },
        { token: "delimiter", foreground: "f8f8f2" },
    ],
    colors: {
        "editor.background": "#282a36",
        "editor.foreground": "#f8f8f2",
        "editor.lineHighlightBackground": "#44475a",
        "editor.selectionBackground": "#44475a",
        "editorCursor.foreground": "#f8f8f2",
        "editorLineNumber.foreground": "#6272a4",
    },
};

const MONOKAI: editor.IStandaloneThemeData = {
    base: "vs-dark",
    inherit: true,
    rules: [
        { token: "comment", foreground: "75715e", fontStyle: "italic" },
        { token: "keyword", foreground: "f92672" },
        { token: "string", foreground: "e6db74" },
        { token: "number", foreground: "ae81ff" },
        { token: "type", foreground: "66d9ef" },
        { token: "variable", foreground: "a6e22e" },
        { token: "function", foreground: "a6e22e" },
    ],
    colors: {
        "editor.background": "#272822",
        "editor.foreground": "#f8f8f2",
        "editor.lineHighlightBackground": "#3e3d32",
        "editorCursor.foreground": "#f8f8f0",
        "editorLineNumber.foreground": "#75715e",
    },
};

const SOLARIZED_LIGHT: editor.IStandaloneThemeData = {
    base: "vs",
    inherit: true,
    rules: [
        { token: "comment", foreground: "93a1a1", fontStyle: "italic" },
        { token: "keyword", foreground: "859900" },
        { token: "string", foreground: "2aa198" },
        { token: "number", foreground: "cb4b16" },
        { token: "type", foreground: "268bd2" },
        { token: "variable", foreground: "6c71c4" },
    ],
    colors: {
        "editor.background": "#fdf6e3",
        "editor.foreground": "#657b83",
        "editor.lineHighlightBackground": "#eee8d5",
        "editorCursor.foreground": "#657b83",
        "editorLineNumber.foreground": "#93a1a1",
    },
};

const ONE_DARK: editor.IStandaloneThemeData = {
    base: "vs-dark",
    inherit: true,
    rules: [
        { token: "comment", foreground: "5c6370", fontStyle: "italic" },
        { token: "keyword", foreground: "c678dd" },
        { token: "string", foreground: "98c379" },
        { token: "number", foreground: "d19a66" },
        { token: "type", foreground: "e5c07b" },
        { token: "variable", foreground: "e06c75" },
        { token: "function", foreground: "61afef" },
    ],
    colors: {
        "editor.background": "#282c34",
        "editor.foreground": "#abb2bf",
        "editor.lineHighlightBackground": "#2c313a",
        "editorCursor.foreground": "#528bff",
        "editorLineNumber.foreground": "#495162",
    },
};

export const themes: ThemeDescriptor[] = [
    { id: "vs-dark", label: "Dark (default)", builtin: true },
    { id: "vs", label: "Light (default)", builtin: true },
    { id: "hc-black", label: "High contrast dark", builtin: true },
    { id: "hc-light", label: "High contrast light", builtin: true },
    { id: "dracula", label: "Dracula", builtin: false, data: DRACULA },
    { id: "monokai", label: "Monokai", builtin: false, data: MONOKAI },
    { id: "solarized-light", label: "Solarized Light", builtin: false, data: SOLARIZED_LIGHT },
    { id: "one-dark", label: "One Dark", builtin: false, data: ONE_DARK },
];

/** Register every non-builtin theme with Monaco. Safe to call repeatedly. */
export function registerExtraThemes(monaco: typeof import("monaco-editor")): void {
    for (const t of themes) {
        if (!t.builtin && t.data) {
            monaco.editor.defineTheme(t.id, t.data);
        }
    }
}
