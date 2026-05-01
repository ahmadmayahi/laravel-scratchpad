import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { appDataDir } from "./paths.js";
import { buildLaravelAt, configureSqlite, migrateScaffold } from "./cloneLaravel.js";
import { installIdeHelper } from "./ideHelper.js";
import { discoverPhpVersions } from "./phpVersions.js";
import { probePhpExtension } from "./databaseConnections.js";
import { pickPhpForConstraint, readLaravelVersion, readRequiredPhp } from "./laravelVersion.js";
import { Skeleton, SKELETON_SLUGS, SkeletonSlug, SkeletonStatus, SkeletonStatusEvent } from "../shared/ipc.js";

/**
 * Runtime guard for IPC payloads. The `SkeletonSlug` TypeScript type is
 * compile-only; main-process handlers that accept a slug from the
 * renderer (or any cross-process source) MUST funnel through here
 * before the value reaches path-joining / `fs.rmSync` / database
 * lookups. A crafted slug like `../../Documents` would otherwise
 * escape `<appDataDir>/skeletons/` and let a compromised renderer
 * wipe arbitrary directories.
 */
export function isValidSkeletonSlug(v: unknown): v is SkeletonSlug {
    return typeof v === "string" && (SKELETON_SLUGS as readonly string[]).includes(v);
}

/**
 * Pre-provisioned Laravel skeletons, tracked in SQLite (shares the
 * `scratchpad.sqlite` handle opened in `db.ts`). One row per slug in
 * `SKELETON_SLUGS`; `latest` is bootstrapped on first launch and
 * can never be deleted.
 *
 * Folder layout on disk:
 *   <appDataDir>/skeletons/latest/
 *   <appDataDir>/skeletons/12.x/
 *   <appDataDir>/skeletons/11.x/
 *   …
 *
 * Provisioning work is handled by {@link SkeletonProvisioner}; the
 * store itself is a thin CRUD wrapper plus reconcile-at-boot logic.
 */
export class SkeletonsStore {
    private readonly db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS skeletons (
                slug              TEXT PRIMARY KEY,
                installed_version TEXT,
                folder_path       TEXT NOT NULL,
                status            TEXT NOT NULL,
                error             TEXT,
                is_default        INTEGER NOT NULL,
                created_at        REAL NOT NULL,
                updated_at        REAL NOT NULL
            );
        `);
    }

    static rootDir(): string {
        return path.join(appDataDir(), "skeletons");
    }
    static folderFor(slug: SkeletonSlug): string {
        return path.join(SkeletonsStore.rootDir(), slug);
    }

    list(): Skeleton[] {
        const rows = this.db
            .prepare(
                `
            SELECT slug, installed_version, folder_path, status, error,
                   is_default, created_at, updated_at
            FROM skeletons
        `,
            )
            .all() as Array<Record<string, unknown>>;
        // Sort in the canonical order the UI expects (latest, then
        // descending majors). Doing this in JS instead of SQL because the
        // slug ordering isn't lexicographic.
        const order = new Map(SKELETON_SLUGS.map((s, i) => [s, i]));
        return rows.map(rowToSkeleton).sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99));
    }

    bySlug(slug: SkeletonSlug): Skeleton | null {
        const row = this.db
            .prepare(
                `
            SELECT slug, installed_version, folder_path, status, error,
                   is_default, created_at, updated_at
            FROM skeletons WHERE slug = ?
        `,
            )
            .get(slug) as Record<string, unknown> | undefined;
        return row ? rowToSkeleton(row) : null;
    }

    /** Insert a new row. Throws if the slug already exists. */
    insert(slug: SkeletonSlug, status: SkeletonStatus = "provisioning"): Skeleton {
        const now = Date.now() / 1000;
        const folderPath = SkeletonsStore.folderFor(slug);
        this.db
            .prepare(
                `
            INSERT INTO skeletons (slug, folder_path, status, is_default,
                                   created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `,
            )
            .run(slug, folderPath, status, slug === "latest" ? 1 : 0, now, now);
        return this.bySlug(slug)!;
    }

    /**
     * Patch a subset of fields on the row. Convenience over ad-hoc
     * `UPDATE` statements scattered across the provisioner.
     */
    update(
        slug: SkeletonSlug,
        patch: Partial<Pick<Skeleton, "installedVersion" | "status" | "error">>,
    ): Skeleton | null {
        const existing = this.bySlug(slug);
        if (!existing) return null;
        const now = Date.now() / 1000;
        const next = { ...existing, ...patch };
        this.db
            .prepare(
                `
            UPDATE skeletons
               SET installed_version = ?, status = ?, error = ?, updated_at = ?
             WHERE slug = ?
        `,
            )
            .run(next.installedVersion ?? null, next.status, next.error ?? null, now, slug);
        return this.bySlug(slug);
    }

    delete(slug: SkeletonSlug): void {
        this.db.prepare("DELETE FROM skeletons WHERE slug = ?").run(slug);
    }

    /**
     * Called once during app launch. Handles:
     *   1. Migrating the pre-existing single-bundled-skeleton folder
     *      (`<appDataDir>/laravel-skeleton/`) into the new layout's
     *      `skeletons/latest/` on first run after the update.
     *   2. Ensuring the `latest` row always exists.
     *   3. Fixing drift: rows that claim `ready` but whose folder is
     *      missing are flipped to `failed`; `provisioning` rows left over
     *      from a crashed previous run are also flipped to `failed` so
     *      the UI can offer a retry.
     */
    reconcile(): void {
        fs.mkdirSync(SkeletonsStore.rootDir(), { recursive: true });

        // Migration: old bundled skeleton lived at <appDataDir>/laravel-
        // skeleton/. Move it into the new layout's `latest/` slot so the
        // user doesn't face a 5-minute reprovision the first time they
        // launch the new build.
        const legacy = path.join(appDataDir(), "laravel-skeleton");
        const latestFolder = SkeletonsStore.folderFor("latest");
        if (fs.existsSync(legacy) && !fs.existsSync(latestFolder)) {
            try {
                fs.renameSync(legacy, latestFolder);
            } catch {
                // Cross-device rename can fail — we accept the
                // reprovision cost in that case rather than deep-copy
                // 500 MB of vendor/ tree.
            }
        }

        // Fix up drift from prior crashes / external deletes.
        for (const s of this.list()) {
            if (s.status === "provisioning") {
                this.update(s.slug, {
                    status: "failed",
                    error: "Previous launch was interrupted before this skeleton finished provisioning.",
                });
                continue;
            }
            if (s.status !== "ready") continue;
            if (!fs.existsSync(path.join(s.folderPath, "artisan"))) {
                this.update(s.slug, {
                    status: "failed",
                    error: "Skeleton folder missing or incomplete on disk.",
                });
                continue;
            }
            // Re-run the idempotent SQLite setup — older releases of
            // `patchEnvForSqlite` didn't quote the sqlite path, so any
            // skeleton provisioned before that fix has a broken `.env`
            // on macOS (where the app-support dir has a space). Running
            // configureSqlite again writes the quoted form without
            // touching other env lines.
            try {
                configureSqlite(s.folderPath, {
                    onLine: () => {
                        /* quiet */
                    },
                });
            } catch {
                /* best-effort */
            }
        }

        // Ensure the default `latest` row exists. If the folder's
        // already there (migration above or fresh extraction by another
        // code path), mark it ready with the detected version.
        if (!this.bySlug("latest")) {
            this.insert("latest", fs.existsSync(path.join(latestFolder, "artisan")) ? "ready" : "provisioning");
            if (fs.existsSync(path.join(latestFolder, "artisan"))) {
                this.update("latest", { installedVersion: readLaravelVersion(latestFolder) });
            }
        }
    }
}

/**
 * Provisioning options that vary per call. Lifted out of the
 * positional argument list once the set grew past three (custom paths,
 * default binary, sqlite override path).
 */
export interface ProvisionOptions {
    customPhpPaths: string[];
    defaultPhpBinary: string | null;
    /** When set, the skeleton's `.env` points at this SQLite file
     *  instead of the default `database/database.sqlite`. */
    customDatabasePath?: string | null;
}

/**
 * Orchestrates skeleton lifecycle changes — actual composer runs +
 * ide-helper install + status broadcasting. The store owns the data;
 * the provisioner owns the work. Listen via `.on("status", ...)` to
 * receive `SkeletonStatusEvent`s that the IPC layer forwards to the
 * renderer.
 *
 * Concurrency: one provision at a time per slug. Overlapping provisions
 * across different slugs are allowed — composer runs are CPU-bound on
 * different targets, and users ticking multiple versions in quick
 * succession shouldn't be serialised.
 */
export class SkeletonProvisioner extends EventEmitter {
    private readonly store: SkeletonsStore;
    private readonly inFlight = new Set<SkeletonSlug>();

    constructor(store: SkeletonsStore) {
        super();
        this.store = store;
    }

    /**
     * Kick off provisioning for `slug`. Returns immediately — caller
     * subscribes to `status` events to track completion. If the slug
     * is already mid-provision the call is a no-op.
     */
    async provision(slug: SkeletonSlug, options: ProvisionOptions): Promise<void> {
        if (this.inFlight.has(slug)) return;
        this.inFlight.add(slug);
        try {
            await this.doProvision(slug, options);
        } finally {
            this.inFlight.delete(slug);
        }
    }

    /**
     * Hard-reset the skeleton: wipes the folder + re-runs composer.
     * Same entry point the UI's "↻ Refresh" button hits. The folder
     * wipe is owned by `doProvision` (it always clears the target
     * before invoking composer) — `reprovision` is just a naming alias
     * for `provision` at this point. Kept as a separate method so the
     * call site intent stays explicit AND so a future "keep vendor/,
     * only re-run ide-helper" short path can land here without
     * rippling through callers.
     */
    async reprovision(slug: SkeletonSlug, options: ProvisionOptions): Promise<void> {
        await this.provision(slug, options);
    }

    /**
     * Remove a skeleton. Non-default skeletons only — the `latest` row
     * is protected and this call is a no-op for it. The folder on disk
     * is removed when `deleteFolder` is true; otherwise it's left in
     * place (useful if the user's been editing it as a playground and
     * just wants to hide it from the picker).
     */
    remove(slug: SkeletonSlug, deleteFolder: boolean): void {
        const row = this.store.bySlug(slug);
        if (!row) return;
        if (row.isDefault) return;
        if (deleteFolder) {
            const folder = SkeletonsStore.folderFor(slug);
            try {
                fs.rmSync(folder, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
        this.store.delete(slug);
        this.emitStatus({ slug, status: "removed" });
    }

    private async doProvision(slug: SkeletonSlug, options: ProvisionOptions): Promise<void> {
        const { customPhpPaths, defaultPhpBinary, customDatabasePath } = options;
        // Per-line emitter — listeners (the IPC layer) own throttling
        // since they're closer to the wire and can rate-limit per
        // connection. The provisioner just streams every line.
        const emitProgress = (line: string): void => {
            this.emit("progress", { slug, detail: line });
        };

        // Ensure row exists and is in the provisioning state.
        if (!this.store.bySlug(slug)) {
            this.store.insert(slug, "provisioning");
        } else {
            this.store.update(slug, { status: "provisioning", error: null });
        }
        this.emitStatus({ slug, status: "provisioning" });

        const folder = SkeletonsStore.folderFor(slug);
        // `buildLaravelAt` refuses a non-empty directory — clear it
        // unconditionally so a failed previous attempt's partial tree
        // doesn't poison the retry.
        if (fs.existsSync(folder)) {
            try {
                fs.rmSync(folder, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }

        // Resolve PHP up-front so we can probe pdo_sqlite — the result
        // gates BOTH the .env layout (sqlite vs commented-out DB) and
        // whether `php artisan migrate` runs. A null binary means no PHP
        // at all on the host; the no-PHP banner already covers that case
        // in the renderer, but we still need a sane default here.
        const phpBinary = await pickPhpBinaryForProject(folder, customPhpPaths, defaultPhpBinary);
        const hasPdoSqlite = phpBinary ? await probePhpExtension(phpBinary, "pdo_sqlite") : false;

        const build = await buildLaravelAt(
            folder,
            slug,
            {
                onLine: (_stream, line) => emitProgress(line),
            },
            { hasPdoSqlite, customDatabasePath: customDatabasePath ?? null },
        );

        if (!build.ok) {
            this.store.update(slug, { status: "failed", error: build.error ?? "composer failed" });
            this.emitStatus({ slug, status: "failed", error: build.error ?? "composer failed" });
            return;
        }

        // Best-effort post-provisioning: run the default migrations
        // (otherwise `User::find(1)` 400s with "no such table: users"
        // on a fresh skeleton) and then install ide-helper. Both are
        // soft-failed — we still report `ready` if either trips because
        // the scaffold itself is usable, and ide-helper stubs + a
        // migrated DB are nice-to-haves, not a correctness requirement.
        // `ide-helper:models` is run AFTER migrate so it can introspect
        // real columns instead of generating empty docblocks.
        // Migrate is also skipped when pdo_sqlite is missing — the
        // skeleton has no DB binding then and migrate would just error.
        try {
            if (phpBinary) {
                if (hasPdoSqlite) {
                    const migrate = await migrateScaffold(folder, phpBinary, {
                        onLine: (_stream, line) => emitProgress(line),
                    });
                    if (!migrate.ok) {
                        console.warn(`[skeletons:${slug}] artisan migrate failed:`, migrate.error);
                    }
                } else {
                    console.warn(`[skeletons:${slug}] pdo_sqlite missing — skipping migrate`);
                }

                const ide = await installIdeHelper({
                    projectPath: folder,
                    phpBinary,
                    onLine: (_stage, line) => emitProgress(line),
                });
                if (!ide.ok) {
                    console.warn(`[skeletons:${slug}] ide-helper install failed:`, ide.error);
                }
            } else {
                console.warn(`[skeletons:${slug}] no PHP binary discovered — skipping migrate + ide-helper`);
            }
        } catch (err) {
            console.warn(`[skeletons:${slug}] post-provision step errored:`, err);
        }

        this.store.update(slug, {
            status: "ready",
            error: null,
            installedVersion: build.version ?? null,
        });
        this.emitStatus({ slug, status: "ready", installedVersion: build.version ?? null });
    }

    private emitStatus(event: SkeletonStatusEvent): void {
        this.emit("status", event);
    }
}

/**
 * Mirror of `choosePhpFor` in main.ts but without a Project argument —
 * we don't register skeletons as full Projects during provisioning, so
 * the normal `choosePhpFor` entry point isn't available yet.
 *
 * Priority:
 *   1. User's explicit default PHP binary (if set and exists).
 *   2. Installed PHP that best matches the freshly-scaffolded project's
 *      composer.json `require.php` constraint.
 *   3. First discovered PHP.
 *   4. null — upstream logs & skips ide-helper install.
 */
async function pickPhpBinaryForProject(
    projectDir: string,
    customPhpPaths: string[],
    defaultBinary: string | null,
): Promise<string | null> {
    if (defaultBinary && fs.existsSync(defaultBinary)) return defaultBinary;
    const all = await discoverPhpVersions(customPhpPaths);
    if (!all.length) return null;
    const required = readRequiredPhp(projectDir);
    if (required) {
        const matched = pickPhpForConstraint(required, all);
        if (matched) return matched.path;
    }
    return all[0]!.path;
}

function rowToSkeleton(r: Record<string, unknown>): Skeleton {
    return {
        slug: String(r.slug) as SkeletonSlug,
        installedVersion: r.installed_version ? String(r.installed_version) : null,
        folderPath: String(r.folder_path),
        status: String(r.status) as SkeletonStatus,
        error: r.error ? String(r.error) : null,
        isDefault: Number(r.is_default) === 1,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
    };
}
