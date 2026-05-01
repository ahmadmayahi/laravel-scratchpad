import { onBeforeUnmount, watch, type Ref } from "vue";
import * as monaco from "monaco-editor";
import {
    beginLaravelLsOpen,
    bindDocument,
    closeLaravelLsDocument,
    currentRootUri,
    documentUriFor,
    ensureClient,
    ensureLaravelLsClient,
    forwardLaravelLsChange,
    getClient,
    isLaravelLsActive,
    openLaravelLsDocument,
    predictLaravelLsUri,
    workspaceUriFor,
} from "../lib/lspManager";
import type { MonacoEditorHandle } from "./useMonacoEditor";
import type { Tab } from "../stores/app";
import type { Project, Settings } from "../../shared/ipc";

interface UseDualLspBindingsOptions {
    editor: MonacoEditorHandle;
    tab: Readonly<Ref<Tab>>;
    projects: Readonly<Ref<Project[]>>;
    settings: Readonly<Ref<Settings | null>>;
    /** Bumped by `resetIntelephense` from the command palette. */
    lspReinitNonce: Readonly<Ref<number>>;
    /** Persist user-typed code back to the store. Skipped on programmatic edits. */
    onUserType: (code: string) => void;
}

/**
 * Wires the active editor instance into both LSP servers (Intelephense +
 * laravel-ls) and keeps that wiring fresh as the tab's project, code, or
 * PHP version changes. Owns three pieces of mutable bookkeeping:
 *
 *   - `currentUri` / `laravelLsUri` — the URIs the LSPs see this editor
 *     under, kept in sync with the active tab.
 *   - `applyingExternalEdit` — flag flipped while writing
 *     `props.tab.code` programmatically into the model so that the
 *     `onDidChangeModelContent` listener doesn't recursively fire
 *     `onUserType` and clobber the very edit we're applying.
 *   - `switchToken` — incremented on every tab/project/root switch;
 *     stale awaits compare their captured token before mutating state
 *     so a slow LSP startup can't write into a now-superseded swap.
 *
 * Returns nothing — registration is side-effecting; teardown happens
 * automatically on `onBeforeUnmount`.
 */
export function useDualLspBindings(opts: UseDualLspBindingsOptions): void {
    let currentUri: string | null = null;
    let laravelLsUri: string | null = null;
    let applyingExternalEdit = false;
    let switchToken = 0;

    function resolveUri(): string {
        const proj = opts.projects.value.find((p) => p.id === opts.tab.value.projectId);
        const projectPathForUri = proj?.kind === "ssh" ? `/ssh:${proj.id}` : proj?.projectPath;
        return documentUriFor(projectPathForUri, opts.tab.value.id);
    }

    function resolveRootUri(): string | null {
        const proj = opts.projects.value.find((p) => p.id === opts.tab.value.projectId);
        if (!proj) return null;
        if (proj.kind === "ssh") {
            return workspaceUriFor(`/tmp/lsp-ssh-${proj.id}`);
        }
        if (!proj.projectPath) return null;
        return workspaceUriFor(proj.projectPath);
    }

    function isLaravelLsEligible(): boolean {
        const proj = opts.projects.value.find((p) => p.id === opts.tab.value.projectId);
        return proj?.kind === "laravel" && !!proj.projectPath;
    }

    function resolveLocalProjectPath(): string | null {
        const proj = opts.projects.value.find((p) => p.id === opts.tab.value.projectId);
        if (proj?.kind !== "laravel" || !proj.projectPath) return null;
        return proj.projectPath;
    }

    async function switchToTab(): Promise<void> {
        const ed = opts.editor.editor.value;
        if (!ed) return;
        const uri = resolveUri();
        if (currentUri === uri) return;

        const targetRoot = resolveRootUri();
        if (!targetRoot) return;

        const myToken = ++switchToken;

        const eligible = isLaravelLsEligible();
        try {
            await Promise.all([ensureClient(targetRoot), ensureLaravelLsClient(targetRoot, eligible)]);
        } catch (err) {
            // A genuine LSP server crash (vs the spawn races that ensureRunning fixes)
            // can still reject here. Don't let it escape — the watcher fires this with
            // `void switchToTab()`, so an unhandled rejection would surface in the
            // dev console as "Uncaught (in promise)". Press on with the rest of the
            // tab swap so the editor still becomes usable; LSP features just won't
            // light up until the next switch retries.
            console.warn("[EditorPane] LSP bring-up failed during switchToTab:", err);
        }
        if (myToken !== switchToken) return;

        if (currentUri) getClient()?.didClose(currentUri);
        const prevProjectPath = resolveLocalProjectPath();
        const prevLaravelLsUri = laravelLsUri;
        laravelLsUri = null;
        if (prevLaravelLsUri && prevProjectPath) {
            await closeLaravelLsDocument(prevProjectPath, opts.tab.value.id, prevLaravelLsUri);
            if (myToken !== switchToken) return;
        }

        if (currentUri) opts.editor.saveViewState(currentUri);

        currentUri = uri;
        opts.editor.setModel(uri, opts.tab.value.code);
        bindDocument(uri, opts.tab.value.code);
        if (eligible && isLaravelLsActive()) {
            const projPath = resolveLocalProjectPath();
            if (projPath) {
                const predicted = predictLaravelLsUri(projPath, opts.tab.value.id);
                laravelLsUri = predicted;
                beginLaravelLsOpen(predicted);
                try {
                    const actual = await openLaravelLsDocument(projPath, opts.tab.value.id, opts.tab.value.code);
                    if (myToken !== switchToken) return;
                    laravelLsUri = actual;
                } catch {
                    if (myToken === switchToken) laravelLsUri = null;
                }
            }
        }
    }

    /**
     * Wire the change listener — exposed as a side effect so the parent
     * doesn't have to hand it to `useMonacoEditor`. Awaits the editor
     * via watch so we're robust to the editor being created after this
     * composable runs (current shape) or before it (theoretical reorder).
     */
    function attachChangeListener(ed: monaco.editor.IStandaloneCodeEditor): void {
        ed.onDidChangeModelContent((e) => {
            const model = ed.getModel();
            if (!model) return;

            if (currentUri) {
                const intelephense = getClient();
                if (intelephense?.supportsIncrementalSync()) {
                    intelephense.didChange(
                        currentUri,
                        e.changes.map((c) => ({
                            range: {
                                start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
                                end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
                            },
                            text: c.text,
                        })),
                    );
                } else {
                    intelephense?.didChange(currentUri, model.getValue());
                }
            }

            if (laravelLsUri) {
                const changes = e.changes.map((c) => ({
                    range: {
                        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
                        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
                    },
                    text: c.text,
                }));
                forwardLaravelLsChange(laravelLsUri, changes);
            }

            if (applyingExternalEdit) return;
            opts.onUserType(model.getValue());
        });
    }

    // Initial bring-up on mount: kicks off LSP attach for the first tab.
    // Fires once when the editor instance becomes non-null (typically the
    // same tick `useMonacoEditor`'s onMounted ran).
    const stopInit = watch(
        () => opts.editor.editor.value,
        async (ed) => {
            if (!ed) return;
            attachChangeListener(ed);
            const uri = resolveUri();
            currentUri = uri;
            const targetRoot = resolveRootUri();
            if (!targetRoot) {
                stopInit();
                return;
            }
            const eligible = isLaravelLsEligible();
            try {
                await Promise.all([ensureClient(targetRoot), ensureLaravelLsClient(targetRoot, eligible)]);
                bindDocument(uri, opts.tab.value.code);
                if (eligible && isLaravelLsActive()) {
                    const projPath = resolveLocalProjectPath();
                    if (projPath) {
                        laravelLsUri = await openLaravelLsDocument(projPath, opts.tab.value.id, opts.tab.value.code);
                    }
                }
            } catch (err) {
                // onMounted-time rejection has nowhere to escape to — log so
                // dev tools still show the cause if LSP startup blows up.
                console.warn("[EditorPane] LSP bring-up failed during init:", err);
            }
            stopInit();
        },
        { immediate: true },
    );

    onBeforeUnmount(() => {
        if (currentUri) {
            getClient()?.didClose(currentUri);
        }
        if (laravelLsUri) {
            const projPath = resolveLocalProjectPath();
            if (projPath) {
                void closeLaravelLsDocument(projPath, opts.tab.value.id, laravelLsUri);
            }
            laravelLsUri = null;
        }
    });

    // Re-attach when the tab id or its project changes.
    watch(
        () => [opts.tab.value.id, opts.tab.value.projectId] as const,
        () => void switchToTab(),
    );

    // Apply external code changes (snippet replacement, palette inserts)
    // by writing into the model — but flag the operation so the change
    // listener above doesn't loop the value back through `onUserType`.
    watch(
        () => opts.tab.value.code,
        (code) => {
            const model = opts.editor.editor.value?.getModel();
            if (!model) return;
            if (model.getValue() !== code) {
                applyingExternalEdit = true;
                try {
                    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: code }], () => null);
                } finally {
                    applyingExternalEdit = false;
                }
            }
        },
    );

    // PHP version change → re-bind so Intelephense reloads the matching
    // stubs. The manager handles the kill+respawn; we just ask for a
    // fresh client and re-open the document under the same URI.
    watch(
        () => opts.settings.value?.php.defaultBinary,
        async () => {
            const targetRoot = resolveRootUri();
            if (!targetRoot) return;
            const eligible = isLaravelLsEligible();
            try {
                await Promise.all([ensureClient(targetRoot), ensureLaravelLsClient(targetRoot, eligible)]);
                if (currentUri) bindDocument(currentUri, opts.tab.value.code);
            } catch (err) {
                console.warn("[EditorPane] LSP bring-up failed after PHP version change:", err);
            }
        },
    );

    // "Rebuild workspace index" from the palette nukes the cache and
    // bumps the nonce; we re-bind against a freshly-spawned Intelephense.
    watch(opts.lspReinitNonce, async () => {
        const targetRoot = resolveRootUri();
        if (!targetRoot) return;
        try {
            await ensureClient(targetRoot);
            if (!currentUri) return;
            const model = opts.editor.editor.value?.getModel();
            const content = model?.getValue() ?? opts.tab.value.code;
            bindDocument(currentUri, content);
        } catch (err) {
            console.warn("[EditorPane] LSP reinit failed:", err);
        }
    });

    // Project-root change for the active tab (renaming the project, or
    // the user editing project metadata) needs a full LSP swap.
    watch(
        () => resolveRootUri(),
        (target) => {
            if (target && target !== currentRootUri()) void switchToTab();
        },
    );
}
