import { app, dialog } from "electron";
// Named import directly — `electron-updater` is a CJS package and our
// tsconfig.main is CJS output, so `import pkg from 'electron-updater'`
// + `const { autoUpdater } = pkg` yields `undefined` at runtime (the
// module's `default` export isn't present under CJS interop).
import { autoUpdater } from "electron-updater";

/**
 * Auto-update — electron-updater against the GitHub releases for this
 * repo.
 *
 * Flow on a manual "Check for Updates…" click:
 *   checkForUpdates()              → Looking up latest release…
 *     update-available             → prompt: "Download X.Y.Z?"  → downloadUpdate()
 *       download-progress          → progress dialog (or silent on first pass)
 *       update-downloaded          → prompt: "Install and restart?" → quitAndInstall()
 *     update-not-available         → "Up to date" dialog
 *     error                        → error dialog
 *
 * Background check on launch uses the same pipeline minus the "up to
 * date" confirmation — so offline boots don't pop a dialog in the
 * user's face.
 *
 * NOTE: macOS requires the app to be signed + notarised for updates
 * to actually apply. Without that, `quitAndInstall` will fail with
 * "Could not get code signature for running application." We log the
 * failure but don't crash — users can still download manually via
 * the opened dialog.
 */

export interface Updater {
    check(userInitiated: boolean): Promise<void>;
}

export function installAutoUpdater(): Updater {
    autoUpdater.autoDownload = false; // Ask the user before downloading.
    autoUpdater.autoInstallOnAppQuit = true; // Once downloaded, apply on next quit.

    // State flags so menu clicks don't stack overlapping checks.
    let updateCheckInFlight = false;
    let currentCheckIsUserInitiated = false;

    autoUpdater.on("update-available", async (info) => {
        const inFlightUserInitiated = currentCheckIsUserInitiated;
        const { response } = await dialog.showMessageBox({
            type: "info",
            title: "Update available",
            message: `${app.getName()} ${info.version} is available.`,
            detail: `You're running ${app.getVersion()}. Download and install now?`,
            buttons: ["Download", "Later"],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0) {
            autoUpdater.downloadUpdate().catch((err) => {
                if (inFlightUserInitiated) {
                    dialog.showErrorBox("Download failed", String(err?.message ?? err));
                } else {
                    console.warn("[updater] download failed:", err);
                }
            });
        }
    });

    autoUpdater.on("update-not-available", () => {
        if (currentCheckIsUserInitiated) {
            dialog
                .showMessageBox({
                    type: "info",
                    title: "Up to date",
                    message: `${app.getName()} ${app.getVersion()} is the latest version.`,
                    buttons: ["OK"],
                    defaultId: 0,
                })
                .catch(() => {
                    /* dialog errors are non-fatal */
                });
        }
    });

    autoUpdater.on("update-downloaded", async (info) => {
        const { response } = await dialog.showMessageBox({
            type: "info",
            title: "Update ready",
            message: `${app.getName()} ${info.version} has been downloaded.`,
            detail: "Restart now to finish installing?",
            buttons: ["Restart", "Later"],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0) {
            // `quitAndInstall` terminates the app and swaps the
            // bundle. `autoInstallOnAppQuit = true` covers the "Later"
            // path so the install still runs when they next close the
            // app normally.
            autoUpdater.quitAndInstall();
        }
    });

    autoUpdater.on("error", (err) => {
        if (currentCheckIsUserInitiated) {
            dialog.showErrorBox("Update error", String(err?.message ?? err));
        } else {
            console.warn("[updater] error:", err);
        }
    });

    return {
        async check(userInitiated: boolean): Promise<void> {
            if (updateCheckInFlight) return;
            updateCheckInFlight = true;
            currentCheckIsUserInitiated = userInitiated;
            try {
                await autoUpdater.checkForUpdates();
            } catch (err) {
                if (userInitiated) {
                    dialog.showErrorBox("Couldn't check for updates", String((err as Error)?.message ?? err));
                } else {
                    console.warn("[updater] check failed:", err);
                }
            } finally {
                updateCheckInFlight = false;
            }
        },
    };
}
