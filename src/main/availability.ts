import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { PhpAvailability, SqliteAvailability } from "../shared/ipc.js";
import { discoverPhpVersions } from "./phpVersions.js";
import { discoverSqliteCli } from "./sqliteCli.js";
import { probePhpExtension } from "./databaseConnections.js";
import type { SettingsStore } from "./settings.js";

/**
 * Cached PHP + SQLite availability snapshots, refreshed on boot and
 * whenever settings mutations could change them. The renderer reads
 * these via IPC and reacts to `change` events to swap the editor for
 * the no-PHP banner or update the Database tab's status section.
 *
 * Cheap to call `getPhp()` / `getSqlite()` synchronously — the cache
 * is updated by `refresh()` on demand. Callers that need a fresh probe
 * (the no-PHP banner's "Rescan" button) call the explicit refresh
 * methods rather than reading the snapshot.
 *
 * Events:
 *   • `phpChanged`     (PhpAvailability)
 *   • `sqliteChanged`  (SqliteAvailability)
 */
export class AvailabilityService extends EventEmitter {
    private readonly settings: SettingsStore;
    private php: PhpAvailability = { available: false, binaries: [] };
    private sqlite: SqliteAvailability = {
        pdoSqlite: { available: false, phpBinary: null },
        cli: { available: false, path: null, version: null },
    };

    constructor(settings: SettingsStore) {
        super();
        this.settings = settings;
    }

    getPhp(): PhpAvailability {
        return clone(this.php);
    }

    getSqlite(): SqliteAvailability {
        return clone(this.sqlite);
    }

    /** Refresh both caches. Called once at boot before the renderer mounts. */
    async refreshAll(): Promise<void> {
        await this.refreshPhp();
        await this.refreshSqlite();
    }

    /**
     * Re-discover PHP and emit `phpChanged` if the snapshot moved. After
     * this, also refresh SQLite — `pdo_sqlite` is probed against the
     * picked PHP, so a PHP change can flip the SQLite snapshot too.
     */
    async refreshPhp(): Promise<PhpAvailability> {
        const settings = this.settings.get();
        const binaries = await discoverPhpVersions(settings.php.customPaths);
        const next: PhpAvailability = {
            available: binaries.length > 0,
            binaries,
        };
        const changed = !shallowEqualPhp(this.php, next);
        this.php = next;
        if (changed) this.emit("phpChanged", clone(next));
        // PHP set changed → pdo_sqlite probe target may have changed too.
        await this.refreshSqlite();
        return clone(next);
    }

    /**
     * Re-probe pdo_sqlite (against the active default PHP) and the
     * `sqlite3` CLI (honouring the user's custom path override). Emits
     * `sqliteChanged` if anything moved.
     */
    async refreshSqlite(): Promise<SqliteAvailability> {
        const settings = this.settings.get();
        const phpBinary = pickProbePhp(settings.php.defaultBinary, this.php.binaries);
        const pdoSqlite = phpBinary ? await probePhpExtension(phpBinary, "pdo_sqlite") : false;
        const cli = await discoverSqliteCli(settings.database.sqlite.customCliPath);

        const next: SqliteAvailability = {
            pdoSqlite: { available: pdoSqlite, phpBinary },
            cli: cli
                ? { available: true, path: cli.path, version: cli.version }
                : { available: false, path: null, version: null },
        };
        const changed = !shallowEqualSqlite(this.sqlite, next);
        this.sqlite = next;
        if (changed) this.emit("sqliteChanged", clone(next));
        return clone(next);
    }
}

/**
 * Pick a PHP binary to probe pdo_sqlite against. Prefers the user's
 * explicit default; falls back to the first discovered binary so a
 * fresh install (no default set yet) still gets a meaningful probe.
 * Returns null only when no PHP is reachable at all — the renderer
 * should treat that as "PHP unavailable, pdo_sqlite irrelevant".
 */
function pickProbePhp(defaultBinary: string | null, binaries: PhpAvailability["binaries"]): string | null {
    if (defaultBinary && fs.existsSync(defaultBinary)) return defaultBinary;
    return binaries[0]?.path ?? null;
}

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

function shallowEqualPhp(a: PhpAvailability, b: PhpAvailability): boolean {
    if (a.available !== b.available) return false;
    if (a.binaries.length !== b.binaries.length) return false;
    for (let i = 0; i < a.binaries.length; i++) {
        const x = a.binaries[i]!;
        const y = b.binaries[i]!;
        if (x.path !== y.path || x.version !== y.version || x.source !== y.source) return false;
    }
    return true;
}

function shallowEqualSqlite(a: SqliteAvailability, b: SqliteAvailability): boolean {
    return (
        a.pdoSqlite.available === b.pdoSqlite.available &&
        a.pdoSqlite.phpBinary === b.pdoSqlite.phpBinary &&
        a.cli.available === b.cli.available &&
        a.cli.path === b.cli.path &&
        a.cli.version === b.cli.version
    );
}
