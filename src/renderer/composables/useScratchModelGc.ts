import { watch, type Ref } from "vue";
import type { Tab } from "../stores/app";
import type { Project } from "../../shared/ipc";
import { disposeScratchModel } from "../lib/lspManager";

interface UseScratchModelGcOptions {
    tabs: Readonly<Ref<Tab[]>>;
    projects: Readonly<Ref<Project[]>>;
}

/**
 * Dispose Monaco's per-tab text models and the laravel-ls scratch
 * files when their owning tab disappears. Without this, closing a tab
 * leaves the model + LSP didOpen entry around forever, slowly leaking
 * memory and spamming Intelephense diagnostics for an unmounted buffer.
 *
 * Tracks the projectId at the time we last saw each tab — the model
 * URI is keyed off the project's path / SSH id, so we need the
 * historical association to compute the URI for disposal even after
 * the tab is gone from the live array.
 */
export function useScratchModelGc(opts: UseScratchModelGcOptions): void {
    const seen = new Map<string, { projectId: string }>();

    watch(
        opts.tabs,
        (now) => {
            const currentIds = new Set(now.map((t) => t.id));
            for (const [id, meta] of seen) {
                if (currentIds.has(id)) continue;
                const proj = opts.projects.value.find((p) => p.id === meta.projectId);
                const projectPathForUri = proj?.kind === "ssh" ? `/ssh:${proj.id}` : proj?.projectPath;
                disposeScratchModel(projectPathForUri, id);
                seen.delete(id);
            }
            for (const t of now) {
                seen.set(t.id, { projectId: t.projectId });
            }
        },
        { immediate: true },
    );
}
