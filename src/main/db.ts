import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Snippet } from "../shared/ipc.js";
import { appDataDir } from "./paths.js";

/**
 * Returns a shared `scratchpad.sqlite` connection opened in WAL mode under
 * the per-user app data dir. `SnippetsStore` takes this in its constructor
 * so the process runs with a single SQLite handle — leaving room for future
 * stores to share the same connection.
 */
export function openDatabase(): Database.Database {
    const dir = appDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "scratchpad.sqlite");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    // Older installs had a `history` table that we no longer write to.
    // One-shot cleanup so the file isn't carrying a dead table forever.
    db.exec("DROP TABLE IF EXISTS history");
    return db;
}

/**
 * User-saved snippet library. Names are not unique — users might want two
 * "send email" variants. `save()` doubles as create + update: if an `id` is
 * provided it updates; otherwise it inserts a fresh row.
 */
export class SnippetsStore {
    constructor(private readonly db: Database.Database) {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                code TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS snippets_name ON snippets(name);
            CREATE INDEX IF NOT EXISTS snippets_updated ON snippets(updated_at DESC);
        `);
    }

    list(): Snippet[] {
        const rows = this.db
            .prepare(
                `
            SELECT id, name, code, created_at, updated_at
            FROM snippets
            ORDER BY updated_at DESC
        `,
            )
            .all() as Array<Record<string, unknown>>;
        return rows.map(rowToSnippet);
    }

    save(input: { id?: string; name: string; code: string }): Snippet {
        const now = Date.now() / 1000;
        if (input.id) {
            this.db
                .prepare(
                    `
                UPDATE snippets SET name = ?, code = ?, updated_at = ?
                WHERE id = ?
            `,
                )
                .run(input.name, input.code, now, input.id);
            return this.byId(input.id) ?? this.insert(input, now);
        }
        return this.insert(input, now);
    }

    delete(id: string): void {
        this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id);
    }

    private insert(input: { name: string; code: string }, now: number): Snippet {
        const id = randomUUID();
        this.db
            .prepare(
                `
            INSERT INTO snippets (id, name, code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `,
            )
            .run(id, input.name, input.code, now, now);
        return { id, name: input.name, code: input.code, createdAt: now, updatedAt: now };
    }

    private byId(id: string): Snippet | null {
        const row = this.db
            .prepare(
                `
            SELECT id, name, code, created_at, updated_at
            FROM snippets WHERE id = ?
        `,
            )
            .get(id) as Record<string, unknown> | undefined;
        return row ? rowToSnippet(row) : null;
    }
}

function rowToSnippet(r: Record<string, unknown>): Snippet {
    return {
        id: String(r.id),
        name: String(r.name),
        code: String(r.code),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
    };
}
