import { ipcMain } from "electron";
import type { IdeHelperProgress, SkeletonProvisionProgress, SkeletonStatusEvent } from "../../shared/ipc.js";
import { CH } from "../../shared/ipcChannels.js";
import { isValidSkeletonSlug } from "../skeletons.js";
import { installIdeHelper } from "../ideHelper.js";
import type { MainContext } from "./context.js";

/**
 * Build a `ProvisionOptions` from the current settings — the
 * provisioner picks up the live snapshot of customPaths /
 * defaultBinary / sqlite override here, so a settings change between
 * calls is honoured.
 */
function buildProvisionOptions(ctx: MainContext) {
    return {
        customPhpPaths: ctx.settings.get().php.customPaths,
        defaultPhpBinary: ctx.settings.get().php.defaultBinary,
        customDatabasePath: ctx.settings.get().database.sqlite.customDatabasePath,
    };
}

export function registerSkeletonsIpc(ctx: MainContext): void {
    // Forward skeleton status changes to the renderer so the Laravel
    // settings tab reflects provisioning progress live.
    ctx.skeletonProvisioner.on("status", (event: SkeletonStatusEvent) => {
        ctx.getMainWindow()?.webContents.send(CH.skeletonsStatus, event);
    });

    // Throttle composer/migrate output → renderer to ~5 Hz. Composer
    // can spit several lines per second mid-install, which would
    // flood IPC and make the splash's detail label flicker faster
    // than the user can read it. Trailing-edge timer guarantees the
    // final line lands so the splash settles on a meaningful sub-label.
    let lastEmitAt = 0;
    let lastEvent: SkeletonProvisionProgress | null = null;
    let trailingTimer: NodeJS.Timeout | null = null;
    const flushProgress = () => {
        if (!lastEvent) return;
        lastEmitAt = Date.now();
        ctx.getMainWindow()?.webContents.send(CH.skeletonsProgress, lastEvent);
        lastEvent = null;
    };
    ctx.skeletonProvisioner.on("progress", (event: SkeletonProvisionProgress) => {
        lastEvent = event;
        const now = Date.now();
        if (now - lastEmitAt >= 200) {
            if (trailingTimer) {
                clearTimeout(trailingTimer);
                trailingTimer = null;
            }
            flushProgress();
        } else if (!trailingTimer) {
            trailingTimer = setTimeout(() => {
                trailingTimer = null;
                flushProgress();
            }, 200);
        }
    });

    // Every slug-bearing handler validates the slug against the fixed
    // whitelist BEFORE touching the filesystem. Without this, a crafted
    // IPC call (hostile renderer, supply-chain compromise) could push
    // `../../something` through and have `fs.rmSync` wipe unrelated
    // directories on the user's machine.
    ipcMain.handle(CH.skeletonsList, () => ctx.skeletonsStore.list());

    ipcMain.handle(CH.skeletonsSelect, async (_e, slug: unknown) => {
        if (!isValidSkeletonSlug(slug)) throw new Error(`Invalid skeleton slug: ${String(slug)}`);
        await ctx.skeletonProvisioner.provision(slug, buildProvisionOptions(ctx));
    });

    ipcMain.handle(CH.skeletonsRemove, async (_e, slug: unknown, deleteFolder: unknown) => {
        if (!isValidSkeletonSlug(slug)) throw new Error(`Invalid skeleton slug: ${String(slug)}`);
        const row = ctx.skeletonsStore.bySlug(slug);
        if (!row || row.isDefault) return;
        // Tear down any live sessions against this skeleton so the
        // renderer's cached sessionId doesn't point at a freshly-removed
        // project on the next Run.
        await ctx.runner.stopAll();
        ctx.getMainWindow()?.webContents.send(CH.sessionsReset);
        ctx.skeletonProvisioner.remove(slug, deleteFolder === true);
    });

    ipcMain.handle(CH.skeletonsReprovision, async (_e, slug: unknown) => {
        if (!isValidSkeletonSlug(slug)) throw new Error(`Invalid skeleton slug: ${String(slug)}`);
        await ctx.skeletonProvisioner.reprovision(slug, buildProvisionOptions(ctx));
    });

    // IDE helper install — runs composer require + artisan ide-helper
    // commands on a LOCAL Laravel project. Streams progress back as
    // "ideHelper:progress" events; resolves with `true` on success. SSH
    // projects reject — we don't remote-shell-exec composer on the
    // user's servers from here; they can install it manually on the
    // remote and the stubs will flow through the remote LSP index.
    ipcMain.handle(CH.ideHelperInstall, async (_e, projectId: string) => {
        const proj = ctx.resolveProjectById(projectId);
        if (!proj || proj.kind !== "laravel" || !proj.projectPath) return false;
        const phpBinary = await ctx.choosePhpFor(proj);
        const emit = (event: IdeHelperProgress): void => {
            ctx.getMainWindow()?.webContents.send(CH.ideHelperProgress, event);
        };
        const result = await installIdeHelper({
            projectPath: proj.projectPath,
            phpBinary,
            onLine: (stage, line) => emit({ projectId, stage, line }),
        });
        if (result.ok) emit({ projectId, stage: "done" });
        else emit({ projectId, stage: "error", message: result.error ?? "install failed" });
        return result.ok;
    });
}
