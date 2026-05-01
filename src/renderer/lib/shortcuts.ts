/**
 * Single source of truth for every user-visible keyboard shortcut.
 *
 * The cheatsheet modal, the command palette's shortcut hints, and the menu-bar
 * accelerators all render from this list so they can never drift apart. The
 * handlers themselves still live in `App.tsx` (or the component that owns
 * each action) — this file is purely descriptive.
 */

export type ShortcutGroup = "Execution" | "Tabs" | "Navigation" | "Tools" | "Editor";

export interface Shortcut {
    /** Display label for the key combo. Stored in macOS notation (⌘ / ⌥
     *  / ⇧) and rewritten by {@link displayKeys} for non-Mac platforms so
     *  the cheatsheet matches what each OS actually labels its modifiers. */
    keys: string;
    /** Human description of what the shortcut does. */
    label: string;
    /** Grouping header in the cheatsheet modal. */
    group: ShortcutGroup;
}

export const SHORTCUTS: Shortcut[] = [
    // Execution
    { keys: "⌘R", label: "Run current tab", group: "Execution" },
    { keys: "⌘.", label: "Cancel running code", group: "Execution" },

    // Tabs
    { keys: "⌘T", label: "New tab", group: "Tabs" },
    { keys: "⌘W", label: "Close current tab", group: "Tabs" },

    // Navigation
    { keys: "⌘K", label: "Open command palette", group: "Navigation" },
    { keys: "⌘,", label: "Open settings", group: "Navigation" },
    { keys: "⌘?", label: "Keyboard shortcut cheatsheet", group: "Navigation" },

    // Tools
    { keys: "⌘⇧A", label: "Run Artisan command", group: "Tools" },
    { keys: "⌘⇧S", label: "Save current buffer as snippet", group: "Tools" },

    // Editor — Monaco built-ins worth surfacing
    { keys: "⌘/", label: "Toggle line comment", group: "Editor" },
    { keys: "⌘F", label: "Find in editor", group: "Editor" },
    { keys: "⌘D", label: "Add next match to selection", group: "Editor" },
    { keys: "⌥↑ / ⌥↓", label: "Move line up / down", group: "Editor" },
];

/**
 * Render a shortcut's key combo for the running platform. On macOS the
 * stored mac-notation passes through unchanged. On Windows / Linux the
 * Apple modifier glyphs are rewritten:
 *
 *   ⌘  → Ctrl
 *   ⌥  → Alt
 *   ⇧  → Shift
 *   ⌃  → Ctrl
 *
 * Followed by a `+` separator so e.g. `⌘⇧A` becomes `Ctrl+Shift+A`.
 *
 * Single-character glyphs at the tail (letters, punctuation, arrows) are
 * left as-is — they're already what Windows / Linux users see on their
 * keys.
 */
export function displayKeys(combo: string): string {
    if (window.platform === "darwin") return combo;
    return (
        combo
            .replace(/⌘/g, "Ctrl+")
            .replace(/⌃/g, "Ctrl+")
            .replace(/⌥/g, "Alt+")
            .replace(/⇧/g, "Shift+")
            // Collapse any consecutive `+` from compound modifiers (e.g. `⌘⇧`
            // becomes `Ctrl+Shift+` — fine — but a stray double-plus from
            // future edits would render badly).
            .replace(/\++/g, "+")
    );
}
