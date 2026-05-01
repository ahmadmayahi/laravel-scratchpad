import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import type { Project, FramePayload, PersistedTabs, Settings, Snippet } from "../../shared/ipc";

export interface Tab {
    id: string;
    title: string;
    code: string;
    projectId: string;
    /**
     * Per-tab PHP binary. Lets the user open two tabs against the same
     * project but pin them to different PHP versions for side-by-side
     * comparison. `null` falls through the resolution chain (settings
     * default → first enabled binary).
     */
    phpBinary: string | null;
    /**
     * Per-tab database connection. `null` (the default for new tabs)
     * means "use the project's `.env`"; a string is the chosen
     * connection id. Only takes effect for bundled skeletons; local +
     * SSH projects always use their own `.env`.
     */
    databaseConnectionId: string | null;
    frames: FramePayload[];
    /**
     * True from the moment the user clicks Run until the worker session
     * is booted + ready. For local PHP this is sub-second; for SSH
     * projects it can be 5-30 s (handshake + heredoc upload + Laravel
     * bootstrap). Separate from `isRunning` so the UI can show a distinct
     * "starting" state without waiting for a request to actually execute.
     */
    isStarting: boolean;
    isRunning: boolean;
    lastDurationMs: number | null;
    lastError: string | null;
    sessionId: string | null;
    currentRequestId: string | null;
}

function uuid(): string {
    return (crypto as { randomUUID?: () => string }).randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/**
 * Discriminated union for the only-one-open-at-a-time modal stack.
 * `null` means no dialog is open; everything else identifies which
 * one. Replaces the previous five separate booleans plus the
 * "manage" / "save" sub-mode for snippets.
 */
export type Dialog = null | "settings" | "cheatsheet" | "artisan" | "snippetsManage" | "snippetsSave" | "addSsh";

export const useAppStore = defineStore("app", () => {
    const tabs = ref<Tab[]>([]);
    const selectedTabId = ref<string | null>(null);
    const projects = ref<Project[]>([]);
    const snippets = ref<Snippet[]>([]);
    const settings = ref<Settings | null>(null);

    /**
     * Mutually-exclusive modal dialogs. A single discriminated union
     * replaces what was previously a row of unrelated booleans, so the
     * "only one open at a time" invariant is enforced by the type
     * system instead of by 5 separate watchers.
     */
    const dialog = ref<Dialog>(null);

    /**
     * Intelephense progress tracker — map of active workDoneProgress tokens
     * to their latest message. Empty means idle; non-empty means something
     * is being indexed / resolved. Status bar reads this.
     */
    const indexingTasks = reactive<Record<string, { title?: string; message?: string; percentage?: number }>>({});

    /**
     * Incremented by `resetIntelephense()` when the user forces a fresh
     * LSP client (e.g. via "LSP: Rebuild workspace index" from the palette).
     * `EditorPane`'s init effect watches this so it re-fires after the
     * cache is nuked, spinning up a new Intelephense process.
     */
    const lspReinitNonce = ref(0);

    const selectedTab = computed<Tab | null>(() => tabs.value.find((t) => t.id === selectedTabId.value) ?? null);

    /**
     * Add a tab. Optional `init` lets the caller seed the per-tab PHP /
     * database / project — used so `newTab` can inherit the active
     * tab's settings, letting the user fork-and-tweak rather than
     * picking everything from scratch.
     */
    function addTab(
        projectId: string,
        init?: { phpBinary?: string | null; databaseConnectionId?: string | null },
    ): void {
        const tab: Tab = {
            id: uuid(),
            title: `Scratch ${tabs.value.length + 1}`,
            // Seed with the visible `<?php` opener so Intelephense parses
            // the buffer as PHP from the first keystroke and Monaco's
            // tokenizer flips into PHP highlighting mode. The runner
            // strips the opener before eval'ing (see `runCode` in App.vue).
            code: "<?php\n\n",
            projectId,
            phpBinary: init?.phpBinary ?? null,
            databaseConnectionId: init?.databaseConnectionId ?? null,
            frames: [],
            isStarting: false,
            isRunning: false,
            lastDurationMs: null,
            lastError: null,
            sessionId: null,
            currentRequestId: null,
        };
        tabs.value = [...tabs.value, tab];
        selectedTabId.value = tab.id;
    }

    function closeTab(id: string): void {
        tabs.value = tabs.value.filter((t) => t.id !== id);
        if (selectedTabId.value === id) {
            selectedTabId.value = tabs.value.at(-1)?.id ?? null;
        }
    }

    function selectTab(id: string): void {
        selectedTabId.value = id;
    }

    function updateTabCode(id: string, code: string): void {
        const tab = tabs.value.find((t) => t.id === id);
        if (tab) tab.code = code;
    }

    function renameTab(id: string, title: string): void {
        const tab = tabs.value.find((t) => t.id === id);
        if (tab) tab.title = title;
    }

    function hydrateTabs(payload: PersistedTabs): void {
        const next: Tab[] = payload.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            // One-shot migration for tabs persisted before the simplification
            // pass: prepend `<?php\n\n` if missing so Intelephense parses
            // them correctly and Monaco's PHP tokenizer kicks in.
            code: /^\s*<\?php\b/.test(t.code) ? t.code : `<?php\n\n${t.code}`,
            projectId: t.projectId,
            // Persisted-shape upgrade: tabs saved before per-tab PHP / DB
            // landed lack these keys, so default to "no override / use .env".
            phpBinary: t.phpBinary ?? null,
            databaseConnectionId: t.databaseConnectionId ?? null,
            frames: [],
            isStarting: false,
            isRunning: false,
            lastDurationMs: null,
            lastError: null,
            sessionId: null,
            currentRequestId: null,
        }));
        tabs.value = next;
        selectedTabId.value =
            payload.selectedTabId && next.some((t) => t.id === payload.selectedTabId)
                ? payload.selectedTabId
                : (next[0]?.id ?? null);
    }

    function patchTab(id: string, patch: Partial<Tab>): void {
        const tab = tabs.value.find((t) => t.id === id);
        if (tab) Object.assign(tab, patch);
    }

    function setTabStarting(tabId: string, starting: boolean): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (tab) tab.isStarting = starting;
    }

    function startRun(tabId: string, requestId: string, sessionId: string): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        tab.frames = [];
        tab.isStarting = false;
        tab.isRunning = true;
        tab.lastError = null;
        tab.currentRequestId = requestId;
        tab.sessionId = sessionId;
    }

    // Cap frames per tab to bound renderer memory on runaway output. A
    // script that loops dumping every element in a 10M-row collection
    // would otherwise grow `tab.frames` without bound and eventually
    // freeze the tab. When the cap trips we drop the oldest frames from
    // the middle (keep the 100 earliest for context, plus the most
    // recent run's tail) and insert a synthetic dump that makes the
    // truncation visible rather than silent.
    const FRAME_CAP = 10_000;
    const KEEP_HEAD = 100;

    function appendFrame(tabId: string, frame: FramePayload): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        let next = [...tab.frames, frame];
        if (next.length > FRAME_CAP) {
            const head = next.slice(0, KEEP_HEAD);
            const droppedCount = next.length - FRAME_CAP;
            const tail = next.slice(next.length - (FRAME_CAP - KEEP_HEAD - 1));
            const marker: FramePayload = {
                type: "stdout",
                id: "truncation",
                chunk: `… [${droppedCount.toLocaleString()} frame${droppedCount === 1 ? "" : "s"} truncated to keep the UI responsive] …\n`,
            };
            next = [...head, marker, ...tail];
        }
        tab.frames = next;
        if (frame.type === "result") {
            tab.lastDurationMs = frame.duration_ms;
        } else if (frame.type === "error") {
            tab.lastError = `${frame.class}: ${frame.message}`;
        }
    }

    function finishRun(tabId: string): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        tab.isStarting = false;
        tab.isRunning = false;
        tab.currentRequestId = null;
    }

    function clearTabFrames(tabId: string): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        tab.frames = [];
        tab.lastDurationMs = null;
    }

    function setProjects(ps: Project[]): void {
        projects.value = ps;
    }

    function setTabProject(tabId: string, projectId: string): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        tab.projectId = projectId;
        tab.sessionId = null;
        tab.currentRequestId = null;
    }

    /**
     * Per-tab PHP binary setter. Drops the existing session — the worker
     * is bound to a specific PHP at spawn time, so reusing it after a
     * version swap would silently keep running on the old binary.
     */
    function setTabPhp(tabId: string, phpBinary: string | null): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        if (tab.phpBinary === phpBinary) return;
        tab.phpBinary = phpBinary;
        tab.sessionId = null;
        tab.currentRequestId = null;
    }

    /**
     * Per-tab database connection setter. `null` means "use the
     * project's `.env`"; a string is the chosen connection id. Drops
     * the session for the same reason as `setTabPhp`: env vars are
     * baked in at spawn time.
     */
    function setTabDatabase(tabId: string, databaseConnectionId: string | null): void {
        const tab = tabs.value.find((t) => t.id === tabId);
        if (!tab) return;
        if (tab.databaseConnectionId === databaseConnectionId) return;
        tab.databaseConnectionId = databaseConnectionId;
        tab.sessionId = null;
        tab.currentRequestId = null;
    }

    function selectProject(projectId: string): void {
        if (selectedTabId.value) {
            setTabProject(selectedTabId.value, projectId);
        } else {
            addTab(projectId);
        }
    }

    function setSnippets(s: Snippet[]): void {
        snippets.value = s;
    }

    function upsertSnippet(s: Snippet): void {
        const idx = snippets.value.findIndex((x) => x.id === s.id);
        if (idx === -1) {
            snippets.value = [s, ...snippets.value];
            return;
        }
        const next = snippets.value.slice();
        next[idx] = s;
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        snippets.value = next;
    }

    function removeSnippet(id: string): void {
        snippets.value = snippets.value.filter((s) => s.id !== id);
    }

    function setSettings(s: Settings): void {
        settings.value = s;
    }

    function openDialog(kind: Exclude<Dialog, null>): void {
        dialog.value = kind;
    }

    function closeDialog(): void {
        dialog.value = null;
    }

    function resetAllSessions(): void {
        for (const t of tabs.value) {
            t.sessionId = null;
            t.currentRequestId = null;
            t.isStarting = false;
            t.isRunning = false;
        }
    }

    function setIndexingTask(
        token: string,
        info: { title?: string; message?: string; percentage?: number } | null,
    ): void {
        if (info === null) {
            delete indexingTasks[token];
        } else {
            indexingTasks[token] = info;
        }
    }

    function bumpLspReinitNonce(): void {
        lspReinitNonce.value++;
    }

    return {
        tabs,
        selectedTabId,
        projects,
        snippets,
        settings,
        dialog,
        indexingTasks,
        lspReinitNonce,

        selectedTab,

        addTab,
        closeTab,
        selectTab,
        updateTabCode,
        renameTab,
        hydrateTabs,
        patchTab,

        setTabStarting,
        startRun,
        appendFrame,
        finishRun,
        clearTabFrames,

        setProjects,
        setTabProject,
        setTabPhp,
        setTabDatabase,
        selectProject,

        setSnippets,
        upsertSnippet,
        removeSnippet,

        setSettings,

        openDialog,
        closeDialog,

        resetAllSessions,

        setIndexingTask,
        bumpLspReinitNonce,
    };
});
