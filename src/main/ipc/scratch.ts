import { ipcMain } from "electron";
import path from "node:path";
import { deleteScratchFile, scratchFileUri, writeScratchFile } from "../scratchFiles.js";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";

/**
 * Scratch file materialisation — writes the renderer's in-memory
 * scratch buffer to disk so laravel-ls (which reads from the
 * filesystem on didOpen) can see it. The returned URI is what the
 * renderer uses for didOpen / didChange — keeping the disk path and
 * LSP URI in lockstep.
 *
 * `projectPath` is renderer-supplied; a malicious or bugged renderer
 * must not be able to direct the write at an arbitrary filesystem
 * location. Accept only paths that match a currently-registered
 * local project (or a ready bundled skeleton) — anything else is
 * rejected.
 */
export function registerScratchIpc(ctx: MainContext): void {
    function assertKnownLocalProjectPath(projectPath: string): string {
        if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
            throw new Error("Invalid project path");
        }
        const normalized = path.resolve(projectPath);
        const registered = ctx.projects
            .all()
            .filter((p) => p.kind === "laravel")
            .map((p) => path.resolve(p.projectPath));
        const skeletonPaths = ctx.skeletonsStore
            .list()
            .filter((s) => s.status === "ready")
            .map((s) => path.resolve(s.folderPath));
        const knownPath = [...registered, ...skeletonPaths].find((p) => p === normalized);
        if (!knownPath) {
            throw new Error("Unknown project path");
        }
        return knownPath;
    }

    ipcMain.handle(CH.scratchWrite, (_e, projectPath: string, tabId: string, content: string) => {
        if (typeof content !== "string") throw new Error("Invalid scratch content");
        const safeProjectPath = assertKnownLocalProjectPath(projectPath);
        writeScratchFile(safeProjectPath, tabId, content);
        return scratchFileUri(safeProjectPath, tabId);
    });

    ipcMain.handle(CH.scratchDelete, (_e, projectPath: string, tabId: string) => {
        const safeProjectPath = assertKnownLocalProjectPath(projectPath);
        deleteScratchFile(safeProjectPath, tabId);
    });
}
