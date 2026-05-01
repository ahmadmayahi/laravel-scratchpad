import fs from "node:fs";
import { ipcMain } from "electron";
import type { Project } from "../../shared/ipc.js";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";
import { buildLaravelBootstrap, workerScriptContent, workerScriptPath } from "../runner.js";
import {
    buildConnectionEnv,
    clearLaravelConfigCache,
    ensureSqliteFileSafe,
    pdoExtensionFor,
    probePhpExtension,
} from "../databaseConnections.js";

const DB_SECRET_KEY_PREFIX = "db:";

export function registerRunnerIpc(ctx: MainContext): void {
    ipcMain.handle(
        CH.runnerStart,
        async (
            _event,
            projectId: string,
            overrides?: { phpBinary?: string | null; databaseConnectionId?: string | null },
        ) => {
            const proj = ctx.resolveProjectById(projectId);
            if (!proj) throw new Error(`Unknown project: ${projectId}`);

            if (proj.kind === "ssh") {
                if (!proj.ssh) throw new Error("SSH project is missing its connection config");
                // `resolveSshSecret` dispatches by strategy — may read the vault
                // (keychain), prompt the renderer (prompt), spawn a shell command
                // (command), or return null (agent / unencrypted key / none).
                // Plaintext only lives on this stack frame.
                const secret = await ctx.resolveSshSecret(proj);
                const session = await ctx.runner.startSsh({
                    ssh: proj.ssh,
                    remotePath: proj.projectPath,
                    workerContent: workerScriptContent(),
                    bootstrapContent: buildLaravelBootstrap(proj.projectPath),
                    secret: secret ?? undefined,
                });
                return { sessionId: session.id, phpVersion: session.phpVersion };
            }

            // Local Laravel project — pick a local PHP and spawn worker.php.
            // The renderer-supplied `phpBinary` override (per-tab) wins over
            // the global default; falls back to the project-aware
            // `choosePhpFor` resolution when null/missing.
            const php = await resolveTabPhp(ctx, proj, overrides?.phpBinary);
            const localCtx = ctx.buildLocalContextFor(proj);

            // Database connection override — applies ONLY to bundled
            // skeletons. Local user projects keep using their own `.env`.
            // The injected env vars beat the skeleton's `.env` via phpdotenv's
            // ImmutableWriter (verified end-to-end during planning).
            const extraEnvPostScrub = await buildSkeletonDbEnv(ctx, proj, php, overrides?.databaseConnectionId);

            const session = await ctx.runner.start({
                phpBinary: php,
                workerPath: workerScriptPath(),
                bootstrapPath: localCtx.bootstrapPath,
                cwd: localCtx.cwd,
                extraEnvPostScrub,
            });
            return { sessionId: session.id, phpVersion: session.phpVersion };
        },
    );

    ipcMain.handle(CH.runnerExec, (_event, sessionId: string, code: string) => {
        const session = ctx.runner.session(sessionId);
        if (!session) throw new Error(`Unknown session: ${sessionId}`);
        const requestId = session.exec(code);
        return { requestId };
    });

    ipcMain.handle(CH.runnerCancel, (_event, sessionId: string) => {
        ctx.runner.session(sessionId)?.cancel();
    });
}

/**
 * Resolve the PHP binary to spawn for this run. Per-tab override wins
 * if it points at an existing file; otherwise we fall through to the
 * project-aware resolver in [../phpSelection.ts](../phpSelection.ts)
 * (`choosePhpFor`), which honours `composer.json`'s `require.php`
 * constraint before falling back to the user's default.
 *
 * The fallback is important: if a tab's saved `phpBinary` was deleted
 * out from under us (uninstalled via brew, removed from custom paths),
 * we'd otherwise spawn against a missing binary and ENOENT — `fs.existsSync`
 * gates that.
 */
async function resolveTabPhp(
    ctx: MainContext,
    proj: Project,
    overrideBinary: string | null | undefined,
): Promise<string> {
    if (overrideBinary && fs.existsSync(overrideBinary)) return overrideBinary;
    return ctx.choosePhpFor(proj);
}

/**
 * Resolve the user-selected database connection into a `DB_*` env-var
 * map suitable for `Runner.start({ extraEnvPostScrub })`. Returns
 * `undefined` (the no-op case) when:
 *
 *   • the project isn't a bundled skeleton (local + SSH keep their
 *     own `.env`);
 *   • the tab hasn't picked a connection (`connectionId == null` —
 *     the default for new tabs and the user's explicit "use the
 *     project's .env" choice); or
 *   • the connection id no longer resolves (defensive — `database:remove`
 *     leaves stale references on tabs, which fall through to .env here).
 *
 * On the active path: probes the chosen PHP for the matching `pdo_*`
 * extension and throws (with a renderer-readable message) if missing,
 * decrypts the secret if needed, sanity-checks the SQLite path, and
 * defensively clears `bootstrap/cache/config.php` so a stale cached
 * config can't ghost the override.
 */
async function buildSkeletonDbEnv(
    ctx: MainContext,
    proj: Project,
    phpBinary: string,
    connectionId: string | null | undefined,
): Promise<NodeJS.ProcessEnv | undefined> {
    if (!proj.isBundled) return undefined;
    if (!connectionId) return undefined;

    const settings = ctx.settings.get();
    const conn = settings.database.connections.find((c) => c.id === connectionId);
    if (!conn) return undefined;

    const ext = pdoExtensionFor(conn.driver);
    const hasExt = await probePhpExtension(phpBinary, ext);
    if (!hasExt) {
        throw new Error(
            `PHP at ${phpBinary} does not have the ${ext} extension enabled. Pick a different PHP version (Settings → PHP) or change the active database connection.`,
        );
    }

    let secret: string | null = null;
    if (conn.driver === "mysql" || conn.driver === "pgsql") {
        secret = ctx.secrets.get(DB_SECRET_KEY_PREFIX + conn.id);
    }

    if (conn.driver === "sqlite") {
        ensureSqliteFileSafe(conn.database);
    }

    // Stale config cache would short-circuit LoadEnvironmentVariables
    // and bypass our injected env vars entirely. Best-effort + idempotent.
    clearLaravelConfigCache(proj.projectPath);

    return buildConnectionEnv(conn, secret);
}
