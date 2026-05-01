import { ipcMain } from "electron";
import * as ollama from "../ollama.js";
import { CH } from "../../shared/ipcChannels.js";

/**
 * AI (Ollama) — calls go through the main process (Electron's `net`
 * module) so the CORS check in the renderer doesn't block them.
 * Ollama's default allow-list rejects `file://` / `null` origins
 * that Electron renderers use.
 */
export function registerAiIpc(): void {
    ipcMain.handle(CH.aiListModels, (_e, endpoint: string) => ollama.listModels(endpoint));
    ipcMain.handle(CH.aiGenerate, (_e, endpoint: string, requestId: string, body: ollama.GenerateBody) =>
        ollama.generate(endpoint, requestId, body),
    );
    ipcMain.handle(CH.aiAbort, (_e, requestId: string) => ollama.abort(requestId));
}
