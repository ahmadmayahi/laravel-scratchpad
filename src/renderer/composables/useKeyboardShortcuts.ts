import { onMounted, onUnmounted } from "vue";

interface KeyboardShortcutHandlers {
    onRun: () => void;
    onCancel: () => void;
    onOpenPalette: () => void;
    onNewTab: () => void;
    onCloseTab: () => void;
    onOpenCheatsheet: () => void;
    onOpenArtisan: () => void;
    onOpenSaveSnippet: () => void;
    onOpenSettings: () => void;
}

/**
 * Registers the app-global keyboard shortcuts listed in `lib/shortcuts.ts`.
 * Menu-driven Electron accelerators (⌘R / ⌘. / ⌘,) come through the
 * `window.shortcuts` bridge; free-form ones (⌘K, ⌘T, ⌘W, ⌘⇧A, ⌘⇧S, ⌘?) are
 * captured here via `keydown`.
 *
 * The composable wires everything up on mount and tears it down on unmount
 * so the component owning it (App.vue) doesn't have to manage listeners
 * manually.
 */
export function useKeyboardShortcuts(h: KeyboardShortcutHandlers): void {
    const offFns: Array<() => void> = [];

    function onKey(e: KeyboardEvent): void {
        const modKey = e.metaKey || e.ctrlKey;
        if (!modKey) return;

        if (e.key === "k" && !e.shiftKey) {
            e.preventDefault();
            h.onOpenPalette();
            return;
        }
        if (e.key === "t" && !e.shiftKey) {
            e.preventDefault();
            h.onNewTab();
            return;
        }
        if (e.key === "w" && !e.shiftKey) {
            e.preventDefault();
            h.onCloseTab();
            return;
        }
        // ⌘? (aka Cmd+Shift+/ on US keyboards) — keyboard cheatsheet
        if (e.key === "?" || (e.shiftKey && e.key === "/")) {
            e.preventDefault();
            h.onOpenCheatsheet();
            return;
        }
        // ⌘⇧A — Artisan runner
        if (e.shiftKey && (e.key === "A" || e.key === "a")) {
            e.preventDefault();
            h.onOpenArtisan();
            return;
        }
        // ⌘⇧S — save current buffer as snippet
        if (e.shiftKey && (e.key === "S" || e.key === "s")) {
            e.preventDefault();
            h.onOpenSaveSnippet();
            return;
        }
    }

    onMounted(() => {
        offFns.push(window.shortcuts.onRun(() => h.onRun()));
        offFns.push(window.shortcuts.onCancel(() => h.onCancel()));
        offFns.push(window.shortcuts.onSettings(() => h.onOpenSettings()));
        window.addEventListener("keydown", onKey);
    });

    onUnmounted(() => {
        for (const off of offFns) off();
        window.removeEventListener("keydown", onKey);
    });
}
