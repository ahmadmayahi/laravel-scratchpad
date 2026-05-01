import { onBeforeMount, onMounted, onUnmounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { useAppStore } from "../stores/app";

/**
 * Apply a default dark theme on first paint before settings load, so the
 * body background is never white-on-nothing while the IPC round-trip is
 * in flight.
 */
function primeThemeClass(): void {
    const html = document.documentElement;
    if (!html.classList.contains("theme-light") && !html.classList.contains("theme-dark")) {
        html.classList.add("theme-dark");
    }
}

/**
 * Applies the user-chosen UI theme (light / dark / system) to the <html>
 * element and keeps it in sync with the system preference when "system".
 *
 * Also picks a sensible default Monaco theme whenever the UI mode flips, so
 * the editor doesn't end up dark-themed on a light UI or vice versa.
 */
export function useAppTheme(): void {
    const store = useAppStore();
    const { settings } = storeToRefs(store);

    // Run synchronously before paint so the default dark is set the moment
    // the DOM is available — avoids a one-frame flash of light chrome.
    onBeforeMount(primeThemeClass);

    let media: MediaQueryList | null = null;
    let mediaHandler: (() => void) | null = null;

    function apply(): void {
        if (!settings.value) return;
        const mode = settings.value.ui.mode;
        const isDark = mode === "dark" || (mode === "system" && media?.matches === true);
        const html = document.documentElement;
        html.classList.toggle("theme-dark", isDark);
        html.classList.toggle("theme-light", !isDark);
        // Tailwind's `darkMode: "class"` also needs the `dark` class so
        // `dark:` utility variants (used by Monaco theme, etc.) follow.
        html.classList.toggle("dark", isDark);

        // Auto-sync Monaco theme family when the UI mode changes. We only
        // flip when the current editor theme belongs to the opposite family;
        // anything custom (dracula / monokai / etc.) is preserved.
        const current = settings.value.editor.theme;
        const builtInDark = ["vs-dark", "hc-black"];
        const builtInLight = ["vs", "hc-light"];
        const swap: Record<string, string> = {
            vs: "vs-dark",
            "hc-light": "hc-black",
            "vs-dark": "vs",
            "hc-black": "hc-light",
        };
        if (isDark && builtInLight.includes(current) && swap[current]) {
            void window.lsp
                .settingsSet({
                    editor: { ...settings.value.editor, theme: swap[current] },
                })
                .then(store.setSettings);
        } else if (!isDark && builtInDark.includes(current) && swap[current]) {
            void window.lsp
                .settingsSet({
                    editor: { ...settings.value.editor, theme: swap[current] },
                })
                .then(store.setSettings);
        }
    }

    onMounted(() => {
        media = window.matchMedia("(prefers-color-scheme: dark)");
        mediaHandler = () => {
            if (settings.value?.ui.mode === "system") apply();
        };
        media.addEventListener("change", mediaHandler);
    });

    onUnmounted(() => {
        if (media && mediaHandler) media.removeEventListener("change", mediaHandler);
    });

    // Re-apply any time the mode flips or settings first become available.
    watch(
        () => settings.value?.ui.mode,
        () => apply(),
        { immediate: true },
    );
}
