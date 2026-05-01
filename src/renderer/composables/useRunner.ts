import type { Ref } from "vue";
import { useAppStore, type Tab } from "../stores/app";
import type { Project } from "../../shared/ipc";

interface UseRunnerOptions {
    selectedTab: Readonly<Ref<Tab | null>>;
    projects: Readonly<Ref<Project[]>>;
}

export interface RunnerHandle {
    /** Run arbitrary code against the active tab's session. */
    runCode(code: string): Promise<void>;
    /** Run the active tab's full buffer. Wired to the toolbar / ⌘R / menu. */
    runActive(): void;
    /** Cancel the in-flight execution, if any. */
    cancelActive(): Promise<void>;
}

/**
 * Run-orchestration glue. Hides the per-tab worker-session lifecycle
 * (start → exec → frame stream → finish) from the view layer and owns
 * the "stale session" recovery path: if the renderer's cached
 * `sessionId` points at a worker the main process has already torn
 * down (settings change, project edit, manual `runner.stopAll()`),
 * the next exec returns "Unknown session" — we transparently start a
 * fresh worker and retry, so the user sees a single uninterrupted Run.
 *
 * Local errors (binary missing, project gone) surface as a synthetic
 * `error` frame so they appear in the Result pane next to PHP errors
 * rather than in a toast.
 */
export function useRunner(opts: UseRunnerOptions): RunnerHandle {
    const store = useAppStore();

    async function runCode(code: string): Promise<void> {
        const tab = opts.selectedTab.value;
        if (!tab || tab.isRunning || tab.isStarting) return;
        const proj = opts.projects.value.find((p) => p.id === tab.projectId);
        if (!proj) return;

        const stripped = code.replace(/^\s*<\?php\b\s*/i, "");
        try {
            // Per-tab PHP / DB overrides — `undefined` for `databaseConnectionId`
            // tells the backend to fall back to settings; `null` is the explicit
            // "no override" state. The backend does the resolution; the renderer
            // just forwards the tab's authoritative state.
            const overrides = {
                phpBinary: tab.phpBinary,
                databaseConnectionId: tab.databaseConnectionId,
            };
            let sessionId = tab.sessionId;
            try {
                if (!sessionId) {
                    store.setTabStarting(tab.id, true);
                    try {
                        const started = await window.lsp.runnerStart(proj.id, overrides);
                        sessionId = started.sessionId;
                    } finally {
                        store.setTabStarting(tab.id, false);
                    }
                }
                const { requestId } = await window.lsp.runnerExec(sessionId, stripped);
                store.startRun(tab.id, requestId, sessionId);
            } catch (err) {
                const msg = String((err as Error).message ?? err);
                if (msg.includes("Unknown session")) {
                    store.setTabStarting(tab.id, true);
                    try {
                        const started = await window.lsp.runnerStart(proj.id, overrides);
                        sessionId = started.sessionId;
                    } finally {
                        store.setTabStarting(tab.id, false);
                    }
                    const { requestId } = await window.lsp.runnerExec(sessionId, stripped);
                    store.startRun(tab.id, requestId, sessionId);
                } else {
                    throw err;
                }
            }
        } catch (e) {
            store.appendFrame(tab.id, {
                type: "error",
                id: "local",
                class: "LaunchError",
                message: String((e as Error).message ?? e),
                trace: [],
            });
            store.finishRun(tab.id);
        }
    }

    function runActive(): void {
        const tab = opts.selectedTab.value;
        if (tab) void runCode(tab.code);
    }

    async function cancelActive(): Promise<void> {
        const tab = opts.selectedTab.value;
        if (!tab?.sessionId) return;
        await window.lsp.runnerCancel(tab.sessionId);
    }

    return { runCode, runActive, cancelActive };
}
