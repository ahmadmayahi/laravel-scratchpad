import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";
import { useAppStore } from "../stores/app";
import { useToastStore } from "../stores/toasts";
import type { FramePayload, LaravelLsStatus, PhpAvailability, SkeletonStatus, SplashStep } from "../../shared/ipc";

const WELCOME_CODE =
    "<?php\n\n// Welcome — ⌘R to run, ⌘K for commands.\n\ncollect([1, 2, 3, 4, 5])\n    ->map(fn ($n) => $n * $n)\n    ->sum();\n";

export interface BootSequenceHandle {
    bootComplete: Ref<boolean>;
    laravelLsStatus: Ref<LaravelLsStatus | null>;
    /** Reactive PHP availability — null until the first IPC call resolves. */
    phpAvailable: ComputedRef<boolean>;
    /** Steps the splash screen should render (laravel-ls + optional skeleton). */
    splashSteps: ComputedRef<SplashStep[]>;
    /** True until the boot sequence finishes AND every required splash step
     *  reaches a terminal state (`ready` / `skipped` / `error`). */
    splashOpen: ComputedRef<boolean>;
    onLaravelLsRetry(): Promise<void>;
    onLaravelLsSkip(): Promise<void>;
}

/**
 * Cold-boot sequence: load projects + settings + snippets + laravel-ls
 * status + PHP availability + skeleton state in parallel, then either
 * restore the persisted tab set or seed a welcome tab. After the
 * initial load, subscribes to the always-on event streams (settings
 * changes, sessions reset, frame delivery, skeleton status, PHP
 * availability) so the rest of the app can rely on the store
 * reflecting reality.
 *
 * Returns reactive boot state plus the laravel-ls retry/skip handlers
 * since the splash screen owns those buttons.
 */
export function useBootSequence(): BootSequenceHandle {
    const store = useAppStore();
    const toasts = useToastStore();

    const bootComplete = ref(false);
    const laravelLsStatus = ref<LaravelLsStatus | null>(null);
    const phpAvailability = ref<PhpAvailability | null>(null);
    const phpAvailable = computed(() => phpAvailability.value?.available === true);

    // Skeleton splash state. Tracks ONLY `latest` because that's the
    // one provisioned at boot — secondary slugs are user-triggered and
    // tracked by the Laravel settings tab. `null` means "skeleton step
    // doesn't apply this boot" (latest already ready, or query hasn't
    // resolved yet).
    const skeletonState = ref<SkeletonStatus | null>(null);
    const skeletonDetail = ref<string | null>(null);

    const splashSteps = computed<SplashStep[]>(() => {
        const steps: SplashStep[] = [];

        // laravel-ls step is always present until ready/skipped (terminal
        // states drop it out of the list to keep the splash quiet right
        // before it closes).
        const ls = laravelLsStatus.value;
        if (ls && ls.state !== "ready" && ls.state !== "skipped") {
            steps.push(toSplashStep(ls));
        }

        // Skeleton step is only present when `latest` is mid-provision
        // on this boot. `provisioning` → active step; once it goes
        // `ready` / `failed`, drop it out of the splash so the user
        // sees the editor.
        if (skeletonState.value === "provisioning") {
            steps.push({
                id: "skeleton",
                label: "Setting up Laravel skeleton",
                state: "active",
                detail: skeletonDetail.value ?? undefined,
            });
        }

        return steps;
    });

    const splashOpen = computed(() => !bootComplete.value || splashSteps.value.length > 0);

    async function onLaravelLsRetry(): Promise<void> {
        laravelLsStatus.value = await window.lsp.laravelLsRetry();
    }
    async function onLaravelLsSkip(): Promise<void> {
        await window.lsp.laravelLsSkip();
    }

    const offListeners: Array<() => void> = [];

    onMounted(async () => {
        // Subscribe to laravel-ls + PHP + skeleton events BEFORE the
        // parallel kick-offs so we can't miss a fast `ready` event.
        offListeners.push(
            window.lsp.onLaravelLsStatus((s) => {
                laravelLsStatus.value = s;
            }),
            window.lsp.onLaravelLsProgress((p) => {
                laravelLsStatus.value = {
                    state: "downloading",
                    version: p.version,
                    received: p.received,
                    total: p.total,
                };
            }),
            window.lsp.onPhpAvailability((snapshot) => {
                phpAvailability.value = snapshot;
            }),
            window.lsp.onSkeletonProgress((event) => {
                if (event.slug !== "latest") return;
                skeletonDetail.value = event.detail;
            }),
        );

        const [loadedProjects, loadedSettings, loadedSnippets, finalLaravelLsStatus, initialPhp, initialSkeletons] =
            await Promise.all([
                window.lsp.projectsList(),
                window.lsp.settingsGet(),
                window.lsp.snippetsList(),
                window.lsp.laravelLsPrepare(),
                window.lsp.phpAvailability(),
                window.lsp.skeletonsList(),
            ]);
        store.setProjects(loadedProjects);
        store.setSettings(loadedSettings);
        store.setSnippets(loadedSnippets);
        laravelLsStatus.value = finalLaravelLsStatus;
        phpAvailability.value = initialPhp;
        const latest = initialSkeletons.find((s) => s.slug === "latest");
        skeletonState.value = latest?.status ?? null;

        let restored = false;
        if (loadedSettings.general.restoreTabsOnLaunch && store.tabs.length === 0) {
            const persisted = await window.lsp.tabsLoad();
            if (persisted && persisted.tabs.length > 0) {
                const validIds = new Set(loadedProjects.map((p) => p.id));
                const keep = persisted.tabs.filter((t) => validIds.has(t.projectId));
                if (keep.length > 0) {
                    store.hydrateTabs({ tabs: keep, selectedTabId: persisted.selectedTabId });
                    restored = true;
                }
            }
        }

        if (!restored && store.tabs.length === 0 && loadedProjects.length > 0) {
            store.addTab(loadedProjects[0]!.id);
            const tab = store.tabs[store.tabs.length - 1];
            if (tab) store.updateTabCode(tab.id, WELCOME_CODE);
        }

        bootComplete.value = true;

        offListeners.push(
            window.lsp.onSettingsChanged((s) => store.setSettings(s)),
            window.lsp.onSessionsReset(() => store.resetAllSessions()),
            window.lsp.onFrame((frame) => {
                const tab = store.tabs.find((t) => t.currentRequestId === frame.requestId);
                if (!tab) return;
                store.appendFrame(tab.id, frame as FramePayload);
                if (frame.type === "result" || frame.type === "error" || frame.type === "cancelled") {
                    store.finishRun(tab.id);
                }
            }),
            window.lsp.onSkeletonStatus(async (event) => {
                if (event.slug === "latest") {
                    // Reflect the latest-skeleton transition in the splash
                    // step state. A `ready`/`failed` event drops the step.
                    if (event.status === "ready" || event.status === "removed") {
                        skeletonState.value = "ready";
                    } else if (event.status === "failed") {
                        skeletonState.value = "failed";
                    } else {
                        skeletonState.value = "provisioning";
                    }
                }
                if (event.status === "ready" || event.status === "removed") {
                    store.setProjects(await window.lsp.projectsList());
                }
                if (event.status === "ready") {
                    toasts.push({
                        variant: "success",
                        title: "Skeleton ready",
                        description: event.installedVersion
                            ? `Laravel ${event.installedVersion} (${event.slug}) is available in the project picker.`
                            : `Laravel ${event.slug} is available in the project picker.`,
                    });
                }
            }),
        );
    });

    onBeforeUnmount(() => {
        for (const off of offListeners) off();
    });

    return { bootComplete, laravelLsStatus, phpAvailable, splashSteps, splashOpen, onLaravelLsRetry, onLaravelLsSkip };
}

/**
 * Adapter from the existing `LaravelLsStatus` discriminated union to
 * the generalised `SplashStep` shape the new BootSplash renders. Keeps
 * the laravel-ls IPC contract untouched while the splash UI moves to
 * a multi-step list.
 */
function toSplashStep(status: LaravelLsStatus): SplashStep {
    const label = "Laravel language server";
    switch (status.state) {
        case "checking":
            return { id: "laravelLs", label, state: "active" };
        case "downloading":
            return {
                id: "laravelLs",
                label,
                state: "downloading",
                progress: { received: status.received, total: status.total },
            };
        case "verifying":
            return { id: "laravelLs", label, state: "verifying" };
        case "ready":
            return { id: "laravelLs", label, state: "ready" };
        case "unsupported":
            return {
                id: "laravelLs",
                label,
                state: "error",
                detail: `No prebuilt binary for ${status.platform}/${status.arch}. Intelephense will handle PHP; Laravel-specific autocomplete won't be available.`,
            };
        case "skipped":
            return { id: "laravelLs", label, state: "skipped" };
        case "error":
            return { id: "laravelLs", label, state: "error", detail: status.message };
    }
}
