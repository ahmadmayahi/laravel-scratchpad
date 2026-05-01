import { app, BrowserWindow, Menu } from "electron";
import { CH } from "../shared/ipcChannels.js";

export interface MenuDeps {
    isDev: boolean;
    getMainWindow(): BrowserWindow | null;
    onCheckForUpdates(): void;
}

export function setupMenu(deps: MenuDeps): void {
    const appName = app.getName();
    const template: Electron.MenuItemConstructorOptions[] = [
        // Replace the default `{ role: "appMenu" }` so we can slot in
        // a "Check for Updates…" item and move "Settings…" up here
        // where macOS users expect it (per HIG, Settings belongs in
        // the App menu — not a per-feature menu like "Run").
        {
            label: appName,
            submenu: [
                { role: "about", label: `About ${appName}` },
                {
                    label: "Check for Updates…",
                    click: () => {
                        deps.onCheckForUpdates();
                    },
                },
                { type: "separator" },
                {
                    label: "Settings…",
                    accelerator: "CmdOrCtrl+,",
                    click: () => deps.getMainWindow()?.webContents.send(CH.settingsShortcut),
                },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide", label: `Hide ${appName}` },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit", label: `Quit ${appName}` },
            ],
        },
        { role: "fileMenu" },
        { role: "editMenu" },
        // Custom View menu — the stock `{ role: "viewMenu" }` bundles
        // Reload / Force Reload / Toggle Developer Tools, which are
        // developer conveniences that shouldn't ship to end users (a
        // reload mid-session loses tab state and the devtools reveal
        // internal IPC structure). Only append them in dev.
        {
            label: "View",
            submenu: [
                ...(deps.isDev
                    ? [
                          { role: "reload" as const },
                          { role: "forceReload" as const },
                          { role: "toggleDevTools" as const },
                          { type: "separator" as const },
                      ]
                    : []),
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        { role: "windowMenu" },
        {
            label: "Run",
            submenu: [
                {
                    label: "Run",
                    accelerator: "CmdOrCtrl+R",
                    click: () => deps.getMainWindow()?.webContents.send(CH.runShortcut),
                },
                {
                    label: "Cancel",
                    accelerator: "CmdOrCtrl+.",
                    click: () => deps.getMainWindow()?.webContents.send(CH.cancelShortcut),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
