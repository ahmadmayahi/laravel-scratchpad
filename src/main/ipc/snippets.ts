import { ipcMain } from "electron";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";

export function registerSnippetsIpc(ctx: MainContext): void {
    ipcMain.handle(CH.snippetsList, () => ctx.snippets.list());
    ipcMain.handle(CH.snippetsSave, (_e, input: { id?: string; name: string; code: string }) =>
        ctx.snippets.save(input),
    );
    ipcMain.handle(CH.snippetsDelete, (_e, id: string) => ctx.snippets.delete(id));
}
