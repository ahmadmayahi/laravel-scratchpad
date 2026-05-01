import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { FramePayload, SshConfig } from "../shared/ipc.js";
import { scrubbedEnv } from "./env.js";
import { spawnSshWorker, type WorkerProcess } from "./sshSession.js";
import { appDataDir } from "./paths.js";

/**
 * Spawns and multiplexes long-lived `worker.php` processes. Each `start()`
 * / `startSsh()` returns a `Session` keyed by a uuid; calls to `exec()`
 * stream frames through an EventEmitter so the main process can forward
 * them to the renderer over IPC.
 */
export class Runner extends EventEmitter {
    private sessions = new Map<string, Session>();

    /** Spawn a local PHP worker. */
    async start(opts: {
        phpBinary: string;
        workerPath: string;
        bootstrapPath?: string;
        cwd?: string;
        /**
         * Extra env vars merged AFTER `scrubbedEnv()` so credential-shaped
         * names (DB_PASSWORD, etc.) survive the scrubber. The deliberate
         * `PostScrub` suffix documents the merge-order contract for
         * future readers — do NOT swap the spread order in `spawn()`.
         * Today's only caller is the Database connection injection for
         * bundled skeletons (see [./ipc/runner.ts](./ipc/runner.ts)).
         */
        extraEnvPostScrub?: NodeJS.ProcessEnv;
    }): Promise<Session> {
        const args: string[] = [opts.workerPath];
        if (opts.bootstrapPath) args.push(opts.bootstrapPath);
        const child = spawn(opts.phpBinary, args, {
            cwd: opts.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...scrubbedEnv(), ...(opts.extraEnvPostScrub ?? {}) },
        });
        return this.adoptChild(child);
    }

    /**
     * Spawn a remote worker over SSH. The child is an ssh(1) client whose
     * stdio has been rolled over (via remote `exec php`) to the PHP REPL.
     * Everything downstream — frame parsing, cancel, stop — is identical
     * to a local session.
     */
    async startSsh(opts: {
        ssh: SshConfig;
        remotePath: string;
        workerContent: string;
        bootstrapContent?: string;
        /** Plaintext secret — main.ts decrypts from the vault and passes it in. */
        secret?: string;
    }): Promise<Session> {
        const child = spawnSshWorker(opts);
        // SSH boot can be slow (DNS + handshake + remote heredoc parse).
        // Give it a longer boot window than a local spawn.
        return this.adoptChild(child, 60_000);
    }

    session(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    async stopAll(): Promise<void> {
        const sessions = Array.from(this.sessions.values());
        this.sessions.clear();
        await Promise.all(sessions.map((s) => s.stop()));
    }

    /**
     * Shared boot path: wrap the spawned child in a Session, wait for a
     * `ready` frame (or boot-error / timeout), and register in the map.
     * Both local and SSH paths funnel through here so behaviour stays in
     * sync.
     */
    private async adoptChild(child: WorkerProcess, bootTimeoutMs = 30_000): Promise<Session> {
        const session = new Session(randomUUID(), child, this);
        this.sessions.set(session.id, session);
        child.on("exit", () => this.sessions.delete(session.id));

        let timer: NodeJS.Timeout | undefined;
        const bootTimeout = new Promise<FramePayload>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`worker boot timed out after ${bootTimeoutMs}ms`)),
                bootTimeoutMs,
            );
        });
        try {
            const ready = await Promise.race([session.waitForBoot(), bootTimeout]);
            if (ready.type !== "ready") {
                throw new Error(`worker boot failed: ${JSON.stringify(ready)}`);
            }
            return session;
        } catch (err) {
            await session.stop();
            this.sessions.delete(session.id);
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

/**
 * Wraps a single long-lived worker process. Owns its stdin/stdout/stderr
 * and dispatches NDJSON frames back to the runner as typed events.
 */
export class Session {
    private buf = "";
    private readyFrame: FramePayload | null = null;
    private bootResolvers: Array<(f: FramePayload) => void> = [];
    // Tracks the currently-executing request so that if the worker dies
    // mid-run (e.g. SIGINT + no pcntl, or an OOM segfault, or an SSH
    // disconnect) we can synthesize a terminal frame for the renderer.
    // Without this the tab's `isRunning` flag would never flip back.
    private activeRequestId: string | null = null;
    private activeRequestTimer: NodeJS.Timeout | null = null;
    private cancelRequested = false;
    // Buffered stderr during the pre-ready window. If the child exits
    // before emitting ready we surface the tail of this buffer in the
    // error message — critical for SSH, where the real cause ("Permission
    // denied", "php: command not found", "cd: /foo: No such file or
    // directory") arrives on stderr and would otherwise be lost. Capped
    // so a chatty MOTD can't OOM us.
    private bootStderrChunks: string[] = [];
    private bootStderrBytes = 0;
    private static readonly BOOT_STDERR_CAP = 4096;

    constructor(
        public readonly id: string,
        private readonly child: WorkerProcess,
        private readonly runner: Runner,
    ) {
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            if (!this.readyFrame && this.bootStderrBytes < Session.BOOT_STDERR_CAP) {
                const remaining = Session.BOOT_STDERR_CAP - this.bootStderrBytes;
                const trimmed = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
                this.bootStderrChunks.push(trimmed);
                this.bootStderrBytes += trimmed.length;
            }
            this.runner.emit("stderr", { sessionId: this.id, chunk });
        });
        child.on("exit", () => {
            // Drain any still-waiting boot resolver so `start()` rejects
            // instead of hanging forever on a dead child. Covers both
            // local worker segfaults and ssh failures (auth denied,
            // host unreachable, remote php missing).
            if (!this.readyFrame && this.bootResolvers.length) {
                const tail = this.bootStderrChunks.join("").trim().split(/\r?\n/).slice(-5).join("\n").trim();
                const err: FramePayload = {
                    type: "error",
                    id: "boot",
                    class: "WorkerExited",
                    message: tail
                        ? `worker exited before emitting ready:\n${tail}`
                        : "worker exited before emitting ready (no stderr)",
                    trace: [],
                };
                for (const r of this.bootResolvers) r(err);
                this.bootResolvers = [];
            }
            if (this.activeRequestTimer) {
                clearTimeout(this.activeRequestTimer);
                this.activeRequestTimer = null;
            }
            // If a cancel was pending, the worker may have died from SIGINT
            // with no pcntl handler installed — or the ssh client was
            // killed mid-run. Synthesize a `cancelled` frame so the
            // renderer's tab can leave the "running" state.
            if (this.cancelRequested && this.activeRequestId) {
                this.runner.emit("frame", {
                    sessionId: this.id,
                    requestId: this.activeRequestId,
                    type: "cancelled",
                    id: this.activeRequestId,
                });
                this.activeRequestId = null;
                this.cancelRequested = false;
                return;
            }
            // Unexpected mid-request exit without a cancel — worker OOM,
            // segfault, or SSH connection drop. Without a synthetic error
            // frame the tab's `isRunning` flag would never clear; the
            // user would stare at a spinning tab dot that never resolves.
            // Tail the collected stderr so the user sees WHY it died.
            if (this.activeRequestId) {
                const tail = this.bootStderrChunks.join("").trim().split(/\r?\n/).slice(-5).join("\n").trim();
                this.runner.emit("frame", {
                    sessionId: this.id,
                    requestId: this.activeRequestId,
                    type: "error",
                    id: this.activeRequestId,
                    class: "WorkerExited",
                    message: tail ? `worker exited during request:\n${tail}` : "worker exited during request",
                    trace: [],
                });
                this.activeRequestId = null;
            }
        });
    }

    get pid(): number | undefined {
        return this.child.pid;
    }
    get phpVersion(): string {
        // readyFrame is typed as the full FramePayload discriminated union;
        // only the `ready` variant carries `php`, so narrow before reading.
        return this.readyFrame?.type === "ready" ? this.readyFrame.php : "?";
    }

    /// Write one NDJSON request to stdin. Returns the requestId so the
    /// caller can route frames.
    exec(code: string, timeoutMs = 30_000): string {
        const id = randomUUID();
        this.activeRequestId = id;
        this.cancelRequested = false;
        if (this.activeRequestTimer) clearTimeout(this.activeRequestTimer);
        // Main-side watchdog. The worker passes `timeout_ms` through to its
        // own PHP execution limit, but if the worker ignores it (stuck in a
        // C extension, SSH channel silently dead) the session's
        // `isRunning` flag would never clear. Main's timer fires with a
        // small grace window over the worker's own limit, synthesizes an
        // error frame, then asks the worker to cancel (SIGINT → channel
        // close for SSH).
        const grace = 5_000;
        this.activeRequestTimer = setTimeout(() => {
            this.activeRequestTimer = null;
            if (this.activeRequestId !== id) return;
            this.runner.emit("frame", {
                sessionId: this.id,
                requestId: id,
                type: "error",
                id,
                class: "TimeoutError",
                message: `execution exceeded ${timeoutMs}ms timeout`,
                trace: [],
            });
            this.activeRequestId = null;
            this.cancel();
        }, timeoutMs + grace);
        this.activeRequestTimer.unref();
        this.child.stdin?.write(JSON.stringify({ id, code, timeout_ms: timeoutMs }) + "\n");
        return id;
    }

    cancel(): void {
        this.cancelRequested = true;
        // SIGINT for local workers: worker.php installs a pcntl handler
        // that catches this and emits a `cancelled` frame.
        // For SSH workers: tries an ssh2 RFC signal request first; most
        // sshd configs reject it, so SshWorkerProcess.kill falls back to
        // tearing the channel down — the synthetic-cancelled path in
        // child.on("exit") covers the user-visible tab state either way.
        try {
            this.child.kill("SIGINT");
        } catch {
            /* best effort */
        }
    }

    stop(): Promise<void> {
        this.child.stdin?.end();
        return new Promise((resolve) => {
            this.child.once("exit", () => resolve());
            this.child.kill();
            // Failsafe — if it didn't die, move on anyway.
            setTimeout(resolve, 1000).unref();
        });
    }

    waitForBoot(): Promise<FramePayload> {
        if (this.readyFrame) return Promise.resolve(this.readyFrame);
        return new Promise((resolve) => {
            this.bootResolvers.push(resolve);
        });
    }

    private onStdout(chunk: string): void {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, idx).trim();
            this.buf = this.buf.slice(idx + 1);
            if (!line) continue;
            let frame: FramePayload;
            try {
                frame = JSON.parse(line) as FramePayload;
            } catch {
                continue;
            }
            this.dispatch(frame);
        }
    }

    private dispatch(frame: FramePayload): void {
        if (frame.type === "ready" && !this.readyFrame) {
            this.readyFrame = frame;
            // Free the boot-stderr buffer — we won't need it again.
            this.bootStderrChunks = [];
            this.bootStderrBytes = 0;
            for (const r of this.bootResolvers) r(frame);
            this.bootResolvers = [];
            return;
        }
        if (frame.type === "error" && frame.id === "boot" && !this.readyFrame) {
            // Boot failure — resolve waiters with the error so the caller can throw.
            for (const r of this.bootResolvers) r(frame);
            this.bootResolvers = [];
            return;
        }
        // A terminal frame for the active request clears our in-flight
        // tracking so the child.on("exit") synth path doesn't double-fire.
        if (frame.type === "result" || frame.type === "error" || frame.type === "cancelled") {
            if (this.activeRequestId === frame.id) {
                this.activeRequestId = null;
                if (this.activeRequestTimer) {
                    clearTimeout(this.activeRequestTimer);
                    this.activeRequestTimer = null;
                }
            }
            this.cancelRequested = false;
        }
        this.runner.emit("frame", { sessionId: this.id, requestId: frame.id, ...frame });
    }
}

/// Returns the path to worker.php, unpacking it out of the app resources
/// to a writable temp location if needed so PHP can `require` it.
export function workerScriptPath(): string {
    const packaged = path.join(process.resourcesPath ?? "", "resources", "worker.php");
    if (fs.existsSync(packaged)) return packaged;
    // Dev: live file.
    const dev = path.resolve(__dirname, "../../resources/worker.php");
    if (fs.existsSync(dev)) return dev;
    throw new Error(`worker.php not found (looked in ${packaged} and ${dev})`);
}

/**
 * Read `worker.php` into a string so we can ship it to a remote host over
 * ssh. Used by the SSH path — the local path `require`s it directly.
 */
export function workerScriptContent(): string {
    return fs.readFileSync(workerScriptPath(), "utf8");
}

/// Writes a per-project Laravel bootstrap file and returns its path.
export function writeLaravelBootstrap(projectPath: string): string {
    if (!path.isAbsolute(projectPath)) {
        throw new Error(`writeLaravelBootstrap: projectPath must be absolute (got ${JSON.stringify(projectPath)})`);
    }
    const dir = appDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const hash = createHash("sha1").update(projectPath).digest("hex").slice(0, 16);
    const target = path.join(dir, `laravel-bootstrap-${hash}.php`);
    fs.writeFileSync(target, buildLaravelBootstrap(projectPath), "utf8");
    return target;
}

/**
 * Render the Laravel bootstrap PHP source. Shared by the local path
 * (written to disk and passed as argv[1]) and the SSH path (uploaded to
 * the remote via a heredoc).
 */
export function buildLaravelBootstrap(projectPath: string): string {
    // PHP single-quoted strings recognize only `\\` and `\'`. Escape both
    // so a path containing a literal backslash can't close the string
    // early and inject code.
    //
    // Threat model: `projectPath` here is user-supplied (folder picker or
    // `projects.json`) but the picker already constrains it to an
    // existing directory and the SSH path is rejected upstream. The
    // escaping below is the second line of defence in case either guard
    // regresses — a crafted path containing `'` or `\` without this
    // would otherwise terminate the PHP string literal and execute
    // arbitrary code against the user's Laravel project on the next run.
    // Any future change to how projectPath is handled MUST preserve the
    // property that only `\\` and `'` need escaping for PHP '…' literals.
    const escaped = String(projectPath).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    // Wrap the autoload require with a scoped error handler that swallows
    // Composer's platform-version `trigger_error(E_USER_ERROR)` out of
    // `vendor/composer/platform_check.php`. This lets the user force-run
    // against a PHP that doesn't satisfy the project's `require.php`
    // constraint.
    //
    // Laravel's kernel bootstrap runs every registered service provider's
    // boot() in sequence. A single misbehaving provider otherwise aborts
    // the whole worker. We catch the bootstrap throw and write a one-line
    // warning to STDERR; the worker continues running with a partially
    // bootstrapped Laravel — some features may be broken, but the REPL is
    // usable.
    return `<?php
chdir('${escaped}');
set_error_handler(static function (int $errno, string $errstr, string $errfile): bool {
    if ($errno === E_USER_ERROR && str_contains($errfile, '/vendor/composer/platform_check.php')) {
        return true; // swallow — continue past Composer's platform check
    }
    return false;
});
require '${escaped}/vendor/autoload.php';
restore_error_handler();
$app = require_once '${escaped}/bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);
try {
    $kernel->bootstrap();
} catch (\\Throwable $bootErr) {
    fwrite(STDERR, "[laravel-bootstrap] partial-boot: " . get_class($bootErr) . ": " . $bootErr->getMessage() . "\\n");
    // Keep going — user code can still run against whatever providers did
    // successfully boot before the throw.
}
`;
}
