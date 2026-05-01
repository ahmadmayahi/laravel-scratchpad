import { dialog, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { MainContext } from "./context.js";
import type { NewSshProjectInput, TestSshInput } from "../../shared/ipc.js";
import { CH } from "../../shared/ipcChannels.js";
import { testSshConnection } from "../sshSession.js";
import { homeDir, sshDefaultDir } from "../paths.js";
import { SKELETON_ID_PREFIX, skeletonAsProject } from "../projectResolver.js";

export function registerProjectsIpc(ctx: MainContext): void {
    ipcMain.handle(CH.projectsList, () => {
        // Skeletons (ready only) come first so the renderer's grouping logic
        // can slice them off the top cleanly. Projects-tab-managed entries
        // (local + SSH) follow in their persisted order.
        const bundled = ctx.skeletonsStore
            .list()
            .filter((s) => s.status === "ready")
            .map(skeletonAsProject);
        const own = ctx.projects.all().map(ctx.enrichSecretStored);
        return [...bundled, ...own];
    });

    ipcMain.handle(CH.projectsRemove, async (_e, id: string) => {
        // Skeletons can't be removed via the project-tab list — they're
        // managed from the Laravel settings tab. Silent no-op here rather
        // than a throw so a stray double-click doesn't paint a red toast.
        if (id.startsWith(SKELETON_ID_PREFIX)) return;
        // Cascade-delete the stored secret so removing a project actually
        // removes everything associated with it — otherwise stale ciphertext
        // would pile up in the vault and any replay would succeed silently.
        ctx.projects.remove(id);
        ctx.secrets.remove(id);
        // Tear down any live worker sessions that were started from this
        // project. Previously they'd linger and the renderer's next Run
        // against a stale `sessionId` would fail with a cryptic "Unknown
        // session" instead of recognising the project is gone. The
        // `sessions:reset` event nudges the renderer to clear every tab's
        // cached sessionId so the next run starts fresh against the
        // currently-selected project.
        await ctx.runner.stopAll();
        ctx.getMainWindow()?.webContents.send(CH.sessionsReset);
    });

    ipcMain.handle(CH.projectsSetIdeHelperDeclined, (_e, id: string, declined: boolean) => {
        const updated = ctx.projects.setIdeHelperDeclined(id, declined);
        return updated ? ctx.enrichSecretStored(updated) : null;
    });

    ipcMain.handle(CH.projectsPickLaravel, async () => {
        const res = await dialog.showOpenDialog({
            properties: ["openDirectory"],
            message: "Select a Laravel project folder",
        });
        if (res.canceled || !res.filePaths[0]) return null;
        const p = res.filePaths[0];
        if (!fs.existsSync(path.join(p, "artisan")) || !fs.existsSync(path.join(p, "bootstrap/app.php"))) {
            dialog.showErrorBox("Not a Laravel project", "The folder must contain artisan and bootstrap/app.php.");
            return null;
        }
        return ctx.projects.addLocalLaravel({ name: path.basename(p), projectPath: p });
    });

    ipcMain.handle(CH.projectsPickSshKey, async () => {
        const sshDir = sshDefaultDir();
        const res = await dialog.showOpenDialog({
            properties: ["openFile"],
            message: "Select an SSH private key",
            defaultPath: fs.existsSync(sshDir) ? sshDir : homeDir(),
        });
        if (res.canceled || !res.filePaths[0]) return null;
        return res.filePaths[0];
    });

    // Add a remote Laravel project over SSH. Plaintext `secret` is handled
    // HERE, gated by the selected strategy — never touches projects.json.
    // A password-auth save that picks `keychain` but provides no secret is
    // refused (we'd persist an unusable record); `prompt` and `command`
    // strategies are always fine without a stack-local secret.
    ipcMain.handle(CH.projectsAddSsh, (_e, input: NewSshProjectInput) => {
        const strategy = input.ssh.secretStrategy ?? "keychain";
        const authNeedsSecret = input.ssh.authMode === "password" || input.ssh.authMode === "key";

        if (input.ssh.authMode === "password" && strategy === "none") {
            throw new Error("Password auth requires a secret strategy other than 'No password'.");
        }

        const shouldStoreInVault =
            authNeedsSecret && strategy === "keychain" && typeof input.secret === "string" && input.secret.length > 0;

        if (input.ssh.authMode === "password" && strategy === "keychain" && !shouldStoreInVault) {
            throw new Error("Password is required when 'Store in keychain' is selected.");
        }
        if (shouldStoreInVault && !ctx.secrets.isAvailable()) {
            throw new Error(
                "OS credential storage is unavailable. " +
                    (process.platform === "linux"
                        ? "Install and unlock a keyring (gnome-keyring / kwallet), then retry."
                        : "The keychain appears to be locked or disabled."),
            );
        }

        const saved = ctx.projects.addSsh(input);
        if (shouldStoreInVault) {
            ctx.secrets.set(saved.id, input.secret!);
        }
        return ctx.enrichSecretStored(saved);
    });

    // One-shot SSH probe — connect, check php, check path, report back.
    // Does not persist anything. Secret resolution mirrors Run:
    //   1. If the caller supplied a plaintext `secret`, use it (typical
    //      for Add-dialog "Test" where the field is right there).
    //   2. Otherwise, if the caller supplied a `projectId` for an existing
    //      project, resolve via the project's strategy (keychain / prompt).
    //      The prompt path shows the same modal as Run.
    ipcMain.handle(CH.projectsTestSsh, async (_e, input: TestSshInput) => {
        if (input.secret !== undefined && input.secret.length > 0) {
            return testSshConnection({
                ssh: input.ssh,
                projectPath: input.projectPath,
                secret: input.secret,
            });
        }
        if (input.projectId) {
            const proj = ctx.projects.byId(input.projectId);
            if (proj) {
                try {
                    const resolved = await ctx.resolveSshSecret(proj);
                    return testSshConnection({
                        ssh: input.ssh,
                        projectPath: input.projectPath,
                        secret: resolved ?? undefined,
                    });
                } catch (err) {
                    return { ok: false as const, error: (err as Error).message, stage: "auth" as const };
                }
            }
        }
        return testSshConnection({
            ssh: input.ssh,
            projectPath: input.projectPath,
        });
    });
}
