import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type {
    IdeHelperProgress,
    LaravelLsProgress,
    LaravelLsStatus,
    LspBridge,
    FramePayload,
    PhpAvailability,
    Settings,
    SkeletonProvisionProgress,
    SkeletonStatusEvent,
    SqliteAvailability,
    SshAuthMode,
} from "../shared/ipc.js";

/**
 * Typed surface that the renderer sees as `window.lsp`. All sensitive
 * capabilities (child_process, fs, dialog, SQLite, ssh spawning) are
 * hidden in the main process; the renderer only ever calls these async
 * proxies.
 *
 * Channel literals are intentionally inlined here rather than imported
 * from `src/shared/ipcChannels.ts`. Electron's sandboxed preload (we
 * use `sandbox: true` for security) restricts `require()` to a small
 * whitelist — it can't load arbitrary relative .js files at runtime.
 * Bundling the preload would let us share the const, but for ~75
 * one-line strings the duplication is cheaper than a separate build
 * pipeline. Main-side IPC handlers DO use the centralised CH const
 * (where one channel is referenced from many modules); diffs between
 * the two sides surface immediately as a hanging IPC call in dev.
 */
const bridge: LspBridge = {
    runnerStart: (projectId, overrides) => ipcRenderer.invoke("runner:start", projectId, overrides),
    runnerExec: (sessionId, code) => ipcRenderer.invoke("runner:exec", sessionId, code),
    runnerCancel: (sessionId) => ipcRenderer.invoke("runner:cancel", sessionId),
    onFrame: (listener) => {
        const handler = (_e: IpcRendererEvent, frame: FramePayload & { sessionId: string; requestId: string }) =>
            listener(frame);
        ipcRenderer.on("frame", handler);
        return () => ipcRenderer.off("frame", handler);
    },

    onSecretPrompt: (listener) => {
        const handler = (
            _e: IpcRendererEvent,
            req: {
                id: string;
                projectId: string;
                projectName: string;
                authMode: SshAuthMode;
            },
        ) => listener(req);
        ipcRenderer.on("projects:secretPrompt", handler);
        return () => ipcRenderer.off("projects:secretPrompt", handler);
    },
    secretPromptRespond: (id, secret) => ipcRenderer.send("projects:secretPromptRespond", id, secret),

    projectsList: () => ipcRenderer.invoke("projects:list"),
    projectsRemove: (id) => ipcRenderer.invoke("projects:remove", id),
    projectsPickLaravel: () => ipcRenderer.invoke("projects:pickLaravel"),
    projectsPickSshKey: () => ipcRenderer.invoke("projects:pickSshKey"),
    projectsAddSsh: (input) => ipcRenderer.invoke("projects:addSsh", input),
    projectsTestSsh: (input) => ipcRenderer.invoke("projects:testSsh", input),
    projectsSetIdeHelperDeclined: (id, declined) => ipcRenderer.invoke("projects:setIdeHelperDeclined", id, declined),

    ideHelperInstall: (projectId) => ipcRenderer.invoke("ideHelper:install", projectId),
    onIdeHelperProgress: (listener) => {
        const handler = (_e: IpcRendererEvent, event: IdeHelperProgress) => listener(event);
        ipcRenderer.on("ideHelper:progress", handler);
        return () => ipcRenderer.off("ideHelper:progress", handler);
    },

    laravelLsPrepare: () => ipcRenderer.invoke("laravelLs:prepare"),
    laravelLsStatus: () => ipcRenderer.invoke("laravelLs:status"),
    laravelLsRetry: () => ipcRenderer.invoke("laravelLs:retry"),
    laravelLsSkip: () => ipcRenderer.invoke("laravelLs:skip"),
    onLaravelLsProgress: (listener) => {
        const handler = (_e: IpcRendererEvent, progress: LaravelLsProgress) => listener(progress);
        ipcRenderer.on("laravelLs:progress", handler);
        return () => ipcRenderer.off("laravelLs:progress", handler);
    },
    onLaravelLsStatus: (listener) => {
        const handler = (_e: IpcRendererEvent, status: LaravelLsStatus) => listener(status);
        ipcRenderer.on("laravelLs:status", handler);
        return () => ipcRenderer.off("laravelLs:status", handler);
    },

    scratchWrite: (projectPath, tabId, content) => ipcRenderer.invoke("scratch:write", projectPath, tabId, content),
    scratchDelete: (projectPath, tabId) => ipcRenderer.invoke("scratch:delete", projectPath, tabId),

    phpVersions: () => ipcRenderer.invoke("php:versions"),

    phpAvailability: () => ipcRenderer.invoke("php:availability"),
    phpRescan: () => ipcRenderer.invoke("php:rescan"),
    onPhpAvailability: (listener) => {
        const handler = (_e: IpcRendererEvent, snapshot: PhpAvailability) => listener(snapshot);
        ipcRenderer.on("php:availabilityChanged", handler);
        return () => ipcRenderer.off("php:availabilityChanged", handler);
    },

    sqliteAvailability: () => ipcRenderer.invoke("sqlite:availability"),
    sqliteRescan: () => ipcRenderer.invoke("sqlite:rescan"),
    sqlitePickCliBinary: () => ipcRenderer.invoke("sqlite:pickCliBinary"),
    onSqliteAvailability: (listener) => {
        const handler = (_e: IpcRendererEvent, snapshot: SqliteAvailability) => listener(snapshot);
        ipcRenderer.on("sqlite:availabilityChanged", handler);
        return () => ipcRenderer.off("sqlite:availabilityChanged", handler);
    },

    skeletonsList: () => ipcRenderer.invoke("skeletons:list"),
    skeletonsSelect: (slug) => ipcRenderer.invoke("skeletons:select", slug),
    skeletonsRemove: (slug, deleteFolder) => ipcRenderer.invoke("skeletons:remove", slug, deleteFolder),
    skeletonsReprovision: (slug) => ipcRenderer.invoke("skeletons:reprovision", slug),
    onSkeletonStatus: (listener) => {
        const handler = (_e: IpcRendererEvent, event: SkeletonStatusEvent) => listener(event);
        ipcRenderer.on("skeletons:status", handler);
        return () => ipcRenderer.off("skeletons:status", handler);
    },
    onSkeletonProgress: (listener) => {
        const handler = (_e: IpcRendererEvent, event: SkeletonProvisionProgress) => listener(event);
        ipcRenderer.on("skeletons:progress", handler);
        return () => ipcRenderer.off("skeletons:progress", handler);
    },

    settingsGet: () => ipcRenderer.invoke("settings:get"),
    settingsSet: (patch) => ipcRenderer.invoke("settings:set", patch),
    settingsAddCustomPhp: (p) => ipcRenderer.invoke("settings:addCustomPhp", p),
    settingsRemoveCustomPhp: (p) => ipcRenderer.invoke("settings:removeCustomPhp", p),
    settingsPickPhpBinary: () => ipcRenderer.invoke("settings:pickPhpBinary"),
    onSettingsChanged: (listener) => {
        const handler = (_e: IpcRendererEvent, settings: Settings) => listener(settings);
        ipcRenderer.on("settings:changed", handler);
        return () => ipcRenderer.off("settings:changed", handler);
    },
    onSessionsReset: (listener: () => void) => {
        const handler = () => listener();
        ipcRenderer.on("sessions:reset", handler);
        return () => ipcRenderer.off("sessions:reset", handler);
    },

    databaseList: () => ipcRenderer.invoke("database:list"),
    databaseAdd: (input) => ipcRenderer.invoke("database:add", input),
    databaseUpdate: (input) => ipcRenderer.invoke("database:update", input),
    databaseRemove: (id) => ipcRenderer.invoke("database:remove", id),
    databaseTest: (input) => ipcRenderer.invoke("database:test", input),
    databasePickSqliteFile: () => ipcRenderer.invoke("database:pickSqliteFile"),

    openExternal: (url) => ipcRenderer.invoke("external:open", url),

    lspPaths: (phpVersion) => ipcRenderer.invoke("lsp:paths", phpVersion),
    lspClearCache: () => ipcRenderer.invoke("lsp:clearCache"),

    appInfo: () => ipcRenderer.invoke("app:info"),
    appDataDir: () => ipcRenderer.invoke("app:dataDir"),
    appRelaunch: () => ipcRenderer.invoke("app:relaunch"),

    aiListModels: (endpoint) => ipcRenderer.invoke("ai:listModels", endpoint),
    aiGenerate: (endpoint, requestId, body) => ipcRenderer.invoke("ai:generate", endpoint, requestId, body),
    aiAbort: (requestId) => ipcRenderer.invoke("ai:abort", requestId),

    snippetsList: () => ipcRenderer.invoke("snippets:list"),
    snippetsSave: (input) => ipcRenderer.invoke("snippets:save", input),
    snippetsDelete: (id) => ipcRenderer.invoke("snippets:delete", id),

    tabsLoad: () => ipcRenderer.invoke("tabs:load"),
    tabsSave: (payload) => ipcRenderer.invoke("tabs:save", payload),
};

contextBridge.exposeInMainWorld("lsp", bridge);

// Tiny read-only platform hint so the renderer can tailor copy (e.g.
// which OS credential vault a password gets encrypted into) without a
// round-trip IPC. Node's `process` object isn't in the renderer's
// sandboxed globals; only `process.platform` crosses here.
contextBridge.exposeInMainWorld("platform", process.platform);

// Dedicated LSP bridge — renderer-side monaco-languageclient talks to
// Intelephense through these two channels.
contextBridge.exposeInMainWorld("lspBridge", {
    send: (msg: unknown) => ipcRenderer.send("lsp:send", msg),
    // Awaited by the renderer before each `initialize` so a project switch
    // (which would otherwise leave the next initialize racing into a dead
    // pipe) can transparently kill + respawn the singleton Intelephense
    // process.
    ensureRunning: (): Promise<void> => ipcRenderer.invoke("lsp:ensureRunning"),
    onMessage: (cb: (msg: unknown) => void) => {
        const handler = (_e: IpcRendererEvent, msg: unknown) => cb(msg);
        ipcRenderer.on("lsp:message", handler);
        return () => ipcRenderer.off("lsp:message", handler);
    },
    // Fires when main detects the Intelephense child exited (crash, OOM,
    // external kill). Lets the renderer fail in-flight requests fast
    // instead of waiting out every per-method timeout.
    onDisconnected: (cb: () => void) => {
        const handler = () => cb();
        ipcRenderer.on("lsp:disconnected", handler);
        return () => ipcRenderer.off("lsp:disconnected", handler);
    },
});

// laravel-ls speaks the same LSP wire protocol over its own channel pair.
// Deliberately separate from `lspBridge` so renderer-side clients don't
// have to multiplex on a single stream — each client owns its own bridge.
contextBridge.exposeInMainWorld("laravelLsBridge", {
    send: (msg: unknown) => ipcRenderer.send("laravelLs:send", msg),
    // Awaited by the renderer before each `initialize` so a project switch
    // (which kills the previous server via shutdown+exit) can transparently
    // respawn the singleton.
    ensureRunning: (): Promise<void> => ipcRenderer.invoke("laravelLs:ensureRunning"),
    onMessage: (cb: (msg: unknown) => void) => {
        const handler = (_e: IpcRendererEvent, msg: unknown) => cb(msg);
        ipcRenderer.on("laravelLs:message", handler);
        return () => ipcRenderer.off("laravelLs:message", handler);
    },
    onDisconnected: (cb: () => void) => {
        const handler = () => cb();
        ipcRenderer.on("laravelLs:disconnected", handler);
        return () => ipcRenderer.off("laravelLs:disconnected", handler);
    },
});

contextBridge.exposeInMainWorld("shortcuts", {
    onRun: (cb: () => void) => {
        const handler = () => cb();
        ipcRenderer.on("run-shortcut", handler);
        return () => ipcRenderer.off("run-shortcut", handler);
    },
    onCancel: (cb: () => void) => {
        const handler = () => cb();
        ipcRenderer.on("cancel-shortcut", handler);
        return () => ipcRenderer.off("cancel-shortcut", handler);
    },
    onSettings: (cb: () => void) => {
        const handler = () => cb();
        ipcRenderer.on("settings-shortcut", handler);
        return () => ipcRenderer.off("settings-shortcut", handler);
    },
});
