/**
 * IPC message types shared between main and renderer processes.
 * The preload script exposes a typed `window.lsp` API built from these.
 */

export type FramePayload =
    | { type: "ready"; id: string; php: string; pid: number }
    | { type: "stdout"; id: string; chunk: string }
    | { type: "dump"; id: string; value: DumpedValue }
    | { type: "result"; id: string; duration_ms: number }
    | { type: "error"; id: string; class: string; message: string; file?: string; line?: number; trace: TraceEntry[] }
    | { type: "cancelled"; id: string };

export interface TraceEntry {
    file?: string;
    line?: number;
    function?: string;
}

export type DumpedValue =
    | { kind: "null" }
    | { kind: "bool"; value: boolean }
    | { kind: "int"; value: number }
    | { kind: "float"; value: number | "NaN" | "INF" | "-INF" }
    | { kind: "string"; value: string; length: number; truncated: boolean }
    | {
          kind: "array";
          count: number;
          items: Array<{ key: string | number; keyKind: "int" | "string"; value: DumpedValue }>;
      }
    | { kind: "object"; class: string; props: Array<{ name: string; visibility: string; value: DumpedValue }> }
    | {
          kind: "eloquent";
          class: string;
          key?: DumpedValue;
          props: Array<{ name: string; visibility: string; value: DumpedValue }>;
      }
    | { kind: "datetime"; class: string; iso: string; tz: string }
    | {
          kind: "iterable";
          class: string;
          count: number;
          items: Array<{ key: string | number; keyKind: "int" | "string"; value: DumpedValue }>;
      }
    | { kind: "resource"; type: string; id: number }
    | { kind: "uninitialized" }
    | { kind: "truncated" }
    | { kind: "unknown" };

/**
 * User-facing container for "a thing the REPL can run code against." Formerly
 * called `Connection`. Two kinds today:
 *
 *   - `laravel` — a local Laravel project folder. `projectPath` is an absolute
 *     filesystem path; the runner spawns `php` against a bootstrap that
 *     requires `vendor/autoload.php` from that path.
 *
 *   - `ssh` — a Laravel project on a remote host reachable over SSH. `ssh`
 *     describes how to connect; `projectPath` is the absolute path to the
 *     Laravel project *on the remote host*. No credentials are persisted —
 *     auth goes through the user's ssh-agent / ~/.ssh/config / key file.
 */
type ProjectKind = "laravel" | "ssh";

/**
 * How the SSH client should authenticate. Resolved from the UI's shape
 * (TablePlus-style form with a password field + optional "Use SSH key")
 * into this explicit discriminator so the backend never has to guess.
 *
 *   • `password` — username + password. Password is stored encrypted via
 *     Electron's `safeStorage` (Keychain / DPAPI / libsecret).
 *   • `key`      — username + private key file. If the key is passphrase-
 *     protected, the passphrase is stored the same way as a password.
 *   • `agent`    — use the running ssh-agent (Unix SSH_AUTH_SOCK, Windows
 *     Pageant). No credential is persisted — auth is external.
 */
export type SshAuthMode = "password" | "key" | "agent";

/**
 * Where the secret (password / key passphrase) is sourced at connect
 * time. Matches the TablePlus dropdown UX:
 *
 *   • `keychain` — the secret is encrypted with the OS vault (macOS
 *     Keychain / Windows DPAPI / Linux libsecret) and reloaded on every
 *     connect without user interaction.
 *   • `prompt`   — the app asks every time. Nothing persisted. Right
 *     for shared machines or paranoid threat models.
 *   • `none`     — no secret will be supplied. Makes sense for an
 *     unencrypted private key; a "password" auth with this strategy
 *     will almost always fail.
 *
 * Orthogonal to `authMode` — the mode decides *what* secret is needed,
 * the strategy decides *where it comes from*.
 */
export type SshSecretStrategy = "keychain" | "prompt" | "none";

export interface SshConfig {
    /** Hostname or IP. No shell metacharacters. */
    host: string;
    /** Port. Defaults to 22. */
    port?: number;
    /** Login user. Required for password + key; optional for agent. */
    user?: string;
    /** Auth strategy — drives what secret (if any) we expect in the vault. */
    authMode: SshAuthMode;
    /**
     * Absolute path to a private key file. Required when `authMode === "key"`.
     * Ignored otherwise.
     */
    identityFile?: string;
    /**
     * How the secret (password or key passphrase) is sourced at connect
     * time. Defaults to `keychain` for password/key modes, implicitly
     * `none` for agent mode. See `SshSecretStrategy` docstring.
     */
    secretStrategy?: SshSecretStrategy;
    /**
     * True if a password / passphrase is actually sitting in the OS
     * credential vault under this project's id (for `secretStrategy:
     * "keychain"`). Runtime-only — re-derived on every projects:list
     * call from the vault itself; never written to projects.json.
     */
    secretStored?: boolean;
    /**
     * `accept-new` (default) adds unknown host keys to known_hosts on first
     * connect and refuses to connect if the stored key later changes. `yes`
     * refuses any unknown host. `no` is deliberately *not* exposed — we don't
     * want a path that silently accepts MITM.
     */
    strictHostKeyChecking?: "yes" | "accept-new";
}

export interface Project {
    id: string;
    name: string;
    kind: ProjectKind;
    /**
     * Absolute filesystem path to the Laravel project. For `kind: "laravel"`
     * that's a local path; for `kind: "ssh"` it's an absolute path on the
     * remote host.
     */
    projectPath: string;
    /** Present iff `kind === "ssh"`. Never carries secrets. */
    ssh?: SshConfig;
    /**
     * Framework version resolved from the project's `vendor/composer/installed.json`.
     * Computed on every `projects:list` call for local projects; null for SSH
     * projects (we don't probe the remote synchronously — enrichment happens
     * the next time the runner connects).
     */
    laravelVersion?: string | null;
    /**
     * Raw PHP version constraint from the project's `composer.json`
     * (e.g. `"^8.2"`). Used to auto-pick a matching local PHP binary. Always
     * null for SSH projects (the remote chooses its own PHP).
     */
    requiredPhp?: string | null;
    /**
     * True if `vendor/barryvdh/laravel-ide-helper` exists locally. Not
     * checked for SSH projects today.
     */
    ideHelperInstalled?: boolean;
    /**
     * Persisted flag — true means the user chose "don't ask again" for this
     * project, so we should never prompt about installing ide-helper.
     * A one-shot "not now" is tracked in renderer session state, not here.
     */
    ideHelperDeclined?: boolean;
    /**
     * True when this Project is a runtime projection of a pre-provisioned
     * Laravel skeleton (see `Skeleton` below). The id will be
     * `skeleton:<slug>`; the renderer groups these under a "Laravel
     * skeletons" header in the project picker. The user can't delete
     * skeleton-backed projects from the list directly — they manage
     * them from the Laravel settings tab.
     */
    isBundled?: boolean;
}

/**
 * Streamed status event from the main process while `ideHelper:install`
 * runs. Stages fire in order: `composer-require` → `artisan-generate` →
 * `artisan-models` → `artisan-meta` → `done`. `error` can surface at any
 * point and halts the install.
 */
export type IdeHelperProgress =
    | {
          projectId: string;
          stage: "composer-require" | "artisan-generate" | "artisan-models" | "artisan-meta";
          line: string;
      }
    | { projectId: string; stage: "done" }
    | { projectId: string; stage: "error"; message: string };

/**
 * laravel-ls is a Go-based LSP that complements Intelephense with Laravel-
 * specific completions (routes, views, configs, env, translations,
 * container bindings). Because it's a platform binary we can't bundle in
 * the installer, we download it from the project's GitHub release on
 * first run and cache it under `userData/bin/laravel-ls-${VERSION}`.
 *
 * The state machine:
 *   checking    → inspecting disk; transitional
 *   downloading → GET in flight; progress events stream alongside
 *   verifying   → hashing the downloaded bytes against the pinned digest
 *   ready       → binary present & validated; LSP is (or can be) running
 *   unsupported → no release asset for this platform/arch pair
 *   skipped     → user dismissed the download prompt; app continues without
 *   error       → download or verification failed; carries a message
 *                 the renderer shows in the splash's retry UI
 */
export type LaravelLsStatus =
    | { state: "checking" }
    | { state: "downloading"; version: string; received: number; total: number }
    | { state: "verifying"; version: string }
    | { state: "ready"; version: string }
    | { state: "unsupported"; platform: string; arch: string }
    | { state: "skipped" }
    | { state: "error"; message: string };

/** Streamed while a download is in flight. `total` is 0 when the server
 *  didn't advertise Content-Length (unlikely from github, but handle it). */
export interface LaravelLsProgress {
    version: string;
    received: number;
    total: number;
}

export interface PhpVersionInfo {
    path: string;
    version: string;
    source: "Homebrew" | "asdf" | "Herd" | "System" | "Custom";
}

/**
 * Snapshot of PHP availability on the host. Pushed from main on boot
 * and on any settings mutation that could change discovery (custom paths,
 * default binary). The renderer gates Monaco mounting on `available` —
 * a missing PHP turns the editor pane into a {@link NoPhpBanner}-style
 * fix-it screen rather than mounting an editor that has no language
 * server to back it.
 */
export interface PhpAvailability {
    available: boolean;
    binaries: PhpVersionInfo[];
}

/**
 * Snapshot of SQLite availability on the host. Two independent checks:
 *
 *   • `pdoSqlite` — PHP's `pdo_sqlite` extension. Probed against the
 *     active default PHP. Drives the skeleton bootstrap fallback —
 *     when not available, fresh skeletons are configured without
 *     `DB_CONNECTION=sqlite` and `php artisan migrate` is skipped.
 *   • `cli` — the system `sqlite3` command. Not consumed by any
 *     runtime path today, but surfaced in the Database tab so the
 *     user can drop a custom path now and have future schema-browser
 *     features pick it up.
 */
export interface SqliteAvailability {
    pdoSqlite: {
        available: boolean;
        /** PHP binary that was probed, or null if no PHP is configured. */
        phpBinary: string | null;
    };
    cli: {
        available: boolean;
        path: string | null;
        version: string | null;
    };
}

/**
 * One row in the splash screen's progress list. The renderer composes
 * these from the laravel-ls download status and the latest skeleton's
 * provisioning state — main never sees the `SplashStep` shape directly.
 *
 *   • `progress` is set when the step has byte-level progress (downloads
 *     with a known content-length). Steps without it render as an
 *     indeterminate animation.
 *   • `detail` is a one-line sub-label (e.g. the latest composer line
 *     during skeleton provisioning).
 */
export interface SplashStep {
    id: "laravelLs" | "skeleton";
    label: string;
    state: "pending" | "active" | "downloading" | "verifying" | "ready" | "error" | "skipped";
    progress?: { received: number; total: number };
    detail?: string;
}

/**
 * Streamed during skeleton provisioning so the splash can show the
 * latest composer line. Throttled in the IPC layer to keep flicker
 * down — composer can spam several lines per second mid-install.
 */
export interface SkeletonProvisionProgress {
    slug: SkeletonSlug;
    detail: string;
}

export type FimTemplate = "auto" | "qwen" | "codellama" | "deepseek" | "starcoder" | "none";

/**
 * A user-managed database connection profile. Drives the toolbar's
 * Database picker when running against a bundled Laravel skeleton —
 * `DB_*` env vars get injected into the worker so phpdotenv's
 * `ImmutableWriter` honours the OS env over the skeleton's `.env`.
 *
 * Local + SSH projects ignore this entirely; they keep their own `.env`.
 */
export type DatabaseDriver = "sqlite" | "mysql" | "pgsql";

export interface DatabaseConnection {
    id: string;
    name: string;
    driver: DatabaseDriver;
    /**
     * SQLite: absolute file path. mysql / pgsql: database name. Always
     * non-empty — empty values would defeat the override (the skeleton's
     * `.env` has empty `DB_*=` lines that phpdotenv treats as defined).
     */
    database: string;
    /** mysql / pgsql only. */
    host?: string;
    /**
     * mysql / pgsql only. Persisted explicitly (3306 / 5432) — never
     * blank. The form fills in driver defaults so we never inject an
     * empty value (Laravel's `env('DB_PORT', '3306')` won't fall back
     * if the value is defined-but-empty).
     */
    port?: number;
    /** mysql / pgsql only. */
    username?: string;
    /**
     * Runtime-enriched on every `database:list` call from the
     * `SecretStore` — true means a password is sitting in the OS
     * keychain under `db:<id>`. Never persisted to settings.json.
     */
    secretStored?: boolean;
}

/**
 * Result of a `database:test` probe. Spawns a tiny PHP process that
 * does `new PDO(...)` with the connection's settings; success returns
 * the server version (where the driver supports it), failure reports
 * the underlying message so the renderer can surface it inline.
 */
export type DatabaseTestResult = { ok: true; serverVersion?: string } | { ok: false; error: string };

export interface Settings {
    ui: {
        mode: "light" | "dark" | "system";
    };
    editor: {
        theme: string;
        fontSize: number;
        tabSize: number;
        wordWrap: boolean;
        lineNumbers: boolean;
    };
    php: {
        defaultBinary: string | null;
        customPaths: string[];
        /**
         * Allow-list of PHP binary paths the user wants visible in the
         * toolbar's PHP picker. Empty = no filter (every discovered binary
         * is shown), which is the back-compat default for users upgrading
         * from before this setting existed. Toggled from PhpTab via
         * checkboxes.
         */
        enabledPaths: string[];
    };
    general: {
        restoreTabsOnLaunch: boolean;
    };
    /**
     * Optional AI code completion via a local Ollama server. Off by default —
     * no AI traffic leaves the app until the user flips `enabled` to true.
     */
    ai: {
        enabled: boolean;
        endpoint: string;
        model: string;
        fimTemplate: FimTemplate;
        maxTokens: number;
        temperature: number;
        debounceMs: number;
        maxContextChars: number;
    };
    /**
     * User-managed database connection profiles. The Settings tab is a
     * pure CRUD list — there's no global "active connection" any more.
     * Each tab stores its own `databaseConnectionId` and the toolbar
     * picker is the one switch. Default for any tab is `null`,
     * which means "use the project's own `.env`".
     *
     * Connections only take effect for bundled Laravel skeletons
     * (`Project.isBundled === true`); local + SSH projects always use
     * their own `.env`.
     */
    database: {
        connections: DatabaseConnection[];
        /**
         * SQLite tooling overrides — both null by default, in which case
         * the app uses the discovered system `sqlite3` for any future
         * CLI-backed feature, and the per-skeleton default
         * `database/database.sqlite` file. Set by the user via Settings →
         * Database to recover from a missing system install or to point
         * the skeleton at an external SQLite file.
         */
        sqlite: {
            customCliPath: string | null;
            customDatabasePath: string | null;
        };
    };
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Pre-provisioned Laravel skeleton tracked in SQLite. Identified by its
 * `slug` (`latest` | `12.x` | `11.x` | …) — the slug doubles as the
 * folder name under `<appDataDir>/skeletons/`. The `latest` row always
 * exists and can't be deleted; all others are user-managed via the
 * settings checkboxes.
 */
export interface Skeleton {
    slug: SkeletonSlug;
    installedVersion: string | null;
    folderPath: string;
    status: SkeletonStatus;
    error: string | null;
    isDefault: boolean;
    createdAt: number;
    updatedAt: number;
}

/**
 * Slugs identify a skeleton row uniquely and double as the folder name
 * under `skeletons/`. `latest` is composer's newest stable pick; the
 * `N.x` forms resolve via `^N.0` so users land on the most recent
 * patch of whichever major they ticked.
 */
export type SkeletonSlug = "latest" | "13.x" | "12.x" | "11.x" | "10.x" | "9.x";
export type SkeletonStatus = "provisioning" | "ready" | "failed";

/**
 * The full set of slugs surfaced in the settings UI, in the order they
 * should be rendered (newest first, with `latest` pinned to the top).
 */
export const SKELETON_SLUGS: readonly SkeletonSlug[] = ["latest", "13.x", "12.x", "11.x", "10.x", "9.x"] as const;

/** Streamed status event — the settings UI reacts to these to flip
 *  the per-row indicator between provisioning / ready / failed. */
export type SkeletonStatusEvent =
    | { slug: SkeletonSlug; status: "provisioning" }
    | { slug: SkeletonSlug; status: "ready"; installedVersion: string | null }
    | { slug: SkeletonSlug; status: "failed"; error: string }
    | { slug: SkeletonSlug; status: "removed" };

/** User-saved code snippet (persisted in SQLite alongside history). */
export interface Snippet {
    id: string;
    name: string;
    code: string;
    createdAt: number; // unix seconds
    updatedAt: number;
}

/** Minimal tab shape persisted to disk so we can rehydrate on launch. */
export interface PersistedTab {
    id: string;
    title: string;
    code: string;
    projectId: string;
    /**
     * Per-tab PHP binary override. When set, the toolbar's PHP picker is
     * showing this binary for this tab and the runner spawns the worker
     * against it. Independent across tabs so the user can compare runs
     * across PHP versions side-by-side. `null` falls back to
     * `settings.php.defaultBinary`, then to the first enabled binary.
     */
    phpBinary?: string | null;
    /**
     * Per-tab database connection. `null` (the default for new tabs)
     * means "use the project's `.env`"; a string means "use this
     * connection's `DB_*` env vars" — only takes effect for bundled
     * skeletons. There's no global "active" fallback any more; the
     * tab's value is authoritative.
     */
    databaseConnectionId?: string | null;
}

export interface PersistedTabs {
    tabs: PersistedTab[];
    selectedTabId: string | null;
}

/**
 * Input to `projects:addSsh`. The plaintext `secret` (password or key
 * passphrase) is split out so it reaches the main process exactly once,
 * gets encrypted, and is never stored in `projects.json`. Everything
 * else is validated + persisted.
 */
export interface NewSshProjectInput {
    name: string;
    projectPath: string;
    ssh: SshConfig;
    /**
     * Password (for `authMode: "password"`) or private-key passphrase
     * (for `authMode: "key"`). Optional for key mode — many keys are
     * unencrypted. Absent for `agent` mode.
     */
    secret?: string;
}

/**
 * Result of a one-shot SSH probe (`projects:testSsh`). On success we report
 * the remote PHP version and whether the path looks like a Laravel project
 * (has both `artisan` and `bootstrap/app.php`). On failure we surface a
 * stage so the UI can point at the right thing to fix, plus a human-
 * readable message.
 */
export type SshTestResult =
    | { ok: true; phpVersion: string; laravelDetected: boolean }
    | {
          ok: false;
          error: string;
          stage: "connect" | "auth" | "no_php" | "no_path" | "not_laravel" | "php_failed" | "timeout" | "unknown";
      };

export interface TestSshInput {
    ssh: SshConfig;
    projectPath: string;
    /**
     * Plaintext secret to try for this probe. For a saved project, the
     * renderer can omit this and the backend will read the stored secret
     * from the vault instead.
     */
    secret?: string;
    /**
     * When provided, the backend looks up the stored secret for this
     * project id if `secret` itself is absent. Used by the Test button on
     * an existing project (before we re-expose the password field).
     */
    projectId?: string;
}

/**
 * Channel contracts — the preload maps these 1:1.
 */
export interface LspBridge {
    // Runner
    /**
     * Spawn a worker for `projectId`. Optional per-tab overrides take
     * precedence over the global settings — they let the renderer run
     * the same project under different PHP versions / database
     * connections in different tabs without mutating the user's
     * Settings each time. Skeleton-only DB injection still applies;
     * `databaseConnectionId` is silently ignored for non-skeleton
     * projects.
     */
    runnerStart(
        projectId: string,
        overrides?: { phpBinary?: string | null; databaseConnectionId?: string | null },
    ): Promise<{ sessionId: string; phpVersion: string }>;
    runnerExec(sessionId: string, code: string): Promise<{ requestId: string }>;
    runnerCancel(sessionId: string): Promise<void>;
    onFrame(listener: (frame: FramePayload & { sessionId: string; requestId: string }) => void): () => void;

    // --- Runtime secret prompt ------------------------------------------
    /**
     * Fires when the main process needs a password/passphrase that
     * isn't available locally (strategy: "prompt"). The renderer shows
     * a modal, then replies via `secretPromptRespond`. `id` correlates
     * the response back to the main-side promise; `secret: null` means
     * the user cancelled.
     */
    onSecretPrompt(
        listener: (req: { id: string; projectId: string; projectName: string; authMode: SshAuthMode }) => void,
    ): () => void;
    secretPromptRespond(id: string, secret: string | null): void;

    // Projects (formerly Connections)
    projectsList(): Promise<Project[]>;
    projectsRemove(id: string): Promise<void>;
    /** Pick a local Laravel directory via a native folder picker. */
    projectsPickLaravel(): Promise<Project | null>;
    /** Pick an SSH private key file via a native file picker. */
    projectsPickSshKey(): Promise<string | null>;
    /** Register a remote Laravel project reachable over SSH. */
    projectsAddSsh(input: NewSshProjectInput): Promise<Project>;
    /**
     * Run a one-shot probe against an SSH config to verify the host is
     * reachable, auth works, `php` is on the remote PATH, and the path
     * exists. Does not persist anything. Times out at 15 s.
     */
    projectsTestSsh(input: TestSshInput): Promise<SshTestResult>;
    /** Persist the user's "don't ask again" choice for the IDE-helper prompt. */
    projectsSetIdeHelperDeclined(id: string, declined: boolean): Promise<Project | null>;

    /**
     * Run `composer require --dev barryvdh/laravel-ide-helper` + the three
     * `ide-helper:*` artisan commands inside a local project. Progress lines
     * stream via `onIdeHelperProgress`. Resolves to `true` on success,
     * `false` on failure (details arrive on the progress channel as a final
     * `error`). SSH projects reject — install manually on the remote.
     */
    ideHelperInstall(projectId: string): Promise<boolean>;
    onIdeHelperProgress(listener: (event: IdeHelperProgress) => void): () => void;

    // --- laravel-ls binary lifecycle ----------------------------------------
    /**
     * Ensure the laravel-ls binary is downloaded, verified, and the LSP is
     * running. Safe to call every boot — resolves immediately when the
     * pinned binary is already on disk. Kicks off a download otherwise and
     * resolves when it either succeeds, is skipped, is unsupported, or
     * fails. Progress lines stream via `onLaravelLsProgress` during the
     * download phase.
     */
    laravelLsPrepare(): Promise<LaravelLsStatus>;
    /** Read the current status without side effects. */
    laravelLsStatus(): Promise<LaravelLsStatus>;
    /** Retry a failed download (same semantics as `prepare`). */
    laravelLsRetry(): Promise<LaravelLsStatus>;
    /**
     * Mark the current boot as "user declined laravel-ls". Resolves the
     * in-flight `prepare()` so the splash can move on. Does not persist
     * anything across launches — a future Settings toggle can own that.
     */
    laravelLsSkip(): Promise<void>;
    onLaravelLsProgress(listener: (progress: LaravelLsProgress) => void): () => void;
    onLaravelLsStatus(listener: (status: LaravelLsStatus) => void): () => void;

    // --- Scratch file materialisation ---------------------------------------
    /**
     * Write a scratch buffer to disk under
     * `<projectPath>/.laravel-scratchpad/tab-<tabId>.php` and return the
     * `file://…` URI pointing at it. Needed because laravel-ls reads files
     * from disk on `didOpen`; synthetic in-memory URIs are rejected.
     * Overwrites existing content; safe to call on every debounced update.
     */
    scratchWrite(projectPath: string, tabId: string, content: string): Promise<string>;
    /** Remove the scratch file for this tab. Silent when already missing. */
    scratchDelete(projectPath: string, tabId: string): Promise<void>;

    // PHP versions
    phpVersions(): Promise<PhpVersionInfo[]>;

    // PHP availability — boot-time discovery snapshot. The renderer
    // gates Monaco mounting on `available`; missing PHP turns the
    // editor pane into the no-PHP banner.
    phpAvailability(): Promise<PhpAvailability>;
    /** Fired on boot, on settings mutation, and on explicit rescan. */
    onPhpAvailability(listener: (availability: PhpAvailability) => void): () => void;
    /** Force a fresh discovery + emit. Used by the no-PHP banner's "Rescan" button. */
    phpRescan(): Promise<PhpAvailability>;

    // SQLite availability — pdo_sqlite (PHP extension) + sqlite3 CLI.
    sqliteAvailability(): Promise<SqliteAvailability>;
    onSqliteAvailability(listener: (availability: SqliteAvailability) => void): () => void;
    /** Re-probe both checks. Triggered after a custom path is added. */
    sqliteRescan(): Promise<SqliteAvailability>;
    /** Native picker for the `sqlite3` CLI binary. */
    sqlitePickCliBinary(): Promise<string | null>;

    // Skeletons — pre-provisioned Laravel scaffolds managed from the
    // Laravel settings tab. Slugs are fixed (`latest` | `13.x` | …);
    // `latest` is always present and not deletable.
    skeletonsList(): Promise<Skeleton[]>;
    /** Provision a new skeleton for this slug, or retry a failed one. */
    skeletonsSelect(slug: SkeletonSlug): Promise<void>;
    /** Remove the row; optionally wipe the folder from disk too. Refused for `latest`. */
    skeletonsRemove(slug: SkeletonSlug, deleteFolder: boolean): Promise<void>;
    /** Blow the folder away + re-run composer. Used by the "↻" button. */
    skeletonsReprovision(slug: SkeletonSlug): Promise<void>;
    onSkeletonStatus(listener: (event: SkeletonStatusEvent) => void): () => void;
    /**
     * Streamed sub-status during skeleton provisioning — the latest
     * composer line, throttled. Drives the splash screen's skeleton
     * step's detail label without flooding IPC.
     */
    onSkeletonProgress(listener: (event: SkeletonProvisionProgress) => void): () => void;

    // Settings
    settingsGet(): Promise<Settings>;
    settingsSet(patch: DeepPartial<Settings>): Promise<Settings>;
    settingsAddCustomPhp(path: string): Promise<Settings>;
    settingsRemoveCustomPhp(path: string): Promise<Settings>;
    settingsPickPhpBinary(): Promise<string | null>;
    onSettingsChanged(listener: (settings: Settings) => void): () => void;
    onSessionsReset(listener: () => void): () => void;

    // Database connections — applies only to bundled Laravel skeletons.
    /** List with `secretStored` enriched from the keychain. */
    databaseList(): Promise<DatabaseConnection[]>;
    /** Persist a new connection. Plaintext `secret` is encrypted via OS keychain. */
    databaseAdd(input: {
        connection: Omit<DatabaseConnection, "id" | "secretStored">;
        secret?: string;
    }): Promise<DatabaseConnection>;
    /**
     * Patch fields on an existing connection. Pass `secret` to update the
     * stored password; pass `clearSecret: true` to remove the stored
     * secret without setting a new one. Refuses to mutate `id` or
     * `isSeeded`.
     */
    databaseUpdate(input: {
        id: string;
        patch: Partial<Omit<DatabaseConnection, "id">>;
        secret?: string;
        clearSecret?: boolean;
    }): Promise<DatabaseConnection>;
    /**
     * Remove a connection. Clears the keychain entry; tabs that picked
     * this connection silently fall back to the project's `.env` on
     * their next run.
     */
    databaseRemove(id: string): Promise<void>;
    /**
     * Probe a connection by id (uses the stored secret) or inline (uses
     * the supplied secret). Spawns a tiny PHP one-liner; uses whichever
     * PHP binary the user has selected as default.
     */
    databaseTest(input: {
        id?: string;
        connection?: Omit<DatabaseConnection, "id" | "secretStored">;
        secret?: string;
    }): Promise<DatabaseTestResult>;
    /** Native file picker for the SQLite path. */
    databasePickSqliteFile(): Promise<string | null>;

    // External (clickable file:line in error traces)
    openExternal(url: string): Promise<void>;

    /** Writable paths we hand to Intelephense so its workspace index persists.
     *  Keyed by `phpVersion` so changing the PHP target forces a fresh index
     *  against the new parse rules (reusing a cache built under a different
     *  PHP version silently drops symbols that need the newer parser). */
    lspPaths(phpVersion: string): Promise<{ storagePath: string; globalStoragePath: string }>;

    /**
     * Nuke Intelephense's persistent cache on disk. Call from the palette
     * when completions feel incomplete. The renderer should tear down and
     * recreate its `IntelephenseClient` after this resolves so the next
     * boot does a fresh full scan.
     */
    lspClearCache(): Promise<void>;

    /** App name / version / author / repo — powers the About page. */
    appInfo(): Promise<{
        name: string;
        version: string;
        author: string;
        homepage: string;
        license: string;
    }>;

    /** Absolute path to the per-user app data directory — shown in
     *  Settings so the user can locate their settings/projects/snippets
     *  files. Resolves per-OS via Electron's `app.getPath('userData')`. */
    appDataDir(): Promise<string>;

    /** Clean-restart the app. Used by "Clear cache" so Intelephense
     *  re-reads storage from scratch (it never re-reads after init). */
    appRelaunch(): Promise<void>;

    // --- AI (Ollama) — proxied through main to sidestep CORS --------------
    aiListModels(endpoint: string): Promise<{ models: string[]; error?: string }>;
    aiGenerate(
        endpoint: string,
        requestId: string,
        body: {
            model: string;
            prompt: string;
            suffix?: string;
            options?: { temperature?: number; num_predict?: number; stop?: string[] };
        },
    ): Promise<{ text: string | null; error?: string }>;
    aiAbort(requestId: string): Promise<void>;

    // Snippets — user's saved code library
    snippetsList(): Promise<Snippet[]>;
    snippetsSave(input: { id?: string; name: string; code: string }): Promise<Snippet>;
    snippetsDelete(id: string): Promise<void>;

    // Tab persistence — for restoreTabsOnLaunch
    tabsLoad(): Promise<PersistedTabs | null>;
    tabsSave(payload: PersistedTabs): Promise<void>;
}
