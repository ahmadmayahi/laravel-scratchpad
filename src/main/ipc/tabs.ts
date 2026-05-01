import { ipcMain } from "electron";
import type { PersistedTabs } from "../../shared/ipc.js";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";

export function registerTabsIpc(ctx: MainContext): void {
    ipcMain.handle(CH.tabsLoad, () => ctx.tabsStore.load());
    ipcMain.handle(CH.tabsSave, (_e, payload: PersistedTabs) => ctx.tabsStore.save(payload));
}
