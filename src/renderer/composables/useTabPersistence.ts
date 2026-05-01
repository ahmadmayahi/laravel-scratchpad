import { onBeforeUnmount, watch, type Ref } from "vue";
import type { Tab } from "../stores/app";
import type { PersistedTabs } from "../../shared/ipc";

interface UseTabPersistenceOptions {
    tabs: Readonly<Ref<Tab[]>>;
    selectedTabId: Readonly<Ref<string | null>>;
    /** Watcher only fires once boot is done, otherwise we'd save the empty initial state over a real persisted snapshot. */
    bootComplete: Readonly<Ref<boolean>>;
}

const SAVE_DEBOUNCE_MS = 400;

/**
 * Debounced tab persistence. Only the persistable slice of each tab
 * (id, title, code, projectId, phpBinary, databaseConnectionId) feeds
 * the watcher so frame appends and isRunning flips don't trigger writes.
 * Best-effort — failures are swallowed; the user's worst case is losing
 * the most recent ~400 ms of typing on a hard crash.
 */
export function useTabPersistence(opts: UseTabPersistenceOptions): void {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    watch(
        () =>
            [
                opts.tabs.value.map((t) => ({
                    id: t.id,
                    title: t.title,
                    code: t.code,
                    projectId: t.projectId,
                    phpBinary: t.phpBinary,
                    databaseConnectionId: t.databaseConnectionId,
                })),
                opts.selectedTabId.value,
            ] as const,
        ([persistable, selectedId]) => {
            if (!opts.bootComplete.value) return;
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                const payload: PersistedTabs = {
                    tabs: persistable,
                    selectedTabId: selectedId,
                };
                window.lsp.tabsSave(payload).catch(() => {
                    /* best-effort */
                });
            }, SAVE_DEBOUNCE_MS);
        },
        { deep: true },
    );

    onBeforeUnmount(() => {
        if (saveTimer) clearTimeout(saveTimer);
    });
}
