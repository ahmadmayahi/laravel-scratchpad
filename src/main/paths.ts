import { app } from "electron";
import path from "node:path";

/**
 * Single source of truth for filesystem paths resolved in the main
 * process. Centralising these (a) makes the set of places where we
 * reach into Electron's `app.getPath()` or relative `__dirname`
 * lookups grep-able, and (b) means a future move (sandbox container,
 * portable mode, OS-specific override) is a one-line change.
 *
 * `app.setName("Laravel ScratchPad")` runs early in main.ts so every
 * resolved userData path uses the friendly name on each platform.
 */

/**
 * Per-user app data directory.
 *
 *   macOS:   ~/Library/Application Support/Laravel ScratchPad
 *   Windows: %APPDATA%\Laravel ScratchPad
 *   Linux:   $XDG_CONFIG_HOME/Laravel ScratchPad   (or ~/.config/…)
 */
export function appDataDir(): string {
    return app.getPath("userData");
}

/** User's home directory — per-OS via Electron. */
export function homeDir(): string {
    return app.getPath("home");
}

/**
 * Default location the SSH key picker opens to. Returning just the
 * path (not a conditional fallback) — callers decide what to do if
 * `~/.ssh` doesn't exist.
 */
export function sshDefaultDir(): string {
    return path.join(homeDir(), ".ssh");
}

/**
 * Absolute path to the compiled preload bundle that Electron hands to
 * `BrowserWindow.webPreferences.preload`. Resolved relative to
 * `__dirname` because both dev and packaged builds emit `preload.js`
 * into a sibling folder of `main.js`.
 */
export function preloadScriptPath(): string {
    return path.join(__dirname, "../preload/preload.js");
}

/**
 * Packaged renderer entry. Dev mode loads from the Vite dev server
 * instead — callers gate on `app.isPackaged`.
 */
export function rendererIndexHtml(): string {
    return path.join(__dirname, "../renderer/index.html");
}

/**
 * Intelephense writes its workspace index to a storage dir under
 * `appDataDir`. The dir name is keyed by the PHP language version so
 * reconfiguring the selection always gets a fresh index
 * (Intelephense's on-disk cache doesn't re-parse files when the
 * `environment.phpVersion` setting changes). `safeVersion` comes from
 * `normalizeLspPhpVersion` — a fixed allowlist — so it's safe to
 * interpolate here.
 */
export function intelephenseStorageDirs(safeVersion: string): {
    storagePath: string;
    globalStoragePath: string;
} {
    const base = appDataDir();
    return {
        storagePath: path.join(base, `intelephense-v2-php${safeVersion}`),
        globalStoragePath: path.join(base, `intelephense-global-v2-php${safeVersion}`),
    };
}
