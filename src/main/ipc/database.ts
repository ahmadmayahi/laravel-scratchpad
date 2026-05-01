import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DatabaseConnection, DatabaseDriver } from "../../shared/ipc.js";
import { CH } from "../../shared/ipcChannels.js";
import { DRIVER_DEFAULT_PORT, testConnection } from "../databaseConnections.js";
import { discoverPhpVersions } from "../phpVersions.js";
import { homeDir } from "../paths.js";
import type { MainContext } from "./context.js";

/**
 * IPC layer for the user-managed Database connections feature. The
 * connection list lives inside `settings.json` (under
 * `settings.database.connections`); plaintext passwords live encrypted
 * in the OS keychain via the existing `SecretStore` under the
 * `db:<connectionId>` key. The renderer never touches the keychain
 * directly — every secret crossing the IPC boundary is one-way (writes
 * encrypt; reads happen at session start in [./runner.ts](./runner.ts),
 * never proxied back to the renderer).
 *
 * The settings-change listener in [./settings.ts](./settings.ts) already
 * tears worker sessions down when `settings.database` changes, so a
 * `database:add/update/remove` that flips the active id (or mutates the
 * active connection) results in a single `runner.stopAll()` + the
 * `sessions:reset` broadcast — no special teardown plumbing here.
 */

const VALID_DRIVERS: readonly DatabaseDriver[] = ["sqlite", "mysql", "pgsql"];

const SECRET_KEY_PREFIX = "db:";

/**
 * Load the user's preferred PHP binary for testing — defaults to the
 * explicit `defaultBinary`, falls back to the first discovered binary.
 * Returns null if no PHP is reachable; callers surface that as a clear
 * test failure ("no PHP binary configured").
 */
async function pickProbePhpBinary(ctx: MainContext): Promise<string | null> {
    const settings = ctx.settings.get();
    if (settings.php.defaultBinary && fs.existsSync(settings.php.defaultBinary)) {
        return settings.php.defaultBinary;
    }
    const all = await discoverPhpVersions(settings.php.customPaths);
    return all[0]?.path ?? null;
}

interface ConnectionInput {
    name: string;
    driver: DatabaseDriver;
    database: string;
    host?: string;
    port?: number;
    username?: string;
}

/**
 * Validate a connection payload from the renderer. Throws with a
 * user-readable message — the IPC layer surfaces that into the
 * Add / Edit modal. Stricter than the TypeScript type because the
 * renderer might send empty strings rather than undefined for omitted
 * fields, and we want every persisted connection to satisfy
 * `buildConnectionEnv`'s "no blanks" rule.
 */
function validateConnection(input: ConnectionInput): void {
    if (!input.name || !input.name.trim()) throw new Error("Connection name is required");
    if (!VALID_DRIVERS.includes(input.driver)) throw new Error(`Unknown driver: ${input.driver}`);
    if (!input.database || !input.database.trim()) {
        throw new Error(input.driver === "sqlite" ? "SQLite file path is required" : "Database name is required");
    }
    if (input.driver === "mysql" || input.driver === "pgsql") {
        if (!input.host || !input.host.trim()) throw new Error("Host is required");
        const port = input.port;
        if (port == null || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("Port must be an integer between 1 and 65535");
        }
        // username can be empty (some Postgres setups use peer/ident
        // auth); leave validation to the actual connect attempt.
    }
}

/**
 * Normalise a payload into a stored shape — drops fields that don't
 * apply to the chosen driver so a SQLite connection never carries a
 * stale host from a previous mysql edit.
 */
function normaliseForStorage(input: ConnectionInput): Omit<DatabaseConnection, "id" | "secretStored"> {
    const out: Omit<DatabaseConnection, "id" | "secretStored"> = {
        name: input.name.trim(),
        driver: input.driver,
        database: input.database.trim(),
    };
    if (input.driver === "mysql" || input.driver === "pgsql") {
        out.host = (input.host ?? "").trim();
        out.port = input.port ?? DRIVER_DEFAULT_PORT[input.driver]!;
        out.username = (input.username ?? "").trim();
    }
    return out;
}

function enrichSecretStored(ctx: MainContext, conn: DatabaseConnection): DatabaseConnection {
    if (conn.driver === "sqlite") return conn;
    return { ...conn, secretStored: ctx.secrets.has(SECRET_KEY_PREFIX + conn.id) };
}

export function registerDatabaseIpc(ctx: MainContext): void {
    ipcMain.handle(CH.databaseList, () => {
        return ctx.settings.get().database.connections.map((c) => enrichSecretStored(ctx, c));
    });

    ipcMain.handle(CH.databaseAdd, (_event, input: { connection: ConnectionInput; secret?: string }) => {
        validateConnection(input.connection);
        const stored = normaliseForStorage(input.connection);

        // Refuse plaintext-on-disk: if a password came in but the OS
        // keychain isn't reachable (Linux without a keyring, fresh DPAPI
        // on a new Windows account), reject rather than silently dropping
        // the secret. Same shape as the SSH path's behaviour.
        const wantsSecret = (stored.driver === "mysql" || stored.driver === "pgsql") && !!input.secret;
        if (wantsSecret && !ctx.secrets.isAvailable()) {
            throw new Error(
                "OS credential storage unavailable — install gnome-keyring / kwallet (Linux) or sign into your account, then try again.",
            );
        }

        const conn: DatabaseConnection = { id: randomUUID(), ...stored };
        const next = [...ctx.settings.get().database.connections, conn];
        ctx.settings.set({ database: { connections: next } });
        if (wantsSecret) ctx.secrets.set(SECRET_KEY_PREFIX + conn.id, input.secret!);
        return enrichSecretStored(ctx, conn);
    });

    ipcMain.handle(
        CH.databaseUpdate,
        (
            _event,
            input: {
                id: string;
                patch: Partial<ConnectionInput>;
                secret?: string;
                clearSecret?: boolean;
            },
        ) => {
            const current = ctx.settings.get().database.connections;
            const existing = current.find((c) => c.id === input.id);
            if (!existing) throw new Error(`Unknown connection: ${input.id}`);

            // Reconstitute the full shape from existing + patch so
            // validateConnection sees the post-update state. Patch can
            // legally omit unchanged fields.
            const merged: ConnectionInput = {
                name: input.patch.name ?? existing.name,
                driver: input.patch.driver ?? existing.driver,
                database: input.patch.database ?? existing.database,
                host: input.patch.host ?? existing.host,
                port: input.patch.port ?? existing.port,
                username: input.patch.username ?? existing.username,
            };
            validateConnection(merged);

            // Reject plaintext-on-disk same as `database:add`. Note we
            // only need the keychain when the user is *setting* a new
            // secret — clearSecret + no-secret paths don't write.
            if (input.secret && !ctx.secrets.isAvailable()) {
                throw new Error(
                    "OS credential storage unavailable — install gnome-keyring / kwallet (Linux) or sign into your account, then try again.",
                );
            }

            const stored = normaliseForStorage(merged);
            const next: DatabaseConnection = {
                id: existing.id,
                ...stored,
            };
            const list = current.map((c) => (c.id === existing.id ? next : c));
            ctx.settings.set({ database: { connections: list } });

            // Secret handling AFTER settings.set so a settings-write
            // failure doesn't leave the keychain out of sync. Clear
            // wins over set if both are accidentally provided.
            const secretKey = SECRET_KEY_PREFIX + next.id;
            if (input.clearSecret) {
                ctx.secrets.remove(secretKey);
            } else if (input.secret) {
                ctx.secrets.set(secretKey, input.secret);
            }
            // Driver change can leave a stale secret around (sqlite has
            // no secret concept) — purge the keychain entry if the new
            // driver is sqlite to keep `secretStored` accurate.
            if (next.driver === "sqlite") ctx.secrets.remove(secretKey);

            return enrichSecretStored(ctx, next);
        },
    );

    ipcMain.handle(CH.databaseRemove, (_event, id: string) => {
        const settings = ctx.settings.get();
        const conn = settings.database.connections.find((c) => c.id === id);
        if (!conn) return; // already gone — idempotent

        // Tabs that picked this connection will resolve to "missing
        // connection → fall back to project .env" on next run; the
        // settings-change listener tears their sessions down so the
        // fallback kicks in immediately.
        const next = settings.database.connections.filter((c) => c.id !== id);
        ctx.settings.set({ database: { connections: next } });
        ctx.secrets.remove(SECRET_KEY_PREFIX + id);
    });

    ipcMain.handle(
        CH.databaseTest,
        async (
            _event,
            input: {
                id?: string;
                connection?: ConnectionInput;
                secret?: string;
            },
        ) => {
            // Resolve the connection: by-id (saved), or inline (unsaved
            // form). The Add modal posts inline payloads so the user can
            // probe before persisting.
            let conn: DatabaseConnection;
            let secret: string | null;
            if (input.id) {
                const found = ctx.settings.get().database.connections.find((c) => c.id === input.id);
                if (!found) return { ok: false, error: `Unknown connection: ${input.id}` };
                conn = found;
                // Secret precedence for tests: explicit field wins
                // (re-test after typing a new one) → keychain → none.
                secret = input.secret ?? ctx.secrets.get(SECRET_KEY_PREFIX + conn.id);
            } else if (input.connection) {
                validateConnection(input.connection);
                conn = { id: "test", ...normaliseForStorage(input.connection) };
                secret = input.secret ?? null;
            } else {
                return { ok: false, error: "No connection provided" };
            }

            const phpBinary = await pickProbePhpBinary(ctx);
            if (!phpBinary) {
                return { ok: false, error: "No PHP binary discovered. Install PHP or add one in Settings → PHP." };
            }
            return testConnection(conn, secret, phpBinary);
        },
    );

    ipcMain.handle(CH.databasePickSqliteFile, async () => {
        // Default the picker at the user's home — most users keep their
        // sqlite files under ~/Sites or ~/Documents; the app data dir
        // is too obscure for the unsaved-file dialog to land there.
        const res = await dialog.showOpenDialog({
            properties: ["openFile", "promptToCreate"],
            message: "Choose a SQLite database file",
            defaultPath: homeDir(),
            filters: [
                { name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] },
                { name: "All files", extensions: ["*"] },
            ],
        });
        if (res.canceled || !res.filePaths[0]) return null;
        return res.filePaths[0];
    });
}
