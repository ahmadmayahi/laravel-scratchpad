/**
 * Single source of truth for IPC channel names. Both `src/preload/preload.ts`
 * and the per-domain modules under `src/main/ipc/` import from here so a
 * channel rename or typo fails at build time instead of silently dropping
 * messages at runtime.
 *
 * The shape mirrors the keys on `LspBridge` (in `./ipc.ts`) where it can,
 * with a handful of one-way push channels (frame, *:progress, *:status,
 * *:message, *-shortcut) that only the main process emits.
 */
export const CH = {
    // --- runner -----------------------------------------------------------
    runnerStart: "runner:start",
    runnerExec: "runner:exec",
    runnerCancel: "runner:cancel",
    /** Streaming output frames: stdout / dump / result / error / cancelled. */
    frame: "frame",
    /** Sent when the worker pool is dropped (settings change, project edit). */
    sessionsReset: "sessions:reset",

    // --- projects ---------------------------------------------------------
    projectsList: "projects:list",
    projectsRemove: "projects:remove",
    projectsPickLaravel: "projects:pickLaravel",
    projectsPickSshKey: "projects:pickSshKey",
    projectsAddSsh: "projects:addSsh",
    projectsTestSsh: "projects:testSsh",
    projectsSetIdeHelperDeclined: "projects:setIdeHelperDeclined",
    /** Main → renderer: ask the user for an SSH password / key passphrase. */
    projectsSecretPrompt: "projects:secretPrompt",
    /** Renderer → main: the answer to a secretPrompt (or null on cancel). */
    projectsSecretPromptRespond: "projects:secretPromptRespond",

    // --- ide-helper -------------------------------------------------------
    ideHelperInstall: "ideHelper:install",
    ideHelperProgress: "ideHelper:progress",

    // --- laravel-ls -------------------------------------------------------
    laravelLsPrepare: "laravelLs:prepare",
    laravelLsStatus: "laravelLs:status",
    laravelLsRetry: "laravelLs:retry",
    laravelLsSkip: "laravelLs:skip",
    laravelLsEnsureRunning: "laravelLs:ensureRunning",
    laravelLsProgress: "laravelLs:progress",
    laravelLsSend: "laravelLs:send",
    laravelLsMessage: "laravelLs:message",
    laravelLsDisconnected: "laravelLs:disconnected",

    // --- scratch (laravel-ls scratch-file proxy) -------------------------
    scratchWrite: "scratch:write",
    scratchDelete: "scratch:delete",

    // --- skeletons --------------------------------------------------------
    skeletonsList: "skeletons:list",
    skeletonsSelect: "skeletons:select",
    skeletonsRemove: "skeletons:remove",
    skeletonsReprovision: "skeletons:reprovision",
    skeletonsStatus: "skeletons:status",
    /** Push event: per-line composer/migrate output during provisioning,
     *  throttled. Drives the splash's skeleton-step detail label. */
    skeletonsProgress: "skeletons:progress",

    // --- settings ---------------------------------------------------------
    settingsGet: "settings:get",
    settingsSet: "settings:set",
    settingsAddCustomPhp: "settings:addCustomPhp",
    settingsRemoveCustomPhp: "settings:removeCustomPhp",
    settingsPickPhpBinary: "settings:pickPhpBinary",
    settingsChanged: "settings:changed",

    // --- php discovery ----------------------------------------------------
    phpVersions: "php:versions",
    /** Get current PHP availability snapshot (cached on the main side). */
    phpAvailability: "php:availability",
    /** Force a fresh discovery and emit `phpAvailabilityChanged`. */
    phpRescan: "php:rescan",
    /** Push event: PHP availability changed (boot, settings mutation, rescan). */
    phpAvailabilityChanged: "php:availabilityChanged",

    // --- sqlite availability ---------------------------------------------
    sqliteAvailability: "sqlite:availability",
    sqliteRescan: "sqlite:rescan",
    sqlitePickCliBinary: "sqlite:pickCliBinary",
    sqliteAvailabilityChanged: "sqlite:availabilityChanged",

    // --- database connections --------------------------------------------
    databaseList: "database:list",
    databaseAdd: "database:add",
    databaseUpdate: "database:update",
    databaseRemove: "database:remove",
    databaseTest: "database:test",
    databasePickSqliteFile: "database:pickSqliteFile",

    // --- intelephense LSP -------------------------------------------------
    lspPaths: "lsp:paths",
    lspClearCache: "lsp:clearCache",
    lspEnsureRunning: "lsp:ensureRunning",
    lspSend: "lsp:send",
    lspMessage: "lsp:message",
    lspDisconnected: "lsp:disconnected",

    // --- app shell --------------------------------------------------------
    appInfo: "app:info",
    appDataDir: "app:dataDir",
    appRelaunch: "app:relaunch",
    externalOpen: "external:open",

    // --- ai (Ollama) ------------------------------------------------------
    aiListModels: "ai:listModels",
    aiGenerate: "ai:generate",
    aiAbort: "ai:abort",

    // --- snippets ---------------------------------------------------------
    snippetsList: "snippets:list",
    snippetsSave: "snippets:save",
    snippetsDelete: "snippets:delete",

    // --- tabs persistence -------------------------------------------------
    tabsLoad: "tabs:load",
    tabsSave: "tabs:save",

    // --- menu shortcuts (main → renderer) --------------------------------
    runShortcut: "run-shortcut",
    cancelShortcut: "cancel-shortcut",
    settingsShortcut: "settings-shortcut",
} as const;

export type IpcChannel = (typeof CH)[keyof typeof CH];
