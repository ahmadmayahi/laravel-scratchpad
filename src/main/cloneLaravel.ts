import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readLaravelVersion } from "./laravelVersion.js";
import type { SkeletonSlug } from "../shared/ipc.js";

/**
 * Low-level Laravel-scaffold builder. Runs `composer create-project` at
 * a caller-supplied directory and forces the new project onto SQLite.
 * Used by the skeleton provisioner — no higher-level collision handling
 * or named-clone flow lives here anymore (that existed for the old
 * "Clone Laravel Project" dialog, now superseded by skeleton
 * provisioning from the Laravel settings tab).
 */

interface BuildResult {
    ok: boolean;
    version?: string;
    error?: string;
}

interface CloneCallbacks {
    onLine: (stream: "stdout" | "stderr", line: string) => void;
}

/**
 * Run `composer create-project laravel/laravel[:^N.0]` into
 * `targetDir` (which must NOT yet exist — composer refuses non-empty
 * destinations). Follows up with SQLite configuration when
 * `hasPdoSqlite` is true; otherwise comments out the `DB_*` lines so
 * the skeleton boots without a DB binding. Returns whatever version
 * composer resolved.
 */
export async function buildLaravelAt(
    targetDir: string,
    constraint: SkeletonSlug,
    callbacks: CloneCallbacks,
    options: { hasPdoSqlite: boolean; customDatabasePath?: string | null } = { hasPdoSqlite: true },
): Promise<BuildResult> {
    // Composer refuses a non-empty directory. Caller is expected to
    // have cleared the path already; assert loudly if they didn't so a
    // silent state divergence doesn't waste a 2-minute composer run.
    if (fs.existsSync(targetDir)) {
        return { ok: false, error: `buildLaravelAt: target exists: ${targetDir}` };
    }
    const parent = path.dirname(targetDir);
    fs.mkdirSync(parent, { recursive: true });

    // Composer: `create-project <package> [<directory> [<version>]]`.
    // Version is a 3rd positional arg — NOT a colon-suffix on the package
    // name. `--no-audit` + `--no-security-blocking` let older majors
    // install despite being flagged by Composer's security advisory feed
    // (Laravel 9.x in particular): this is a scratchpad for testing
    // across versions, not a production dependency.
    const args = ["create-project", "laravel/laravel", targetDir];
    const versionArg = versionArgFor(constraint);
    if (versionArg) args.push(versionArg);
    args.push("--prefer-dist", "--no-interaction", "--no-audit", "--no-security-blocking");

    callbacks.onLine("stdout", `> composer ${args.join(" ")}`);

    const exitCode = await new Promise<number | null>((resolve) => {
        const proc = spawn(composerCommand(), args, {
            cwd: parent,
            env: { ...process.env, COMPOSER_NO_INTERACTION: "1" },
        });
        proc.stdout.on("data", (chunk: Buffer) => emitLines(chunk, "stdout", callbacks.onLine));
        proc.stderr.on("data", (chunk: Buffer) => emitLines(chunk, "stderr", callbacks.onLine));
        proc.on("error", (err) => {
            callbacks.onLine("stderr", `composer spawn failed: ${err.message}`);
            resolve(-1);
        });
        proc.on("exit", (code) => resolve(code));
    });

    if (exitCode !== 0) {
        return {
            ok: false,
            error:
                exitCode === -1
                    ? "Composer is not installed, or failed to spawn. Install Composer and try again."
                    : `composer exited with code ${exitCode}`,
        };
    }

    try {
        if (options.hasPdoSqlite) {
            configureSqlite(targetDir, callbacks, options.customDatabasePath ?? null);
        } else {
            configureNoDatabase(targetDir, callbacks);
        }
    } catch (err) {
        callbacks.onLine("stderr", `database setup skipped: ${(err as Error).message}`);
    }

    const installedVersion = readLaravelVersion(targetDir);
    return { ok: true, version: installedVersion ?? undefined };
}

/**
 * Composer's Windows installer creates `composer.bat` on PATH; without
 * the `.bat` suffix, Node's `spawn` (no shell, no PATHEXT lookup) ENOENTs
 * out. macOS / Linux use the bare `composer` name.
 */
function composerCommand(): string {
    return process.platform === "win32" ? "composer.bat" : "composer";
}

function versionArgFor(constraint: SkeletonSlug): string | null {
    if (constraint === "latest") return null;
    // `12.x` → `^12.0`; `11.x` → `^11.0`; etc. Composer's caret
    // constraint lets minor patches float while pinning the major.
    const major = constraint.replace(/\.x$/, "");
    return `^${major}.0`;
}

/**
 * Point the scaffolded project at a SQLite file. Defaults to a fresh
 * `database/database.sqlite` inside the project; when `customDatabasePath`
 * is provided (Settings → Database override), points the .env at that
 * absolute path instead and does not touch the in-project file.
 *
 * Exported and idempotent — callers use it during fresh provisioning
 * AND during boot-time reconciliation (to repair `.env` files written
 * by older versions of this function that didn't quote paths
 * containing whitespace).
 */
export function configureSqlite(
    projectDir: string,
    callbacks: CloneCallbacks,
    customDatabasePath: string | null = null,
): void {
    let sqliteAbsPath: string;
    if (customDatabasePath) {
        sqliteAbsPath = customDatabasePath;
        const parent = path.dirname(sqliteAbsPath);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        if (!fs.existsSync(sqliteAbsPath)) {
            fs.writeFileSync(sqliteAbsPath, "");
            callbacks.onLine("stdout", `> created custom sqlite file: ${sqliteAbsPath}`);
        }
    } else {
        const dbDir = path.join(projectDir, "database");
        sqliteAbsPath = path.join(dbDir, "database.sqlite");
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        if (!fs.existsSync(sqliteAbsPath)) {
            fs.writeFileSync(sqliteAbsPath, "");
            callbacks.onLine("stdout", "> created database/database.sqlite");
        }
    }

    const envPath = path.join(projectDir, ".env");
    if (fs.existsSync(envPath)) {
        const original = fs.readFileSync(envPath, "utf8");
        const patched = patchEnvForSqlite(original, sqliteAbsPath);
        if (patched !== original) {
            fs.writeFileSync(envPath, patched, "utf8");
            callbacks.onLine("stdout", "> patched .env → DB_CONNECTION=sqlite");
        }
    }
}

/**
 * Skeleton fallback when PHP lacks `pdo_sqlite`. Comments out every
 * `DB_*` line in `.env` so phpdotenv doesn't try to bind a database;
 * the default Laravel skeleton boots fine without one as long as
 * features that actually touch the DB aren't exercised. Idempotent —
 * lines already commented out pass through unchanged.
 *
 * NOT a destructive rewrite: we leave the values in place behind the
 * `#` so the user can flip them back on later (after installing
 * pdo_sqlite, for instance) without re-provisioning the skeleton.
 */
export function configureNoDatabase(projectDir: string, callbacks: CloneCallbacks): void {
    const envPath = path.join(projectDir, ".env");
    if (!fs.existsSync(envPath)) return;
    const original = fs.readFileSync(envPath, "utf8");
    const patched = original
        .split(/\r?\n/)
        .map((line) => {
            // Match active (uncommented) DB_* lines only.
            const m = line.match(/^(\s*)(DB_[A-Z_]+)\s*=(.*)$/);
            if (!m) return line;
            // Already commented? Leave it.
            return `${m[1]}# ${m[2]}=${m[3]}`;
        })
        .join("\n");
    if (patched !== original) {
        fs.writeFileSync(envPath, patched, "utf8");
        callbacks.onLine("stdout", "> patched .env → DB_* commented out (no pdo_sqlite available)");
    }
}

/**
 * Rewrite the DB_* lines of an env file for SQLite. Works on both the
 * `DB_CONNECTION=mysql` (Laravel 9-10) and `# DB_*` commented
 * (Laravel 11+) styles. Non-DB lines and unrelated keys (APP_KEY,
 * MAIL_*, etc.) pass through untouched.
 */
function patchEnvForSqlite(env: string, sqliteAbsPath: string): string {
    const values: Record<string, string> = {
        DB_CONNECTION: "sqlite",
        DB_HOST: "",
        DB_PORT: "",
        DB_DATABASE: sqliteAbsPath,
        DB_USERNAME: "",
        DB_PASSWORD: "",
    };
    const seen = new Set<string>();

    const lines = env.split(/\r?\n/).map((line) => {
        const m = line.match(/^(\s*#?\s*)(DB_[A-Z_]+)\s*=(.*)$/);
        if (!m) return line;
        const key = m[2]!;
        const value = values[key];
        if (value === undefined) return line;
        seen.add(key);
        return `${key}=${dotenvEscape(value)}`;
    });

    for (const [key, value] of Object.entries(values)) {
        if (seen.has(key)) continue;
        if (key === "DB_CONNECTION") lines.unshift(`${key}=${dotenvEscape(value)}`);
        else lines.push(`${key}=${dotenvEscape(value)}`);
    }

    return lines.join("\n");
}

/**
 * phpdotenv (what Laravel uses) refuses unquoted values that contain
 * whitespace, quotes, `#`, or backslashes — any of those forces double-
 * quoting plus `\` / `"` escaping inside the quotes. macOS users hit
 * this immediately: the scratchpad's app-support dir is `Laravel
 * ScratchPad` (space between the words), so the absolute sqlite path
 * always trips the whitespace rule on that platform.
 */
function dotenvEscape(value: string): string {
    if (value === "") return "";
    if (!/[\s"'#\\]/.test(value)) return value;
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Buffer-to-line splitter that emits complete lines to `cb`. Composer
 * chatters on both stdout and stderr — we don't care which; callers
 * display both in one log.
 */
function emitLines(chunk: Buffer, stream: "stdout" | "stderr", cb: CloneCallbacks["onLine"]): void {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.length === 0) continue;
        cb(stream, line);
    }
}

/**
 * Run `php artisan migrate --force` inside the scaffolded project so the
 * default migrations land — otherwise the sqlite file we touched in
 * {@link configureSqlite} stays schema-less and `User::find(1)`-style
 * queries fail with "no such table: users" the first time a user pokes
 * at the scratchpad. Every Laravel major since 9 ships the same
 * users/password-reset/session/cache/jobs baseline; we migrate
 * unconditionally so a scratchpad against any version gets a usable
 * default schema.
 *
 * `--force` is required because Laravel refuses to migrate in the
 * `production` default-env without it — but this is a local scaffold
 * and we're in control of the env, so the confirmation prompt is just
 * friction. Non-zero exits are soft-failed (logged + returned) so
 * provisioning still marks the skeleton ready: ide-helper + code
 * exploration work without migrations, and the user can run
 * `php artisan migrate` themselves if the automatic step failed.
 */
export async function migrateScaffold(
    projectDir: string,
    phpBinary: string,
    callbacks: CloneCallbacks,
): Promise<{ ok: boolean; error?: string }> {
    callbacks.onLine("stdout", "> php artisan migrate --force");
    return await new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(phpBinary, ["artisan", "migrate", "--force", "--no-interaction"], { cwd: projectDir });
        } catch (err) {
            resolve({ ok: false, error: (err as Error).message });
            return;
        }
        proc.stdout.on("data", (chunk: Buffer) => emitLines(chunk, "stdout", callbacks.onLine));
        proc.stderr.on("data", (chunk: Buffer) => emitLines(chunk, "stderr", callbacks.onLine));
        proc.on("error", (err) => resolve({ ok: false, error: err.message }));
        proc.on("exit", (code) => {
            if (code === 0) resolve({ ok: true });
            else resolve({ ok: false, error: `artisan migrate exited with code ${code}` });
        });
    });
}
