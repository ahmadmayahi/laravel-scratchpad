import { dialog, ipcMain } from "electron";
import fs from "node:fs";
import { discoverPhpVersions } from "../phpVersions.js";
import { homeDir } from "../paths.js";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";

export function registerSettingsIpc(ctx: MainContext): void {
    // When settings change, push a live copy to the renderer so the UI
    // can react (e.g. Monaco theme swap without restart). The PHP-pool
    // teardown is gated below so theme/font changes don't nuke
    // in-flight workers.
    let lastPhpConfig = JSON.stringify(ctx.settings.get().php);
    // Database settings reset triggers the same teardown — switching the
    // active connection (or editing the active connection's fields) needs
    // a fresh worker since `DB_*` env vars are baked in at spawn time.
    // We tear down ALL sessions, not just bundled ones, because the
    // selective version is more code than the simple-correct version is
    // worth — a non-skeleton session restart costs ~100 ms.
    let lastDbConfig = JSON.stringify(ctx.settings.get().database);
    ctx.settings.on("change", async (next) => {
        ctx.getMainWindow()?.webContents.send(CH.settingsChanged, next);
        const phpSnapshot = JSON.stringify(next.php);
        const dbSnapshot = JSON.stringify(next.database);
        const phpChanged = phpSnapshot !== lastPhpConfig;
        const dbChanged = dbSnapshot !== lastDbConfig;
        if (!phpChanged && !dbChanged) return;
        lastPhpConfig = phpSnapshot;
        lastDbConfig = dbSnapshot;
        // PHP-related settings (custom paths, default binary, enabled
        // paths) can flip availability — re-discover and let the
        // service emit a `phpChanged` event the renderer subscribes to.
        // SQLite-related settings (custom CLI path) also need a refresh
        // so the picker change shows up immediately.
        if (phpChanged) await ctx.availability.refreshPhp();
        else if (dbChanged) await ctx.availability.refreshSqlite();
        await ctx.runner.stopAll();
        ctx.getMainWindow()?.webContents.send(CH.sessionsReset);
    });

    ipcMain.handle(CH.settingsGet, () => ctx.settings.get());
    ipcMain.handle(CH.settingsSet, (_e, patch) => ctx.settings.set(patch));
    ipcMain.handle(CH.settingsAddCustomPhp, (_e, p: string) => ctx.settings.addCustomPhp(p));
    ipcMain.handle(CH.settingsRemoveCustomPhp, (_e, p: string) => ctx.settings.removeCustomPhp(p));

    ipcMain.handle(CH.settingsPickPhpBinary, async () => {
        // Default the picker at a directory the user is likely to find
        // a php binary in. macOS leans Homebrew, Windows leans XAMPP,
        // Linux leans /usr/bin. Falls back to the user's home if our
        // guess doesn't exist.
        const guess = (() => {
            if (process.platform === "darwin") {
                return fs.existsSync("/opt/homebrew/bin") ? "/opt/homebrew/bin" : "/usr/local/bin";
            }
            if (process.platform === "win32") {
                return "C:\\xampp\\php";
            }
            return "/usr/bin";
        })();
        const defaultPath = fs.existsSync(guess) ? guess : homeDir();
        const res = await dialog.showOpenDialog({
            properties: ["openFile"],
            message: "Choose a PHP CLI binary",
            defaultPath,
        });
        if (res.canceled || !res.filePaths[0]) return null;
        return res.filePaths[0];
    });

    ipcMain.handle(CH.phpVersions, () => discoverPhpVersions(ctx.settings.get().php.customPaths));
}
