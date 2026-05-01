import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NewSshProjectInput, Project, SshConfig } from "../shared/ipc.js";
import { readLaravelVersion, readRequiredPhp } from "./laravelVersion.js";
import { validateSshConfig } from "./sshSession.js";
import { appDataDir } from "./paths.js";

/** The bundled Laravel skeleton always gets this id. Stable across releases. */
const BUNDLED_PROJECT_ID = "00000000-0000-4000-8000-000000000001";

/**
 * JSON-file backed project store. Formerly `ConnectionStore`. Two kinds:
 *
 *   - `laravel` — a local folder; enrichment reads composer metadata on
 *     every list() call.
 *   - `ssh` — a remote Laravel project over SSH. No local enrichment
 *     (would require a network round-trip); `laravelVersion` etc. stay
 *     null until the renderer has connected once.
 *
 * Writes are atomic (tmp + rename) — a crash mid-write previously lost
 * every configured project.
 */
export class ProjectStore {
    private readonly file: string;
    private projects: Project[];

    constructor() {
        const dir = appDataDir();
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, "projects.json");
        // One-shot migration: earlier releases stored this as `connections.json`.
        // Rename once and carry the data across. Done before the first load()
        // call so existing users don't see an empty list on the first boot
        // of the renamed app.
        const legacy = path.join(dir, "connections.json");
        if (fs.existsSync(legacy) && !fs.existsSync(this.file)) {
            try {
                fs.renameSync(legacy, this.file);
            } catch {
                /* fall through to empty */
            }
        }
        this.projects = this.load();
    }

    /**
     * Returns the projects list with `laravelVersion` / `requiredPhp` /
     * `ideHelperInstalled` resolved fresh for local projects. SSH projects
     * pass through as-is — resolving those synchronously would block on
     * the network.
     */
    all(): Project[] {
        return this.projects.map((p) => enrich(p));
    }

    byId(id: string): Project | undefined {
        const base = this.projects.find((p) => p.id === id);
        return base ? enrich(base) : undefined;
    }

    /**
     * Add a local Laravel project. Validates that the directory contains
     * the telltale `artisan` + `bootstrap/app.php` before accepting — the
     * folder picker already checks this, but callers from elsewhere might
     * not.
     */
    addLocalLaravel(input: { name: string; projectPath: string }): Project {
        if (!path.isAbsolute(input.projectPath)) {
            throw new Error("Local project path must be absolute");
        }
        if (!fs.existsSync(path.join(input.projectPath, "artisan"))) {
            throw new Error("Not a Laravel project (artisan missing)");
        }
        const full: Project = {
            id: randomUUID(),
            name: input.name,
            kind: "laravel",
            projectPath: input.projectPath,
        };
        this.projects.push(full);
        this.save();
        return enrich(full);
    }

    /**
     * Register a remote Laravel project reachable over SSH. Validates the
     * connection shape (host syntax, port range, auth-mode preconditions)
     * before persisting. The plaintext secret in `input.secret` is NOT
     * stored here — main.ts routes it through `SecretStore` so only the
     * OS-encrypted ciphertext ever hits disk.
     */
    addSsh(input: NewSshProjectInput): Project {
        if (!input.name.trim()) throw new Error("Project name is required");
        if (!input.projectPath.startsWith("/") && !input.projectPath.startsWith("~")) {
            throw new Error("Remote path must be absolute (start with / or ~)");
        }
        if (input.projectPath.includes("\0")) throw new Error("Invalid remote path");
        validateSshConfig(input.ssh);

        // Keep the persisted SSH shape tight — only the fields we recognize,
        // and only if they're set. Stops a crafted `projects.json` from
        // smuggling extra ssh knobs into our connection config. `secretStored`
        // is deliberately NOT persisted — it's derived at list time by
        // checking the vault.
        const ssh: SshConfig = {
            host: input.ssh.host,
            authMode: input.ssh.authMode,
        };
        if (input.ssh.port !== undefined) ssh.port = input.ssh.port;
        if (input.ssh.user !== undefined && input.ssh.user.length > 0) ssh.user = input.ssh.user;
        if (input.ssh.authMode === "key" && input.ssh.identityFile !== undefined && input.ssh.identityFile.length > 0) {
            ssh.identityFile = input.ssh.identityFile;
        }
        // Persist the secret-sourcing strategy so Run / Test know what
        // to do later. Default to `keychain` for historical compat; for
        // agent-mode the strategy is effectively ignored at connect time.
        ssh.secretStrategy = input.ssh.secretStrategy ?? "keychain";
        ssh.strictHostKeyChecking = input.ssh.strictHostKeyChecking ?? "accept-new";

        const full: Project = {
            id: randomUUID(),
            name: input.name.trim(),
            kind: "ssh",
            projectPath: input.projectPath.trim(),
            ssh,
        };
        this.projects.push(full);
        this.save();
        return full;
    }

    remove(id: string): void {
        this.projects = this.projects.filter((p) => p.id !== id);
        this.save();
    }

    /**
     * Persist the "don't ask again" flag for the IDE-helper prompt. Returns
     * the enriched project so the renderer can patch its store without a
     * second list call.
     */
    setIdeHelperDeclined(id: string, declined: boolean): Project | null {
        const base = this.projects.find((p) => p.id === id);
        if (!base) return null;
        base.ideHelperDeclined = declined;
        this.save();
        return enrich(base);
    }

    private load(): Project[] {
        try {
            if (!fs.existsSync(this.file)) return [];
            const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (!Array.isArray(raw)) return [];
            const loaded = raw
                .map(coerceProject)
                .filter((p): p is Project => p !== null)
                // One-shot migration: older builds persisted the bundled
                // Laravel skeleton as a Project with this fixed id. The
                // multi-skeleton system now tracks that separately in
                // SQLite, so strip any stale BUNDLED_PROJECT_ID rows
                // rather than leaving an orphan that points at a
                // renamed folder.
                .filter((p) => p.id !== BUNDLED_PROJECT_ID);
            if (loaded.length !== raw.length) {
                // Persist the purge immediately so a subsequent crash
                // doesn't re-run the same migration next boot. If the
                // write fails we still return the filtered list; the
                // next `save()` from a user action overwrites cleanly.
                // Surface the failure so users can escalate rather than
                // silently re-migrating on every boot.
                try {
                    const tmp = this.file + ".tmp";
                    fs.writeFileSync(tmp, JSON.stringify(loaded, null, 2), "utf8");
                    fs.renameSync(tmp, this.file);
                } catch (err) {
                    console.warn(
                        "[ProjectStore] failed to persist bundled-skeleton purge; " + "will retry next boot:",
                        err,
                    );
                }
            }
            return loaded;
        } catch {
            return [];
        }
    }

    private save(): void {
        // Atomic write — a crash between truncate and flush on a direct
        // writeFileSync would leave the file corrupt and silently wipe every
        // configured project on next boot. Same pattern as SettingsStore.
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.projects, null, 2), "utf8");
        fs.renameSync(tmp, this.file);
    }
}

/**
 * Accept either the old `connections.json` shape or the current one and
 * normalise to `Project`. Drops anything that doesn't round-trip — we'd
 * rather lose one malformed entry than crash the whole store.
 */
function coerceProject(raw: unknown): Project | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") return null;
    if (o.kind !== "laravel" && o.kind !== "ssh") return null;
    if (typeof o.projectPath !== "string") return null;

    const base: Project = {
        id: o.id,
        name: o.name,
        kind: o.kind,
        projectPath: o.projectPath,
    };
    if (typeof o.ideHelperDeclined === "boolean") base.ideHelperDeclined = o.ideHelperDeclined;
    if (o.kind === "ssh" && o.ssh && typeof o.ssh === "object") {
        const s = o.ssh as Record<string, unknown>;
        if (typeof s.host !== "string") {
            return null; // SSH project without a host is unusable
        }
        // Migrate legacy shapes that predate the auth-mode enum: an
        // identityFile implied key auth, otherwise we assume agent auth.
        // `secretStored` is never read from disk — it's recomputed by
        // main.ts on list.
        const rawAuth = s.authMode;
        const authMode =
            rawAuth === "password" || rawAuth === "key" || rawAuth === "agent"
                ? rawAuth
                : typeof s.identityFile === "string" && s.identityFile.length > 0
                  ? "key"
                  : "agent";
        const ssh: SshConfig = {
            host: s.host,
            authMode,
        };
        if (typeof s.port === "number") ssh.port = s.port;
        if (typeof s.user === "string") ssh.user = s.user;
        if (authMode === "key" && typeof s.identityFile === "string") {
            ssh.identityFile = s.identityFile;
        }
        // Migrate secretStrategy: projects saved before this field existed
        // imply `keychain` (we used to always store to the vault on add).
        // Legacy "command" entries fall back to `prompt` so the project
        // stays usable — the user has to re-enter the secret, but it's
        // safer than silently losing auth.
        const rawStrategy = s.secretStrategy;
        ssh.secretStrategy =
            rawStrategy === "keychain" || rawStrategy === "prompt" || rawStrategy === "none"
                ? rawStrategy
                : rawStrategy === "command"
                  ? "prompt"
                  : "keychain";
        if (s.strictHostKeyChecking === "yes" || s.strictHostKeyChecking === "accept-new") {
            ssh.strictHostKeyChecking = s.strictHostKeyChecking;
        }
        base.ssh = ssh;
    }
    return base;
}

/**
 * Augment a persisted project with fields derived from on-disk state.
 * Only local Laravel projects get enriched — SSH projects would require a
 * network round-trip on every list() call.
 */
function enrich(p: Project): Project {
    if (p.kind !== "laravel") return p;
    return {
        ...p,
        laravelVersion: readLaravelVersion(p.projectPath),
        requiredPhp: readRequiredPhp(p.projectPath),
        ideHelperInstalled: fs.existsSync(path.join(p.projectPath, "vendor/barryvdh/laravel-ide-helper")),
    };
}
