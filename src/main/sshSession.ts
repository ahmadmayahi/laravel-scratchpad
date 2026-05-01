import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Client, ClientChannel, ConnectConfig } from "ssh2";
import { SshConfig, SshTestResult } from "../shared/ipc.js";
import { KnownHostsStore, fingerprintHostKey } from "./knownHosts.js";

/**
 * SSH worker transport.
 *
 * We use the `ssh2` npm package rather than spawning `/usr/bin/ssh`:
 *
 *   • Native password auth — OpenSSH's BatchMode refuses password
 *     prompts, and `sshpass` is a separate tool users would have to
 *     install. ssh2 handles password / key / passphrase / agent auth
 *     natively from a single API.
 *   • Cross-platform. Same code path on macOS, Windows (Pageant), and
 *     Linux — no shell quoting differences, no "does the user have ssh
 *     installed" worries.
 *   • Explicit host-key verification. We keep a JSON known-hosts file
 *     (`knownHosts.ts`) and enforce TOFU — ssh2 otherwise accepts any
 *     host key silently if no verifier is supplied.
 *   • No env-scrubbing for the ssh client process needed — we never
 *     spawn one, so shell vars never leak to the remote via SendEnv.
 *
 * The transport exposes an `SshWorkerProcess` that structurally matches
 * the subset of Node's `ChildProcess` that `runner.Session` uses
 * (stdin / stdout / stderr / on("exit") / kill()). `Session` takes a
 * `WorkerProcess` now, so local PHP workers and remote SSH workers are
 * handled by the exact same frame-parsing + cancel logic downstream.
 */

/** Structural type both ChildProcess and SshWorkerProcess satisfy. */
export interface WorkerProcess {
    readonly pid?: number;
    readonly stdin: NodeJS.WritableStream | null;
    readonly stdout: NodeJS.ReadableStream | null;
    readonly stderr: NodeJS.ReadableStream | null;
    on(event: "exit", listener: (code: number | null) => void): this;
    once(event: "exit", listener: (code: number | null) => void): this;
    kill(signal?: NodeJS.Signals | number): boolean | void;
}

/** Module-scoped trust store — shared across all SSH connections. */
const knownHosts = new KnownHostsStore();

/**
 * Spawn a remote `worker.php` over SSH. Returns a WorkerProcess that
 * looks-and-feels like a local child process to the rest of runner.ts.
 *
 * The returned process starts its connection handshake immediately;
 * stdin writes queue until the remote `sh` is exec'd and the setup
 * script has been delivered. Boot completion is signalled the same way
 * as a local worker (the PHP `ready` NDJSON frame on stdout), so the
 * Runner's `adoptChild` path works uniformly.
 */
export function spawnSshWorker(opts: {
    ssh: SshConfig;
    remotePath: string;
    workerContent: string;
    bootstrapContent?: string;
    /**
     * Plaintext password (for `authMode: "password"`) or key passphrase
     * (for `authMode: "key"`). Main.ts fetches this from the encrypted
     * secret store before calling us.
     */
    secret?: string;
}): WorkerProcess {
    validateSshConfig(opts.ssh);
    if (!opts.remotePath.startsWith("/") && !opts.remotePath.startsWith("~")) {
        throw new Error("Remote project path must be absolute (start with / or ~)");
    }
    if (opts.remotePath.includes("\0")) {
        throw new Error("Invalid remote project path");
    }

    const setup = buildSetupScript({
        remotePath: opts.remotePath,
        workerContent: opts.workerContent,
        bootstrapContent: opts.bootstrapContent,
    });
    return new SshWorkerProcess(opts.ssh, opts.secret, setup);
}

/**
 * Validate an SSH config from the renderer. Called both at `addSsh` time
 * (so bad configs never reach disk) and when spawning (so a crafted
 * `projects.json` can't short-circuit validation).
 */
export function validateSshConfig(ssh: SshConfig): void {
    if (!ssh || typeof ssh !== "object") throw new Error("SSH config is required");
    if (!ssh.host || typeof ssh.host !== "string") throw new Error("SSH host is required");
    if (ssh.host.length > 255) throw new Error("SSH host too long");
    if (ssh.host.startsWith("-")) throw new Error("SSH host may not start with '-'");
    // Letters, digits, dots, dashes, colons (IPv6), percent (zone id).
    // Deliberately narrow — no shell metacharacters (even though ssh2
    // doesn't use a shell to connect, this guards `projectPath` display
    // in UI tooltips etc.).
    if (!/^[A-Za-z0-9._:%-]+$/.test(ssh.host)) {
        throw new Error("SSH host contains invalid characters");
    }
    if (ssh.authMode !== "password" && ssh.authMode !== "key" && ssh.authMode !== "agent") {
        throw new Error("Unsupported SSH auth mode");
    }
    if (ssh.authMode === "password" && (!ssh.user || ssh.user.length === 0)) {
        throw new Error("Password auth requires a user");
    }
    if (ssh.user !== undefined) {
        if (typeof ssh.user !== "string") throw new Error("SSH user must be a string");
        if (ssh.user.startsWith("-")) throw new Error("SSH user may not start with '-'");
        if (!/^[A-Za-z0-9._-]+$/.test(ssh.user)) {
            throw new Error("SSH user contains invalid characters");
        }
    }
    if (ssh.port !== undefined) {
        if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535) {
            throw new Error("SSH port must be 1-65535");
        }
    }
    if (ssh.authMode === "key") {
        if (!ssh.identityFile || typeof ssh.identityFile !== "string") {
            throw new Error("Key auth requires a private key file");
        }
        if (!path.isAbsolute(ssh.identityFile)) {
            throw new Error("Private key path must be absolute");
        }
        if (!fs.existsSync(ssh.identityFile)) {
            throw new Error(`Private key not found: ${ssh.identityFile}`);
        }
    }
    if (
        ssh.strictHostKeyChecking !== undefined &&
        ssh.strictHostKeyChecking !== "yes" &&
        ssh.strictHostKeyChecking !== "accept-new"
    ) {
        throw new Error("strictHostKeyChecking must be 'yes' or 'accept-new'");
    }
}

/**
 * One-shot probe against an SSH target: connect, check that `php` is on
 * PATH, check the remote project directory exists, and report the remote
 * PHP version + whether the path looks like a Laravel project.
 *
 * Reuses the exact auth path `spawnSshWorker` would use, so a passing
 * probe is a realistic predictor of Run. Caps the whole round-trip at
 * 15 s.
 */
export async function testSshConnection(opts: {
    ssh: SshConfig;
    projectPath: string;
    secret?: string;
}): Promise<SshTestResult> {
    try {
        validateSshConfig(opts.ssh);
    } catch (err) {
        return { ok: false, error: (err as Error).message, stage: "unknown" };
    }
    if (!opts.projectPath || (!opts.projectPath.startsWith("/") && !opts.projectPath.startsWith("~"))) {
        return {
            ok: false,
            error: "Remote path must be absolute (start with / or ~)",
            stage: "no_path",
        };
    }
    if (opts.projectPath.includes("\0")) {
        return { ok: false, error: "Invalid remote path", stage: "no_path" };
    }

    const client = new Client();
    const config = buildConnectConfig(opts.ssh, opts.secret);

    return new Promise<SshTestResult>((resolve) => {
        let settled = false;
        const settle = (r: SshTestResult): void => {
            if (settled) return;
            settled = true;
            try {
                client.end();
            } catch {
                /* ignore */
            }
            resolve(r);
        };

        const timer = setTimeout(() => {
            settle({
                ok: false,
                error: "Connection timed out after 15 seconds — host unreachable or authentication hung.",
                stage: "timeout",
            });
        }, 15_000);
        timer.unref();

        client.once("error", (err: Error & { level?: string }) => {
            clearTimeout(timer);
            const stage = err.level === "client-authentication" ? "auth" : "connect";
            settle({ ok: false, error: err.message || String(err), stage });
        });

        client.once("ready", () => {
            client.exec(buildTestScript(opts.projectPath), (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    settle({ ok: false, error: err.message, stage: "connect" });
                    return;
                }
                let stdout = "";
                let stderr = "";
                stream.on("data", (chunk: Buffer) => {
                    stdout += chunk.toString("utf8");
                });
                stream.stderr.on("data", (chunk: Buffer) => {
                    stderr += chunk.toString("utf8");
                });
                stream.on("close", () => {
                    clearTimeout(timer);
                    const okMatch = stdout.match(/__LSP_TEST_OK__:(yes|no):([^\s]+)/);
                    if (okMatch) {
                        settle({
                            ok: true,
                            laravelDetected: okMatch[1] === "yes",
                            phpVersion: okMatch[2]!,
                        });
                        return;
                    }
                    const errMatch = stdout.match(/__LSP_TEST_ERR__:(\w+)/);
                    if (errMatch) {
                        const reason = errMatch[1]!;
                        settle({
                            ok: false,
                            error: errorMessageFor(reason, opts.projectPath),
                            stage: coerceStage(reason),
                        });
                        return;
                    }
                    const tail = stderr.trim().split(/\r?\n/).slice(-5).join("\n").trim();
                    settle({
                        ok: false,
                        error: tail || "remote script produced no output",
                        stage: "connect",
                    });
                });
            });
        });

        try {
            client.connect(config);
        } catch (err) {
            clearTimeout(timer);
            settle({ ok: false, error: (err as Error).message, stage: "connect" });
        }
    });
}

// ---------------------------------------------------------------------------
// Connection config — shared by spawnSshWorker + testSshConnection
// ---------------------------------------------------------------------------

/**
 * Assemble the ssh2 `ConnectConfig`, including the host-key verifier
 * that drives our TOFU trust model. Callers pass an already-decrypted
 * secret (password or passphrase) — the vault lookup is `main.ts`'s
 * responsibility.
 */
function buildConnectConfig(ssh: SshConfig, secret: string | undefined): ConnectConfig {
    const port = ssh.port ?? 22;
    const policy = ssh.strictHostKeyChecking ?? "accept-new";

    const config: ConnectConfig = {
        host: ssh.host,
        port,
        username: ssh.user,
        readyTimeout: 15_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        tryKeyboard: false,
        hostVerifier: (hostKey: Buffer, cb: (accept: boolean) => void) => {
            const fp = fingerprintHostKey(hostKey);
            const known = knownHosts.get(ssh.user, ssh.host, port);
            if (known) {
                cb(known === fp);
                return;
            }
            if (policy === "yes") {
                // Strict mode: refuse unknown host. The user needs to add
                // the fingerprint out-of-band (future: surface a dialog).
                cb(false);
                return;
            }
            // accept-new: trust on first use, persist for future checks.
            knownHosts.set(ssh.user, ssh.host, port, fp);
            cb(true);
        },
    };

    switch (ssh.authMode) {
        case "password":
            config.password = secret ?? "";
            break;
        case "key": {
            if (!ssh.identityFile) throw new Error("Key auth requires identityFile");
            config.privateKey = fs.readFileSync(ssh.identityFile);
            if (secret && secret.length > 0) config.passphrase = secret;
            break;
        }
        case "agent":
            // Use the running agent. On Windows, Pageant is the canonical
            // agent; ssh2 recognises the literal "pageant" string as that.
            // On Unix we hand it SSH_AUTH_SOCK from our own env.
            config.agent = process.platform === "win32" ? "pageant" : process.env.SSH_AUTH_SOCK;
            break;
    }

    return config;
}

// ---------------------------------------------------------------------------
// SshWorkerProcess — ChildProcess-shaped adapter around ssh2's Client
// ---------------------------------------------------------------------------

/**
 * Wraps an ssh2 `Client` + `ClientChannel` in a ChildProcess-compatible
 * shape so `runner.Session` doesn't need to know whether its worker is
 * local or remote. Boot looks like:
 *
 *   1. Construct — `client.connect()` begins immediately
 *   2. On "ready" — `client.exec("sh")` opens a channel
 *   3. Write the setup script — heredocs upload worker.php +
 *      bootstrap.php, then `exec php ...` flips stdio over to the PHP
 *      REPL
 *   4. `Session` now reads NDJSON frames from stdout the same way it
 *      would from a local spawn
 *
 * Any write before step 2 completes is buffered and flushed on ready —
 * callers don't need to wait.
 */
class SshWorkerProcess extends EventEmitter implements WorkerProcess {
    public readonly pid: number | undefined = undefined;
    // Lazily pointed at the ssh2 stream once it's exec'd; before that,
    // `stdinBuffer` captures writes and the "exit" path handles a
    // connection that died before we ever got to write anything.
    public stdin: NodeJS.WritableStream;
    public stdout: NodeJS.ReadableStream;
    public stderr: NodeJS.ReadableStream;

    private readonly client: Client;
    private channel: ClientChannel | null = null;
    private exited = false;
    private pendingWrites: Buffer[] = [];
    private pendingStdinEnded = false;

    // Pass-through streams that sit in front of the ssh2 channel. Before
    // the channel exists, data queues in `pendingWrites`; once the
    // channel opens, the buffer flushes and writes pass through directly.
    private readonly stdinPass: PassThrough;
    private readonly stdoutPass: PassThrough;
    private readonly stderrPass: PassThrough;

    constructor(ssh: SshConfig, secret: string | undefined, setupScript: string) {
        super();
        // Using Node's PassThrough to decouple the Session's consumers
        // from the ssh2 stream, which doesn't exist yet.
        this.stdinPass = new PassThrough();
        this.stdoutPass = new PassThrough();
        this.stderrPass = new PassThrough();
        this.stdin = this.stdinPass;
        this.stdout = this.stdoutPass;
        this.stderr = this.stderrPass;

        this.stdinPass.on("data", (chunk: Buffer | string) => {
            const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            if (this.channel) {
                this.channel.write(buf);
            } else {
                this.pendingWrites.push(buf);
            }
        });
        this.stdinPass.on("finish", () => {
            if (this.channel) this.channel.end();
            else this.pendingStdinEnded = true;
        });

        this.client = new Client();

        const signalExit = (code: number | null): void => {
            if (this.exited) return;
            this.exited = true;
            this.stdoutPass.end();
            this.stderrPass.end();
            this.emit("exit", code);
        };

        this.client.once("error", (err: Error & { level?: string }) => {
            // Surface the auth / connect error on stderr so Session's
            // boot-error synthesiser can include it in the user-facing
            // message. "level" tags OpenSSH-style categories for us.
            const label = err.level === "client-authentication" ? "SSH authentication failed: " : "SSH error: ";
            this.stderrPass.write(Buffer.from(label + (err.message || String(err)) + "\n", "utf8"));
            signalExit(1);
        });
        this.client.once("close", () => {
            signalExit(this.exited ? null : 0);
        });
        this.client.once("end", () => {
            signalExit(this.exited ? null : 0);
        });

        this.client.once("ready", () => {
            this.client.exec(setupScript, (err, stream) => {
                if (err) {
                    this.stderrPass.write(Buffer.from(`SSH exec failed: ${err.message}\n`, "utf8"));
                    signalExit(1);
                    return;
                }
                this.channel = stream;
                stream.on("data", (chunk: Buffer) => this.stdoutPass.write(chunk));
                stream.stderr.on("data", (chunk: Buffer) => this.stderrPass.write(chunk));
                stream.on("close", (code: number | null) => {
                    signalExit(code ?? null);
                });
                // Flush anything the caller buffered before we were ready.
                for (const buf of this.pendingWrites) stream.write(buf);
                this.pendingWrites = [];
                if (this.pendingStdinEnded) stream.end();
            });
        });

        // Fire off the connection. If this throws synchronously (invalid
        // config), the error bubbles up to the caller of spawnSshWorker.
        try {
            this.client.connect(buildConnectConfig(ssh, secret));
        } catch (err) {
            // Defer to the next tick so the caller can finish wiring up
            // listeners before we surface the failure.
            setImmediate(() => {
                this.stderrPass.write(Buffer.from(`SSH error: ${(err as Error).message}\n`, "utf8"));
                signalExit(1);
            });
        }
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        // Best effort: ssh2 supports the RFC signal request, but many
        // sshd configs reject it. Falling back to closing the channel /
        // connection causes the remote php to die on SIGPIPE, which our
        // synthetic-cancelled path in Session handles.
        try {
            const sig = typeof signal === "string" ? signal.replace(/^SIG/, "") : "TERM";
            this.channel?.signal?.(sig);
        } catch {
            /* ignore */
        }
        try {
            this.channel?.close();
        } catch {
            /* ignore */
        }
        try {
            this.client.end();
        } catch {
            /* ignore */
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// Remote scripts
// ---------------------------------------------------------------------------

/**
 * Compose the sh script that uploads worker.php + bootstrap.php via quoted
 * heredocs, then `exec`s php so stdio rolls over to the PHP worker.
 */
function buildSetupScript(opts: { remotePath: string; workerContent: string; bootstrapContent?: string }): string {
    const nonce = randomUUID().replace(/-/g, "").toUpperCase();
    const workerEof = `LSP_WORKER_${nonce}`;
    const bootstrapEof = `LSP_BOOTSTRAP_${nonce}`;
    if (opts.workerContent.includes(workerEof) || (opts.bootstrapContent?.includes(bootstrapEof) ?? false)) {
        throw new Error("heredoc delimiter collision — retry");
    }

    const quotedPath = shellQuote(opts.remotePath);

    // `LSP_DIR` is computed BEFORE the `cd` so both the heredoc uploads
    // and the final `exec php` reference absolute paths — otherwise
    // `.laravel-scratchpad/worker.php` would resolve against the project
    // dir after the cd, not $HOME.
    let script = "";
    script += "set -e\n";
    script += "umask 077\n";
    script += `LSP_DIR="$HOME/.laravel-scratchpad"\n`;
    script += `mkdir -p "$LSP_DIR"\n`;
    script += `cat > "$LSP_DIR/worker.php" <<'${workerEof}'\n`;
    script += opts.workerContent;
    if (!opts.workerContent.endsWith("\n")) script += "\n";
    script += `${workerEof}\n`;
    if (opts.bootstrapContent) {
        script += `cat > "$LSP_DIR/bootstrap.php" <<'${bootstrapEof}'\n`;
        script += opts.bootstrapContent;
        if (!opts.bootstrapContent.endsWith("\n")) script += "\n";
        script += `${bootstrapEof}\n`;
        script += `cd ${quotedPath}\n`;
        script += `exec php "$LSP_DIR/worker.php" "$LSP_DIR/bootstrap.php"\n`;
    } else {
        script += `cd ${quotedPath}\n`;
        script += `exec php "$LSP_DIR/worker.php"\n`;
    }
    return script;
}

function buildTestScript(remotePath: string): string {
    const qp = shellQuote(remotePath);
    return `
if ! command -v php >/dev/null 2>&1; then
    echo "__LSP_TEST_ERR__:no_php"
    exit 1
fi
if ! test -d ${qp} 2>/dev/null; then
    echo "__LSP_TEST_ERR__:no_path"
    exit 1
fi
cd ${qp} 2>/dev/null || { echo "__LSP_TEST_ERR__:no_path"; exit 1; }
LARAVEL=no
if [ -f artisan ] && [ -f bootstrap/app.php ]; then
    LARAVEL=yes
fi
PHPVER=$(php -r 'echo PHP_VERSION;' 2>/dev/null)
if [ -z "$PHPVER" ]; then
    echo "__LSP_TEST_ERR__:php_failed"
    exit 1
fi
echo "__LSP_TEST_OK__:$LARAVEL:$PHPVER"
`;
}

function errorMessageFor(reason: string, remotePath: string): string {
    switch (reason) {
        case "no_php":
            return "PHP is not on the remote PATH — install php-cli on the host, or set your shell to include it for non-interactive ssh sessions.";
        case "no_path":
            return `Remote path not found or unreadable: ${remotePath}`;
        case "not_laravel":
            return `Path exists but is not a Laravel project: ${remotePath}`;
        case "php_failed":
            return "Found `php` on PATH but it failed to report a version.";
        default:
            return `Probe failed: ${reason}`;
    }
}

function coerceStage(reason: string): Extract<SshTestResult, { ok: false }>["stage"] {
    type Stage = Extract<SshTestResult, { ok: false }>["stage"];
    const allowed: readonly Stage[] = [
        "connect",
        "auth",
        "no_php",
        "no_path",
        "not_laravel",
        "php_failed",
        "timeout",
        "unknown",
    ];
    return (allowed as readonly string[]).includes(reason) ? (reason as Stage) : "unknown";
}

/** POSIX single-quote escaping for shell interpolation. */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
