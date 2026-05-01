import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, net } from "electron";
import { scrubbedEnv } from "./env.js";
import { StdioJsonRpcServer } from "./stdioLsp.js";
import type { LaravelLsProgress, LaravelLsStatus } from "../shared/ipc.js";

/**
 * laravel-ls — a Go-built Laravel language server that provides the
 * Laravel-specific completions Intelephense can't (route names, view
 * names, config keys, env keys, container bindings, translations,
 * assets). It's shipped as a platform-specific binary we download from
 * github on first run and cache forever under userData.
 *
 * Three concerns, deliberately separated:
 *   1. {@link LARAVEL_LS_VERSION} + {@link PLATFORM_ASSETS} — what to fetch
 *      and how to verify it. Pinning a single version + SHA-256 per platform
 *      is a defense in depth: we're about to execute whatever lands on disk.
 *   2. {@link LaravelLsManager} — download / verify / status state machine,
 *      driven from the renderer via IPC. Owns the download mutex so parallel
 *      `prepare()` calls collapse into one.
 *   3. {@link LaravelLsServer} — the running LSP child process, keyed off
 *      the downloaded binary. Constructed only after the binary is present.
 */

const LARAVEL_LS_VERSION = "v0.1.0";

interface PlatformAsset {
    /** Filename on the github release. */
    name: string;
    /** Pinned SHA-256 — refuses to execute a binary whose hash doesn't match. */
    sha256: string;
}

// Digests pulled from the GitHub releases API for v0.1.0. Bumping the
// version means also replacing these — there's no out-of-band channel for
// us to trust. A mismatch here means either the release asset was
// tampered with or the version constant drifted from the checksums.
const PLATFORM_ASSETS: Record<string, PlatformAsset | undefined> = {
    "darwin-arm64": {
        name: "laravel-ls-v0.1.0-darwin-arm64",
        sha256: "6d1efe1d82a7e65df6d68a6a34ab296751bfd00da93ede10166caae42ec79b52",
    },
    "darwin-x64": {
        name: "laravel-ls-v0.1.0-darwin-amd64",
        sha256: "2bafab3b7ddc785c9e1b3889b3f9ea7f337738c749021b4847df02971314d793",
    },
    "linux-x64": {
        name: "laravel-ls-v0.1.0-linux-amd64",
        sha256: "f47a25ac61c489240a766f12d77a7e60a1aed9eb0014ea6ac29628c51a16cde7",
    },
    "win32-x64": {
        name: "laravel-ls-v0.1.0-windows-amd64",
        sha256: "b572f761b191f93ff970bc37065960c76be07ac02fb103e9d6f401db0506c44c",
    },
};

function platformKey(): string {
    return `${process.platform}-${process.arch}`;
}

function currentAsset(): PlatformAsset | null {
    return PLATFORM_ASSETS[platformKey()] ?? null;
}

function binaryDir(): string {
    return path.join(app.getPath("userData"), "bin");
}

/** Where the pinned binary lives on disk — version-stamped so old copies
 *  from previous app releases sit harmlessly next to new ones instead of
 *  being overwritten in place (which would make rollback harder). */
function binaryPath(): string {
    const suffix = process.platform === "win32" ? ".exe" : "";
    return path.join(binaryDir(), `laravel-ls-${LARAVEL_LS_VERSION}${suffix}`);
}

/** Directory the LSP writes its log + config to. Carved out under our
 *  userData so it isn't polluting the user's `~/.local`. */
function basePath(): string {
    return path.join(app.getPath("userData"), "laravel-ls");
}

/** Fast liveness check — does the pinned binary exist with non-zero size?
 *  We deliberately don't rehash on every boot; the hash was verified at
 *  download time and the file sits under userData where we control writes. */
function isInstalled(): boolean {
    try {
        const stat = fs.statSync(binaryPath());
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

/**
 * Orchestrates the download / verify lifecycle and exposes a single
 * snapshot-able status to the renderer. One instance lives in `main.ts`.
 *
 * Callers drive it entirely through {@link prepare}: "make the binary
 * available, or tell me why you can't." Every state transition also emits
 * a `progress` event so the renderer can drive a live progress bar.
 *
 * The download is mutexed — parallel `prepare()` calls during the same
 * download wait on the same promise rather than racing two HTTP GETs.
 */
export class LaravelLsManager extends EventEmitter {
    private status: LaravelLsStatus = { state: "checking" };
    private inflight: Promise<LaravelLsStatus> | null = null;

    constructor() {
        super();
    }

    getStatus(): LaravelLsStatus {
        return this.status;
    }

    /** Resolve to a terminal status. Starts a download if needed. */
    prepare(): Promise<LaravelLsStatus> {
        if (this.inflight) return this.inflight;

        // Terminal states — just echo them back without retriggering work.
        // "skipped" is also terminal for this boot; the renderer can bypass
        // via {@link retry} if the user changes their mind.
        if (this.status.state === "ready" || this.status.state === "unsupported" || this.status.state === "skipped") {
            return Promise.resolve(this.status);
        }

        this.inflight = this.runPrepare().finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    /** Equivalent to {@link prepare} but forces a fresh attempt from an
     *  error or skipped state. */
    retry(): Promise<LaravelLsStatus> {
        if (this.status.state === "error" || this.status.state === "skipped") {
            this.setStatus({ state: "checking" });
        }
        return this.prepare();
    }

    /** User dismissed the download. Transitions to `skipped` immediately;
     *  any in-flight download is abandoned (the half-written `.tmp` file is
     *  left for the next retry's unlinkSync). */
    skip(): void {
        if (this.status.state === "ready") return; // nothing to skip
        this.setStatus({ state: "skipped" });
    }

    private async runPrepare(): Promise<LaravelLsStatus> {
        const asset = currentAsset();
        if (!asset) {
            this.setStatus({ state: "unsupported", platform: process.platform, arch: process.arch });
            return this.status;
        }

        if (isInstalled()) {
            this.setStatus({ state: "ready", version: LARAVEL_LS_VERSION });
            return this.status;
        }

        try {
            await this.downloadAsset(asset);
            this.setStatus({ state: "verifying", version: LARAVEL_LS_VERSION });
            // Digest was verified inside downloadAsset; this state is a
            // brief transitional display so users see that we actually
            // checked before executing.
            this.setStatus({ state: "ready", version: LARAVEL_LS_VERSION });
        } catch (err) {
            this.setStatus({ state: "error", message: (err as Error).message ?? String(err) });
        }
        return this.status;
    }

    private setStatus(next: LaravelLsStatus): void {
        this.status = next;
        this.emit("status", next);
    }

    private async downloadAsset(asset: PlatformAsset): Promise<void> {
        fs.mkdirSync(binaryDir(), { recursive: true });
        const finalPath = binaryPath();
        const tmpPath = `${finalPath}.${process.pid}.tmp`;

        // Clean up any leftover from a prior crashed download.
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            /* nothing to clean */
        }

        const url = `https://github.com/laravel-ls/laravel-ls/releases/download/${LARAVEL_LS_VERSION}/${asset.name}`;

        this.setStatus({
            state: "downloading",
            version: LARAVEL_LS_VERSION,
            received: 0,
            total: 0,
        });

        await downloadAndVerify({
            url,
            tmpPath,
            expectedSha256: asset.sha256,
            onProgress: (received, total) => {
                // Update status snapshot AND emit a progress event. Progress
                // events are the channel the renderer listens to for a
                // rapid-cadence progress bar; status is the coarser snapshot
                // the splash renders phases from.
                this.status = {
                    state: "downloading",
                    version: LARAVEL_LS_VERSION,
                    received,
                    total,
                };
                const ev: LaravelLsProgress = { version: LARAVEL_LS_VERSION, received, total };
                this.emit("progress", ev);
            },
        });

        // Atomic rename after hash verification. If we crash between
        // verify and rename, the next boot just redownloads — no bad
        // binary ever gets a valid filename.
        fs.renameSync(tmpPath, finalPath);
        if (process.platform !== "win32") {
            fs.chmodSync(finalPath, 0o755);
        }
    }
}

interface DownloadArgs {
    url: string;
    tmpPath: string;
    expectedSha256: string;
    onProgress: (received: number, total: number) => void;
}

/** Stream a URL to disk, verifying SHA-256 as we go. Throws on any
 *  non-200 response, network error, or digest mismatch. The caller is
 *  responsible for the atomic rename; we just produce a verified .tmp. */
async function downloadAndVerify(args: DownloadArgs): Promise<void> {
    const hash = createHash("sha256");
    let received = 0;
    let total = 0;

    await new Promise<void>((resolve, reject) => {
        // Electron's `net.request` respects system proxy settings and uses
        // Chromium's network stack — right choice for a user-facing app.
        // `redirect: "follow"` handles the github → objects.githubusercontent.com
        // bounce without us hand-rolling it.
        const req = net.request({ url: args.url, method: "GET", redirect: "follow" });

        req.on("response", (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`download failed: HTTP ${res.statusCode}`));
                return;
            }
            const header = res.headers["content-length"];
            const parsed = typeof header === "string" ? Number(header) : Array.isArray(header) ? Number(header[0]) : 0;
            if (Number.isFinite(parsed) && parsed > 0) total = parsed;

            const out = createWriteStream(args.tmpPath);
            let streamError: Error | null = null;
            out.on("error", (err) => {
                streamError = err;
                reject(err);
            });

            res.on("data", (chunk: Buffer) => {
                received += chunk.length;
                hash.update(chunk);
                out.write(chunk);
                args.onProgress(received, total);
            });
            res.on("end", () => {
                out.end();
                out.on("close", () => {
                    if (streamError) return; // already rejected
                    const digest = hash.digest("hex");
                    if (digest !== args.expectedSha256) {
                        try {
                            fs.unlinkSync(args.tmpPath);
                        } catch {
                            /* ignore */
                        }
                        reject(new Error(`checksum mismatch: got ${digest}, expected ${args.expectedSha256}`));
                        return;
                    }
                    resolve();
                });
            });
            res.on("error", (err: Error) => {
                try {
                    fs.unlinkSync(args.tmpPath);
                } catch {
                    /* ignore */
                }
                reject(err);
            });
        });
        req.on("error", (err) => {
            try {
                fs.unlinkSync(args.tmpPath);
            } catch {
                /* ignore */
            }
            reject(err);
        });
        req.end();
    });
}

/**
 * Hard-coded list of directories that commonly contain a `php` binary on
 * the running platform. Probed synchronously via `fs.statSync` (very
 * fast — no subprocess spawns), filtered to the ones that actually
 * exist. Prepended to laravel-ls's PATH so its internal
 * `exec.LookPath("php")` succeeds when the app is launched from the
 * Dock / Start Menu / .desktop file (which don't inherit the shell's
 * PATH, so Homebrew / Herd / asdf / Laragon / XAMPP are invisible by
 * default).
 */
function knownPhpBinDirs(): string[] {
    const home = os.homedir();
    const candidates: string[] = [];

    if (process.platform === "darwin") {
        candidates.push(
            "/opt/homebrew/bin", // Apple Silicon Homebrew
            "/usr/local/bin", // Intel Homebrew
            path.join(home, "Library/Application Support/Herd/bin"),
            path.join(home, ".asdf/shims"), // asdf shims — dispatch per-project version
            "/usr/bin", // system
        );
    } else if (process.platform === "win32") {
        const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
        const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData\\Local");
        const scoopRoot = process.env["SCOOP"] ?? path.join(home, "scoop");
        candidates.push(
            "C:\\xampp\\php",
            path.join(localAppData, "Herd", "bin"),
            path.join(programFiles, "PHP"),
            path.join(scoopRoot, "shims"),
            "C:\\laragon\\bin\\php", // Laragon root — versions live below
        );
    } else {
        // Linux + other Unixes.
        candidates.push(
            "/usr/bin",
            "/usr/local/bin",
            "/snap/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            path.join(home, ".linuxbrew/bin"),
            path.join(home, ".asdf/shims"),
            path.join(home, ".config/herd-lite/bin"),
        );
    }

    return candidates.filter((d) => {
        try {
            return fs.statSync(d).isDirectory();
        } catch {
            return false;
        }
    });
}

/**
 * Runs the downloaded laravel-ls binary as a stdio LSP. Must only be
 * constructed after {@link LaravelLsManager.prepare} resolves to
 * `state: "ready"` — constructing earlier is a programmer error (super's
 * `start()` will emit an error event and no-op).
 *
 * The caller passes an array of directories to prepend to PATH. laravel-ls
 * runs `exec.LookPath("php")` internally whenever it needs to load routes
 * / configs / bindings from the user's project, and Electron launched
 * from the macOS Dock doesn't inherit the shell's PATH (no Homebrew, no
 * Herd, no asdf) — so without this the server sees no PHP and every
 * completion falls back to an empty repository.
 */
export class LaravelLsServer extends StdioJsonRpcServer {
    constructor(extraPathDirs: string[] = []) {
        const bin = isInstalled() ? binaryPath() : null;
        fs.mkdirSync(basePath(), { recursive: true });

        const env = scrubbedEnv();
        const dirs = [...extraPathDirs, ...knownPhpBinDirs()];
        if (dirs.length > 0) {
            const sep = process.platform === "win32" ? ";" : ":";
            const existing = env.PATH ?? "";
            // Prepend — caller-supplied dirs win first, then our known
            // locations, then ambient PATH as a final fallback. Matches
            // the precedence the runner already uses for local projects.
            env.PATH = [...new Set([...dirs, existing].filter(Boolean))].join(sep);
        }

        // --basePath keeps the server's log / config under our userData
        // instead of `~/.local/laravel-ls`, which would be surprising for
        // users who never explicitly installed laravel-ls themselves.
        super(bin, ["--basePath", basePath()], env, "laravel-ls");
    }
}
