import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useAppStore } from "../stores/app";
import { resetIntelephense } from "../lib/lspManager";
import type { Tab } from "../stores/app";

interface UseIdeHelperPromptOptions {
    selectedTab: Readonly<Ref<Tab | null>>;
    /** Held off until cold-boot completes so we don't pop a dialog over the splash. */
    bootComplete: Readonly<Ref<boolean>>;
}

export interface IdeHelperPromptHandle {
    /** ID of the project the prompt is currently asking about, or null when closed. */
    promptFor: Ref<string | null>;
    /** Display name of the project being prompted about. */
    promptName: ComputedRef<string>;
    /** Close the prompt; remembers the project for the rest of this session so we don't re-prompt. */
    onClose(): void;
    /** User clicked "Don't ask again" — persists declined=true on the project. */
    onDeclined(projectId: string): Promise<void>;
    /** Install completed — refresh project list and rebuild the LSP index against the new stubs. */
    onInstalled(projectId: string): Promise<void>;
}

/**
 * "Want to install ide-helper for this project?" prompt orchestration.
 * Triggers when the user activates a Laravel project that has neither
 * the helper installed nor the prompt previously declined. Skipped for
 * bundled skeletons (we manage those ourselves) and SSH projects (we
 * don't run composer remotely).
 *
 * Once a user dismisses the prompt for a project, this composable
 * remembers it for the rest of the session — so they aren't pestered
 * every time they switch tabs back to that project.
 */
export function useIdeHelperPrompt(opts: UseIdeHelperPromptOptions): IdeHelperPromptHandle {
    const store = useAppStore();
    const promptFor = ref<string | null>(null);
    const dismissedThisSession = new Set<string>();

    function maybePrompt(projectId: string | undefined): void {
        if (!projectId) return;
        if (promptFor.value) return;
        if (dismissedThisSession.has(projectId)) return;
        const proj = store.projects.find((p) => p.id === projectId);
        if (!proj || proj.kind !== "laravel") return;
        if (proj.ideHelperDeclined) return;
        if (proj.ideHelperInstalled) return;
        if (proj.isBundled) return;
        promptFor.value = projectId;
    }

    const promptName = computed(() => {
        const id = promptFor.value;
        if (!id) return "";
        return store.projects.find((p) => p.id === id)?.name ?? "this project";
    });

    function onClose(): void {
        const id = promptFor.value;
        if (id) dismissedThisSession.add(id);
        promptFor.value = null;
    }

    async function onDeclined(projectId: string): Promise<void> {
        const updated = await window.lsp.projectsSetIdeHelperDeclined(projectId, true);
        if (updated) {
            const next = store.projects.map((p) => (p.id === projectId ? updated : p));
            store.setProjects(next);
        }
    }

    async function onInstalled(_projectId: string): Promise<void> {
        const ps = await window.lsp.projectsList();
        store.setProjects(ps);
        await resetIntelephense();
    }

    watch(
        () => opts.selectedTab.value?.projectId,
        (projectId) => {
            if (!opts.bootComplete.value) return;
            maybePrompt(projectId);
        },
    );

    // First-paint trigger once the boot sequence settles — we may already
    // be on a Laravel project that needs the prompt.
    watch(opts.bootComplete, (done) => {
        if (done) maybePrompt(opts.selectedTab.value?.projectId);
    });

    return { promptFor, promptName, onClose, onDeclined, onInstalled };
}
