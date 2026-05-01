import { dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { CH } from "../../shared/ipcChannels.js";
import { homeDir } from "../paths.js";
import type { MainContext } from "./context.js";

/**
 * IPC for the {@link AvailabilityService}. Two snapshots live in main —
 * PHP and SQLite — and the renderer subscribes to change events to gate
 * Monaco mounting (no-PHP banner) and to render the Database tab's
 * status section.
 *
 * The service emits on its own EventEmitter; this module just forwards
 * those events to the renderer's main window. Push-only direction —
 * the renderer never mutates the cache directly. Mutations come from
 * settings changes (handled in `settings.ts` IPC, which calls into
 * `availability.refreshPhp()`) or explicit rescan requests.
 */
export function registerAvailabilityIpc(ctx: MainContext): void {
    ctx.availability.on("phpChanged", (snapshot) => {
        ctx.getMainWindow()?.webContents.send(CH.phpAvailabilityChanged, snapshot);
    });
    ctx.availability.on("sqliteChanged", (snapshot) => {
        ctx.getMainWindow()?.webContents.send(CH.sqliteAvailabilityChanged, snapshot);
    });

    ipcMain.handle(CH.phpAvailability, () => ctx.availability.getPhp());
    ipcMain.handle(CH.phpRescan, () => ctx.availability.refreshPhp());

    ipcMain.handle(CH.sqliteAvailability, () => ctx.availability.getSqlite());
    ipcMain.handle(CH.sqliteRescan, () => ctx.availability.refreshSqlite());

    ipcMain.handle(CH.sqlitePickCliBinary, async () => {
        // Default the picker at a directory the user is likely to find
        // a sqlite3 binary in — mirrors the heuristic in `settingsPickPhpBinary`.
        const guess = (() => {
            if (process.platform === "darwin") {
                return fs.existsSync("/opt/homebrew/bin") ? "/opt/homebrew/bin" : "/usr/local/bin";
            }
            if (process.platform === "win32") {
                const localAppData = process.env["LOCALAPPDATA"] ?? path.join(homeDir(), "AppData\\Local");
                return path.join(localAppData, "Programs");
            }
            return "/usr/bin";
        })();
        const defaultPath = fs.existsSync(guess) ? guess : homeDir();
        const filters =
            process.platform === "win32"
                ? [
                      { name: "Executables", extensions: ["exe"] },
                      { name: "All files", extensions: ["*"] },
                  ]
                : [{ name: "All files", extensions: ["*"] }];
        const res = await dialog.showOpenDialog({
            properties: ["openFile"],
            message: "Choose the sqlite3 CLI binary",
            defaultPath,
            filters,
        });
        if (res.canceled || !res.filePaths[0]) return null;
        return res.filePaths[0];
    });
}
