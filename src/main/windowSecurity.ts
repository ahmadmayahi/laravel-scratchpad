import { app, BrowserWindow, Menu } from "electron";

/**
 * Defense-in-depth: with contextIsolation + sandbox already on, a
 * renderer compromise still shouldn't be able to navigate our window
 * or spawn new ones. `setWindowOpenHandler` routes every
 * `window.open` / target=_blank into `shell.openExternal` via our
 * scheme allowlist (see the `external:open` IPC handler).
 * `will-navigate` blocks any attempt to point the main window at a
 * new URL after the initial load.
 *
 * Also wires a native right-click context menu. Electron only fires
 * `context-menu` when the page hasn't called `preventDefault()` on
 * the DOM's contextmenu event — Monaco stops propagation for its
 * own menu, so this only runs on plain renderer surfaces (dialogs,
 * labels, the status bar, inputs without a custom handler). Without
 * it, right-click does nothing and the app reads as "not a real Mac
 * app" the first time a user tries to copy an error message.
 */
export function installWindowSecurity(isDev: boolean): void {
    app.on("web-contents-created", (_event, contents) => {
        // Deny-all on `window.open` / `target=_blank`. The app's
        // legitimate "open URL externally" flow goes through the
        // `external:open` IPC handler which applies its own scheme
        // allowlist; renderer JS has no business spawning new windows
        // directly.
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        contents.on("will-navigate", (event, navigationUrl) => {
            const allowed = isDev
                ? navigationUrl.startsWith("http://127.0.0.1:5173/")
                : navigationUrl.startsWith("file://");
            if (!allowed) event.preventDefault();
        });

        contents.on("context-menu", (_e, params) => {
            const items: Electron.MenuItemConstructorOptions[] = [];
            if (params.isEditable) {
                items.push(
                    { role: "undo" },
                    { role: "redo" },
                    { type: "separator" },
                    { role: "cut", enabled: params.editFlags.canCut },
                    { role: "copy", enabled: params.editFlags.canCopy },
                    { role: "paste", enabled: params.editFlags.canPaste },
                    { type: "separator" },
                    { role: "selectAll" },
                );
            } else if (params.selectionText && params.selectionText.trim().length > 0) {
                items.push({ role: "copy" });
                if (process.platform === "darwin") {
                    // Native macOS "Look Up '<word>'" — system-provided
                    // dictionary / Wikipedia / etc. Only wired on
                    // macOS because `showDefinitionForSelection` is a
                    // no-op on other platforms.
                    items.push(
                        { type: "separator" },
                        {
                            label: `Look Up "${truncateForMenu(params.selectionText)}"`,
                            click: () => contents.showDefinitionForSelection(),
                        },
                    );
                }
            }
            if (items.length === 0) return;
            Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
        });
    });
}

function truncateForMenu(text: string): string {
    const trimmed = text.trim().replace(/\s+/g, " ");
    return trimmed.length > 24 ? trimmed.slice(0, 24) + "…" : trimmed;
}
