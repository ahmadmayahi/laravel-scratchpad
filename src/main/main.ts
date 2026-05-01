import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";

import { CH } from "../shared/ipcChannels.js";
import { Runner } from "./runner.js";
import { preloadScriptPath, rendererIndexHtml } from "./paths.js";
import { SnippetsStore, openDatabase } from "./db.js";
import { ProjectStore } from "./projects.js";
import { SettingsStore } from "./settings.js";
import { TabsStore } from "./tabs.js";
import { LspServer } from "./lsp.js";
import { LaravelLsManager, LaravelLsServer } from "./laravelLs.js";
import { SkeletonsStore, SkeletonProvisioner } from "./skeletons.js";
import { SecretStore } from "./secrets.js";

import { installWindowSecurity } from "./windowSecurity.js";
import { setupMenu } from "./menu.js";
import { installAutoUpdater } from "./updater.js";
import { createSecretResolver } from "./secretResolution.js";
import { createProjectResolver } from "./projectResolver.js";
import { buildLocalContextFor, choosePhpFor } from "./phpSelection.js";
import { AvailabilityService } from "./availability.js";

import type { MainContext } from "./ipc/context.js";
import { registerRunnerIpc } from "./ipc/runner.js";
import { registerProjectsIpc } from "./ipc/projects.js";
import { registerSkeletonsIpc } from "./ipc/skeletons.js";
import { registerSettingsIpc } from "./ipc/settings.js";
import { registerDatabaseIpc } from "./ipc/database.js";
import { registerLspIpc } from "./ipc/lsp.js";
import { registerLaravelLsIpc } from "./ipc/laravelLs.js";
import { registerAppIpc } from "./ipc/app.js";
import { registerSnippetsIpc } from "./ipc/snippets.js";
import { registerTabsIpc } from "./ipc/tabs.js";
import { registerAiIpc } from "./ipc/ai.js";
import { registerScratchIpc } from "./ipc/scratch.js";
import { registerAvailabilityIpc } from "./ipc/availability.js";

/**
 * Main process entry point. Constructs the singletons that back every
 * subsystem (PHP worker pool, SQLite stores, LSP servers), builds a
 * shared {@link MainContext}, and hands that context to each IPC
 * module to register its handlers. Lifecycle (window, menu,
 * auto-updater) is wired in `app.whenReady()` at the bottom.
 */

const isDev = !app.isPackaged;

// Surface async failures instead of letting the app limp along in a
// partially-broken state. In dev the stack hits the terminal; packaged
// users see a native dialog so they have something to file a bug with.
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    if (!isDev) {
        dialog.showErrorBox("Laravel ScratchPad — unexpected error", String(err?.stack ?? err?.message ?? err));
    }
});
process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
});

// Override the app name as early as possible — Electron builds the app
// menu ("About <Name>", "Hide <Name>", "Quit <Name>") from this value,
// and the default falls back to the lowercased `name` in package.json
// which would show "laravel-scratchpad" in dev mode.
// electron-builder's `productName` only takes effect in packaged
// builds.
app.setName("Laravel ScratchPad");

// Customize the native About panel (Apple menu → About Laravel
// ScratchPad) with the package metadata instead of Electron's
// defaults.
app.setAboutPanelOptions({
    applicationName: "Laravel ScratchPad",
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} Ahmad Mayahi https://mayahi.net`,
    authors: ["Ahmad Mayahi"],
    website: "https://github.com/ahmadmayahi/laravel-scratchpad",
    credits: "A PHP / Laravel REPL scratchpad.",
});

installWindowSecurity(isDev);

// --- Singletons -----------------------------------------------------------
const runner = new Runner();
const db = openDatabase();
const snippets = new SnippetsStore(db);
const skeletonsStore = new SkeletonsStore(db);
const skeletonProvisioner = new SkeletonProvisioner(skeletonsStore);
const tabsStore = new TabsStore();
const projects = new ProjectStore();
const settings = new SettingsStore();
const secrets = new SecretStore();
const lsp = new LspServer();
const laravelLsManager = new LaravelLsManager();
const availability = new AvailabilityService(settings);
// Allocated only after the manager reaches `ready` — constructing it
// pre-download would bind a null command and the first start() would
// just emit an error. The laravel-ls IPC module owns the lifecycle.
let laravelLs: LaravelLsServer | null = null;
let mainWindow: BrowserWindow | null = null;

const { resolveSshSecret, enrichSecretStored } = createSecretResolver({
    getMainWindow: () => mainWindow,
    secrets,
});

const resolveProjectById = createProjectResolver({ projects, skeletonsStore });

const ctx: MainContext = {
    getMainWindow: () => mainWindow,
    runner,
    snippets,
    skeletonsStore,
    skeletonProvisioner,
    tabsStore,
    projects,
    settings,
    secrets,
    lsp,
    laravelLsManager,
    availability,
    getLaravelLs: () => laravelLs,
    setLaravelLs: (ls) => {
        laravelLs = ls;
    },
    resolveProjectById,
    resolveSshSecret,
    enrichSecretStored,
    choosePhpFor: (proj) => choosePhpFor(proj, settings),
    buildLocalContextFor,
};

// --- IPC modules ----------------------------------------------------------
// Each module installs its own channel handlers and any required
// event listeners on the shared singletons above.
registerRunnerIpc(ctx);
registerProjectsIpc(ctx);
registerSkeletonsIpc(ctx);
registerSettingsIpc(ctx);
registerDatabaseIpc(ctx);
registerLspIpc(ctx);
registerLaravelLsIpc(ctx);
registerAppIpc();
registerSnippetsIpc(ctx);
registerTabsIpc(ctx);
registerAiIpc();
registerScratchIpc(ctx);
registerAvailabilityIpc(ctx);

const updater = installAutoUpdater();

async function createWindow(): Promise<void> {
    // Title-bar treatment per OS:
    //   • macOS — `hiddenInset` hides the title bar but keeps the
    //     traffic lights inset over our toolbar (the 84-px left
    //     padding in Toolbar.vue accounts for them).
    //   • Windows — `hidden` + `titleBarOverlay` paints the
    //     min/max/close controls over our toolbar in the platform's
    //     native style. Toolbar drag regions still work; the
    //     controls float on the right.
    //   • Linux — no consistent overlay support across DEs (GNOME,
    //     KDE, tiling WMs all differ), so we fall back to the OS
    //     frame. The toolbar sits below it; one extra row of chrome
    //     but guaranteed to work everywhere.
    const titleBarOptions: Partial<Electron.BrowserWindowConstructorOptions> = (() => {
        if (process.platform === "darwin") {
            return { titleBarStyle: "hiddenInset" };
        }
        if (process.platform === "win32") {
            return {
                titleBarStyle: "hidden",
                titleBarOverlay: {
                    color: "#1a1b1f",
                    symbolColor: "#e6e6e6",
                    height: 44,
                },
            };
        }
        return {}; // linux — keep the OS frame
    })();

    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 820,
        minHeight: 480,
        title: "Laravel ScratchPad",
        backgroundColor: "#1a1b1f",
        ...titleBarOptions,
        webPreferences: {
            preload: preloadScriptPath(),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    mainWindow = win;

    if (isDev) {
        await win.loadURL("http://127.0.0.1:5173/");
        // DevTools intentionally NOT auto-opened; toggle via menu if needed.
    } else {
        // Surface a missing renderer build with a real error instead of a
        // blank window. Happens if `npm run build:renderer` was skipped
        // before packaging or if the asar got partially corrupted.
        const indexPath = rendererIndexHtml();
        if (!fs.existsSync(indexPath)) {
            dialog.showErrorBox(
                "Laravel ScratchPad — renderer missing",
                `Could not find the renderer bundle at:\n${indexPath}\n\nReinstall the app or rebuild via 'npm run build'.`,
            );
            app.exit(1);
            return;
        }
        await win.loadFile(indexPath);
    }

    win.on("closed", () => {
        mainWindow = null;
    });
}

/**
 * Run cleanup before the process exits. Idempotent — `before-quit` and
 * `window-all-closed` can both fire (the order depends on whether the
 * user closed the last window or hit Cmd+Q with the window open), and
 * doubling up `runner.stopAll()` / `lsp.stop()` is wasted work.
 */
let cleaningUp = false;
async function shutdown(): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    await runner.stopAll();
    lsp.stop();
    laravelLs?.stop();
    laravelLs = null;
}

function routeFrames(): void {
    runner.on("frame", (frame) => {
        mainWindow?.webContents.send(CH.frame, frame);
    });
    // Worker stderr is intentionally not forwarded to the renderer
    // today — the `[laravel-bootstrap] partial-boot` warning goes to
    // main's console where devs can see it. If we ever surface it in
    // the UI, add an `onStderr` channel to the preload bridge and
    // plumb it through.
}

void app.whenReady().then(async () => {
    setupMenu({
        isDev,
        getMainWindow: () => mainWindow,
        onCheckForUpdates: () => {
            void updater.check(true);
        },
    });
    routeFrames();

    // Reconcile the skeletons table: rename legacy
    // `<appDataDir>/laravel-skeleton/` (old bundled-tarball path) into
    // `skeletons/latest/` for upgraders; insert the `latest` row if
    // missing; re-patch `.env` files for any skeleton whose sqlite
    // path wasn't dotenv-escaped by an older provisioner build.
    skeletonsStore.reconcile();

    // Bootstrap `latest`: if it's not ready, kick off provisioning in
    // the background. First launch on a new install spends a few
    // minutes here; the UI stays usable in the meantime. The
    // SkeletonProvisioner emits `progress` events that the
    // ipc/skeletons.ts handler subscribes to — those are throttled
    // and forwarded to the renderer, so this kick-off doesn't need to
    // wire anything itself.
    const latest = skeletonsStore.bySlug("latest");
    if (latest && latest.status !== "ready") {
        void skeletonProvisioner.provision("latest", {
            customPhpPaths: settings.get().php.customPaths,
            defaultPhpBinary: settings.get().php.defaultBinary,
            customDatabasePath: settings.get().database.sqlite.customDatabasePath,
        });
    }

    // Always discover PHP at boot so the renderer can gate Monaco on
    // availability — the cached snapshot lives in `availability` and
    // gets pushed to the renderer over IPC. The Settings IPC re-runs
    // this whenever `php.customPaths` / `php.defaultBinary` change so
    // user fixes (adding a custom path) reflect immediately.
    await availability.refreshAll();

    // First-run defaults for the PHP picker: tick every discovered binary
    // so the toolbar dropdown has at least one usable option out of the
    // box. Awaited *before* createWindow so the renderer never observes
    // the empty state. After the user touches the list, PhpTab enforces
    // "at least one stays enabled" so we never re-enter this branch.
    if (settings.get().php.enabledPaths.length === 0) {
        const discovered = availability.getPhp().binaries;
        if (discovered.length > 0) {
            settings.set({ php: { enabledPaths: discovered.map((v) => v.path) } });
        }
    }

    // Kick Intelephense up alongside the window. The renderer will
    // send the `initialize` request once it's ready. A 10 s timeout
    // surfaces a slow/hung server early instead of forcing the
    // renderer to wait out per-method `initialize` timeouts later.
    const LSP_BOOT_TIMEOUT_MS = 10_000;
    void Promise.race([
        lsp.start(),
        new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("Intelephense start timed out")), LSP_BOOT_TIMEOUT_MS),
        ),
    ]).catch((err) => console.error("[lsp] start failed", err));

    await createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });

    // Background update check on boot. Skipped in dev (electron-updater
    // self-disables when the app isn't packaged) and silent on failure,
    // so offline launches don't trigger a dialog before the window even
    // paints. User can still fire a manual check anytime from the menu.
    if (!isDev) {
        void updater.check(false);
    }
});

// Cmd+Q (or any explicit quit) — fires BEFORE `window-all-closed` and is
// the only path that runs reliably when a quit is initiated while the
// window is still open. Defer the actual exit until cleanup finishes so
// in-flight PHP / SSH / LSP children get torn down rather than orphaned.
app.on("before-quit", (e) => {
    if (cleaningUp) return;
    e.preventDefault();
    void shutdown().then(() => app.exit(0));
});

app.on("window-all-closed", () => {
    void shutdown().then(() => {
        if (process.platform !== "darwin") app.quit();
    });
});
