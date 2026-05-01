import { app, ipcMain, shell } from "electron";
import { appDataDir } from "../paths.js";
import { CH } from "../../shared/ipcChannels.js";

/**
 * External URL allowlist — we only open URLs the app has a legitimate
 * reason to hand to the OS: web links (About page credits, GitHub
 * repo) and mailto. Without this filter, any renderer flaw could
 * coerce the main process into spawning arbitrary URL handlers.
 */
const ALLOWED_EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

export function registerAppIpc(): void {
    ipcMain.handle(CH.externalOpen, (_e, url: string) => {
        let protocol: string;
        try {
            protocol = new URL(url).protocol;
        } catch {
            return; // unparseable — drop
        }
        if (!ALLOWED_EXTERNAL_SCHEMES.has(protocol)) return;
        return shell.openExternal(url);
    });

    // App metadata (About page).
    ipcMain.handle(CH.appInfo, () => ({
        name: "Laravel ScratchPad",
        version: app.getVersion(),
        author: "Ahmad Mayahi",
        homepage: "https://github.com/ahmadmayahi/laravel-scratchpad",
        license: "MIT",
    }));

    // Per-user app data dir, surfaced so the Settings UI can show the
    // user where their config / cache actually live. Resolves per-OS
    // via Electron (macOS Application Support, Windows AppData, Linux
    // ~/.config).
    ipcMain.handle(CH.appDataDir, () => appDataDir());

    // Relaunch ourselves cleanly. Used by the "Clear cache" flow in
    // Settings — Intelephense keeps its full index in memory and never
    // re-reads from storage after init, so cache-clearing without a
    // process bounce only half-works. `app.exit()` skips `before-quit`
    // / `will-quit` handlers that `app.quit()` respects; paired with
    // `app.relaunch()` it gives a prompt, deterministic restart. Delay
    // the exit by one tick so the renderer's IPC reply lands before
    // the process goes away.
    ipcMain.handle(CH.appRelaunch, () => {
        app.relaunch();
        setTimeout(() => app.exit(0), 50);
    });
}
