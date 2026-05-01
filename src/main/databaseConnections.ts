import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseConnection, DatabaseDriver, DatabaseTestResult } from "../shared/ipc.js";

const execFileP = promisify(execFile);

/**
 * Helpers for the user-managed database connections feature. The IPC
 * layer ([./ipc/database.ts](./ipc/database.ts)) and the runner
 * ([./ipc/runner.ts](./ipc/runner.ts)) both consume these — keep them
 * pure (no `ipcMain` references) so they're trivially testable.
 *
 * Why every helper here matters for correctness:
 *
 *   • `buildConnectionEnv` always emits the FULL `DB_*` set with explicit
 *     values, never blanks. The bundled skeletons' `.env` files have lines
 *     like `DB_PORT=` which phpdotenv loads as defined-but-empty —
 *     `env('DB_PORT', '3306')` returns `''` in that case (the default
 *     never fires). Inject every key explicitly and the OS env wins via
 *     phpdotenv's `ImmutableWriter`.
 *
 *   • `clearLaravelConfigCache` defends against `php artisan config:cache`.
 *     A cached config bypasses both `.env` AND env vars (Laravel reads it
 *     wholesale before LoadEnvironmentVariables runs).
 *
 *   • `probePhpExtension` runs at session start, NOT seed time — the user
 *     can swap PHP per-project, and a probe against a different binary
 *     would be irrelevant. Cached per-binary for the process lifetime.
 *
 *   • `ensureSqliteFileSafe` doesn't pre-create the file — that's PDO's
 *     job. We just `mkdir -p` the parent and refuse if the path is a
 *     directory; otherwise PDO would silently create an empty file at a
 *     typo'd path.
 */

/** Per-driver TCP port defaults. Used when seeding form values + as a
 *  defence-in-depth fallback in `buildConnectionEnv`. */
export const DRIVER_DEFAULT_PORT: Record<DatabaseDriver, number | null> = {
    sqlite: null,
    mysql: 3306,
    pgsql: 5432,
};

/**
 * Build the full set of `DB_*` env vars to inject when spawning a
 * worker for a bundled skeleton. Every key is present and explicit —
 * NEVER fall through to a blank value, because phpdotenv loads the
 * skeleton's `.env` blanks as defined-but-empty and `env(KEY, default)`
 * won't fall back.
 *
 * `DB_URL` is set to "" to neutralize any user-edited `DB_URL` line
 * (Laravel 11+ checks it first — would silently override our injection).
 */
export function buildConnectionEnv(conn: DatabaseConnection, plaintextSecret: string | null): Record<string, string> {
    const env: Record<string, string> = {
        DB_CONNECTION: conn.driver,
        DB_HOST: "",
        DB_PORT: "",
        DB_DATABASE: conn.database,
        DB_USERNAME: "",
        DB_PASSWORD: "",
        DB_URL: "",
    };
    if (conn.driver === "mysql" || conn.driver === "pgsql") {
        env.DB_HOST = conn.host ?? "";
        // Defence-in-depth: settings.ts's add/update validates that the
        // form persists an explicit port, but if a stale connection
        // somehow lacks one, fall back to the driver default rather
        // than emitting an empty value (which would lose to the
        // skeleton's `.env` empty-default trap).
        const port = conn.port ?? DRIVER_DEFAULT_PORT[conn.driver];
        env.DB_PORT = port != null ? String(port) : "";
        env.DB_USERNAME = conn.username ?? "";
        env.DB_PASSWORD = plaintextSecret ?? "";
    }
    return env;
}

/**
 * At session start, when the active connection is sqlite: ensure the
 * parent directory exists, refuse if the path resolves to a directory,
 * and let PDO handle the rest. Don't pre-create the file — PDO will,
 * and creating a zero-byte file at a typo'd path would mask the user's
 * mistake.
 */
export function ensureSqliteFileSafe(filePath: string): void {
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            throw new Error(`SQLite database path is a directory: ${filePath}`);
        }
        return;
    } catch (err) {
        // ENOENT is the only recoverable case — fall through to mkdir.
        // Anything else (EACCES, ELOOP, our directory-error above) re-throws.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Defensively remove Laravel's bootstrap caches before injecting env
 * overrides. `bootstrap/cache/config.php` short-circuits
 * `LoadEnvironmentVariables::bootstrap()` AND replaces the entire
 * config tree — a cached `database.default = sqlite` would beat both
 * our env vars and the skeleton's `.env`.
 *
 * Best-effort + idempotent. Skeletons don't ship with caches, but the
 * user might have run `php artisan config:cache` from a terminal. Also
 * clears `services.php` (provider container manifest) and the cached
 * route lists so a rebuilt config that swaps providers / routes lands
 * cleanly on the next boot.
 */
export function clearLaravelConfigCache(projectPath: string): void {
    const cacheDir = path.join(projectPath, "bootstrap", "cache");
    if (!fs.existsSync(cacheDir)) return;
    let entries: string[];
    try {
        entries = fs.readdirSync(cacheDir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry === "config.php" || entry === "services.php" || entry === "packages.php") {
            tryUnlink(path.join(cacheDir, entry));
            continue;
        }
        if (entry.startsWith("routes-") && entry.endsWith(".php")) {
            tryUnlink(path.join(cacheDir, entry));
        }
    }
}

function tryUnlink(p: string): void {
    try {
        fs.unlinkSync(p);
    } catch {
        /* best-effort */
    }
}

/**
 * Process-lifetime cache for `extension_loaded()` probes. Keyed by
 * `${binary}:${extension}` so swapping PHP doesn't reuse a stale answer
 * (different PHPs ship different extension sets). Cleared only by
 * process restart — extensions don't get added to a binary at runtime.
 */
const extensionCache = new Map<string, boolean>();

/**
 * Spawn `php -r 'echo extension_loaded("X") ? "1" : "0";'` against the
 * given binary and cache the result. Used at session start to fail fast
 * with a useful error when the user's selected PHP can't speak the
 * active connection's driver.
 */
export async function probePhpExtension(phpBinary: string, extension: string): Promise<boolean> {
    const key = `${phpBinary}:${extension}`;
    const cached = extensionCache.get(key);
    if (cached !== undefined) return cached;
    try {
        const { stdout } = await execFileP(
            phpBinary,
            ["-r", `echo extension_loaded(${JSON.stringify(extension)}) ? "1" : "0";`],
            { timeout: 3000 },
        );
        const ok = stdout.trim() === "1";
        extensionCache.set(key, ok);
        return ok;
    } catch {
        // Probe failures (binary missing, segfault) — treat as "not
        // available". Caller surfaces the same error as a normal
        // missing-extension case.
        extensionCache.set(key, false);
        return false;
    }
}

/** PHP extension required to drive each PDO database backend. */
export function pdoExtensionFor(driver: DatabaseDriver): string {
    switch (driver) {
        case "sqlite":
            return "pdo_sqlite";
        case "mysql":
            return "pdo_mysql";
        case "pgsql":
            return "pdo_pgsql";
    }
}

/**
 * Build the PDO DSN string for a connection. Mirrors what Laravel's
 * `config/database.php` constructs so the test result correlates with
 * what the worker will actually do at run time.
 */
function buildDsn(conn: DatabaseConnection): string {
    switch (conn.driver) {
        case "sqlite":
            return `sqlite:${conn.database}`;
        case "mysql": {
            const port = conn.port ?? DRIVER_DEFAULT_PORT.mysql ?? 3306;
            return `mysql:host=${conn.host ?? ""};port=${port};dbname=${conn.database};charset=utf8mb4`;
        }
        case "pgsql": {
            const port = conn.port ?? DRIVER_DEFAULT_PORT.pgsql ?? 5432;
            return `pgsql:host=${conn.host ?? ""};port=${port};dbname=${conn.database}`;
        }
    }
}

/**
 * Spawn a tiny PHP probe that does `new PDO(...)` and reports either
 * the server version or the PDOException message. Uses the user's
 * active PHP binary so the probe surfaces the same extension /
 * connectivity issues the real worker would hit.
 *
 * Output contract from the PHP one-liner is one line of JSON:
 *   {"ok":true,"version":"8.0.36"}   |   {"ok":false,"error":"..."}
 */
export async function testConnection(
    conn: DatabaseConnection,
    plaintextSecret: string | null,
    phpBinary: string,
): Promise<DatabaseTestResult> {
    const ext = pdoExtensionFor(conn.driver);
    const hasExt = await probePhpExtension(phpBinary, ext);
    if (!hasExt) {
        return {
            ok: false,
            error: `PHP at ${phpBinary} does not have the ${ext} extension enabled.`,
        };
    }

    if (conn.driver === "sqlite") {
        // Surface a clear error before PDO touches the path: a directory
        // would silently fail in a confusing way ("unable to open
        // database file"). Don't `mkdir -p` here — the test should be
        // read-only.
        try {
            const stat = fs.statSync(conn.database);
            if (stat.isDirectory()) {
                return { ok: false, error: `Database path is a directory: ${conn.database}` };
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                return { ok: false, error: (err as Error).message };
            }
            // Missing file is fine — PDO will create it on connect; the
            // probe verifies the path is reachable, not that it exists.
        }
    }

    const dsn = buildDsn(conn);
    const username = conn.driver === "sqlite" ? null : (conn.username ?? "");
    const password = conn.driver === "sqlite" ? null : (plaintextSecret ?? "");

    // Build the args via `PDO_DSN`, `PDO_USER`, `PDO_PASS` env vars so
    // we never have to escape user input into a PHP source string. The
    // -r snippet reads them with `getenv()`.
    const probe = `
$dsn = getenv('PDO_DSN');
$user = getenv('PDO_USER');
$pass = getenv('PDO_PASS');
$user = $user === false ? null : $user;
$pass = $pass === false ? null : $pass;
try {
    $pdo = new PDO($dsn, $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
    $version = null;
    try { $version = (string) $pdo->getAttribute(PDO::ATTR_SERVER_VERSION); } catch (Throwable $e) { /* not all drivers */ }
    echo json_encode(['ok' => true, 'version' => $version]);
} catch (Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`.trim();

    try {
        const { stdout } = await execFileP(phpBinary, ["-r", probe], {
            timeout: 10_000,
            env: {
                PATH: process.env.PATH,
                PDO_DSN: dsn,
                PDO_USER: username ?? "",
                PDO_PASS: password ?? "",
            },
        });
        const line = stdout.trim();
        if (!line) return { ok: false, error: "Probe returned no output" };
        const parsed = JSON.parse(line) as { ok: boolean; error?: string; version?: string | null };
        if (parsed.ok) {
            return { ok: true, serverVersion: parsed.version ?? undefined };
        }
        return { ok: false, error: parsed.error ?? "Unknown error" };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}
