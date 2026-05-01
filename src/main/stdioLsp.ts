import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Shared plumbing for any Language Server we spawn over stdio. Owns the
 * `Content-Length: N\r\n\r\n<JSON body>` framing loop + process lifecycle
 * — subclasses only supply the command, args, and env.
 *
 * Two concrete LSP servers extend this today: Intelephense (bundled as a
 * Node entry point and run through Electron's own Node) and laravel-ls
 * (a downloaded Go binary). Keeping the framer in one place is important
 * because the parser has a few non-obvious details — chunk coalescing,
 * buffer-growth cap, corrupt-header recovery — and duplicating them once
 * per server would guarantee drift.
 */
export class StdioJsonRpcServer extends EventEmitter {
    protected proc: ChildProcess | null = null;
    // Incoming bytes are buffered as a list of chunks and only concatenated
    // when we actually try to parse a frame — avoids the O(n²) cost of
    // `Buffer.concat([this.buffer, chunk])` on every data event.
    private chunks: Buffer[] = [];
    private bufferLen = 0;

    constructor(
        protected command: string | null,
        protected args: string[],
        protected env: NodeJS.ProcessEnv,
        protected label: string,
    ) {
        super();
    }

    /** Spawn the child. No-op if already running. Emits `error` and returns
     *  silently if the subclass decided the binary is unavailable (i.e.
     *  passed `command: null`) — callers shouldn't have to distinguish
     *  "binary missing" from "spawn failed". */
    async start(): Promise<void> {
        if (this.proc) return;
        if (!this.command) {
            this.emit("error", new Error(`${this.label}: binary not available`));
            return;
        }
        // Capture the spawned handle in a local so this generation's
        // listeners can identity-check against it in the `exit` handler
        // below. Without that check, a stop()+start() cycle where the
        // OLD subprocess's `exit` event arrives AFTER we've assigned
        // `this.proc = NEW` will run this handler with `this` pointing
        // at the current (new) server and unconditionally null out
        // `this.proc` — severing main's connection to the new
        // subprocess. Subsequent `send()` calls drop silently (the
        // pipe-closed guard fires on `proc === null`), and the new
        // client hangs waiting for an `initialize` response that
        // never comes. This is the ship-stopping race behind
        // "autocomplete breaks after Rebuild workspace index".
        const proc = spawn(this.command, this.args, {
            env: this.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = proc;

        proc.stdout?.on("data", (chunk) => this.onStdout(chunk as Buffer));
        proc.stderr?.on("data", (chunk) => {
            // Log everything the LSP writes to stderr. These servers are
            // chatty during indexing, but a heuristic filter would either
            // miss real problems that don't say "error"/"fatal" or mis-flag
            // benign lines that happen to mention those words.
            const text = chunk.toString().trim();
            if (text) console.warn(`[${this.label}-stderr]`, text);
        });
        // Silence EPIPE / stream errors on stdin. If the server dies, an
        // in-flight `send()` lands on a closed pipe and Node raises the
        // error asynchronously; without a listener Electron surfaces it
        // as an "unexpected error" dialog. `onExit` already handles the
        // restart/recovery path — we just need to keep the process from
        // crashing in the interim.
        proc.stdin?.on("error", (err) => {
            console.warn(`[${this.label}] stdin error:`, (err as NodeJS.ErrnoException).code ?? err);
        });
        proc.on("exit", (code) => {
            // Only propagate exits for the *current* generation. If `stop()`
            // already nulled `this.proc`, or `start()` replaced it with a
            // newer subprocess, this exit is stale — letting it through
            // would surface as a spurious "disconnected" at a fresh client
            // that subscribed after the old proc was killed.
            if (this.proc !== proc) return;
            this.proc = null;
            this.emit("exit", code);
        });
        proc.on("error", (err) => this.emit("error", err));
    }

    send(message: unknown): void {
        // `writable` flips to false the moment the child closes its stdin
        // (crash, natural exit, parent `end()`). `this.proc` is only nulled
        // on the async `exit` event, so there's a window where the handle
        // is non-null but the pipe is already gone — writing during that
        // window throws EPIPE. Gate on `writable` to drop cleanly.
        if (!this.proc?.stdin?.writable) return;
        const body = JSON.stringify(message);
        const bytes = Buffer.byteLength(body, "utf8");
        this.proc.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`, "utf8");
    }

    stop(): void {
        if (this.proc) {
            try {
                this.proc.stdin?.end();
            } catch {
                /* ignore */
            }
            this.proc.kill();
            this.proc = null;
        }
        // Drop any partially-buffered frame so a restart doesn't try to
        // resume mid-message.
        this.chunks = [];
        this.bufferLen = 0;
    }

    /** Whether the child is currently alive. */
    isRunning(): boolean {
        return this.proc !== null;
    }

    /**
     * If the server writes a corrupt stream (no `\r\n\r\n` terminator, no
     * valid `Content-Length`), the buffer would otherwise grow unboundedly
     * because we never drain it. Cap it and reset on overflow so the app
     * doesn't OOM from a misbehaving language server.
     */
    private static readonly MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

    private onStdout(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.bufferLen += chunk.length;
        if (this.bufferLen > StdioJsonRpcServer.MAX_BUFFER_BYTES) {
            console.error(
                `[${this.label}] buffer exceeded ${StdioJsonRpcServer.MAX_BUFFER_BYTES} bytes without a valid frame — resetting`,
            );
            this.chunks = [];
            this.bufferLen = 0;
            return;
        }
        while (true) {
            // Concat once per parse attempt (not per chunk) — the hot path
            // is a large payload delivered in many small reads, where the
            // original per-chunk concat was quadratic.
            const joined: Buffer =
                this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.bufferLen);
            const headerEnd = joined.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                if (this.chunks.length > 1) {
                    this.chunks = [joined];
                }
                return;
            }
            const header = joined.slice(0, headerEnd).toString("ascii");
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (!match) {
                // Corrupt header — skip past it and retry.
                const remainder = joined.slice(headerEnd + 4);
                this.chunks = remainder.length ? [remainder] : [];
                this.bufferLen = remainder.length;
                continue;
            }
            const bodyStart = headerEnd + 4;
            const bodyLength = Number(match[1]);
            if (joined.length < bodyStart + bodyLength) {
                if (this.chunks.length > 1) {
                    this.chunks = [joined];
                }
                return; // wait for more
            }
            const body = joined.slice(bodyStart, bodyStart + bodyLength).toString("utf8");
            const remainder = joined.slice(bodyStart + bodyLength);
            this.chunks = remainder.length ? [remainder] : [];
            this.bufferLen = remainder.length;
            try {
                const parsed = JSON.parse(body);
                this.emit("message", parsed);
            } catch (err) {
                console.error(`[${this.label}] JSON parse error:`, err);
            }
        }
    }
}
