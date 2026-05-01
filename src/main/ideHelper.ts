import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Runs `composer require --dev barryvdh/laravel-ide-helper` followed by
 * `ide-helper:generate`, `ide-helper:models --nowrite`, and
 * `ide-helper:meta` inside the given Laravel project. Streams stdout/stderr
 * lines back via `onLine` per stage so the renderer can render a live log.
 *
 * We rely on the user's `composer` being on PATH. On Windows that's
 * typically `composer.bat` (Composer's installer drops a `.bat` shim);
 * on macOS/Linux it's a plain executable. {@link composerCommand} picks
 * the right shape per OS so Node's `spawn` doesn't ENOENT on the bare
 * `composer` name. The artisan commands are invoked with whatever PHP
 * binary the caller resolved for the project.
 *
 * `--nowrite` on `ide-helper:models` routes generated PHPDoc into
 * `_ide_helper_models.php` instead of rewriting the model classes themselves
 * — non-invasive, and still enough for Intelephense to pick up column and
 * relation types.
 *
 * Resolves `true` on success, `false` on the first non-zero exit. The caller
 * is responsible for surfacing the tail of the output on failure.
 */
export async function installIdeHelper(opts: {
    projectPath: string;
    phpBinary: string;
    onLine: (stage: Stage, line: string) => void;
}): Promise<{ ok: boolean; error?: string }> {
    const { projectPath, phpBinary, onLine } = opts;

    if (!fs.existsSync(path.join(projectPath, "artisan"))) {
        return { ok: false, error: `Not a Laravel project: ${projectPath}` };
    }

    const composerCmd = composerCommand();
    // `-W` (--with-all-dependencies) lets composer upgrade locked
    // transitives that otherwise block the install. Required for older
    // majors (Laravel 9 in particular) whose lockfiles pin specific
    // nikic/php-parser / doctrine/dbal versions that newer ide-helper
    // releases need to bump.
    const composer = await run({
        command: composerCmd,
        args: ["require", "--dev", "barryvdh/laravel-ide-helper", "-W", "--no-interaction"],
        cwd: projectPath,
        onLine: (line) => onLine("composer-require", line),
    });
    if (!composer.ok) {
        return { ok: false, error: composer.error ?? "composer require failed" };
    }

    const generate = await run({
        command: phpBinary,
        args: ["artisan", "ide-helper:generate", "--no-interaction"],
        cwd: projectPath,
        onLine: (line) => onLine("artisan-generate", line),
    });
    if (!generate.ok) {
        return { ok: false, error: generate.error ?? "ide-helper:generate failed" };
    }

    // `--nowrite` keeps generated PHPDoc in `_ide_helper_models.php` rather
    // than editing model files in place. If it fails (e.g. a broken DB
    // connection or a model that throws during reflection) we log and
    // continue — the facade stubs from `:generate` above are the big win.
    const models = await run({
        command: phpBinary,
        args: ["artisan", "ide-helper:models", "--nowrite", "--no-interaction"],
        cwd: projectPath,
        onLine: (line) => onLine("artisan-models", line),
    });
    if (!models.ok) {
        onLine("artisan-models", `(skipped — ${models.error ?? "failed"})`);
    }

    const meta = await run({
        command: phpBinary,
        args: ["artisan", "ide-helper:meta", "--no-interaction"],
        cwd: projectPath,
        onLine: (line) => onLine("artisan-meta", line),
    });
    if (!meta.ok) {
        onLine("artisan-meta", `(skipped — ${meta.error ?? "failed"})`);
    }

    return { ok: true };
}

export type Stage = "composer-require" | "artisan-generate" | "artisan-models" | "artisan-meta";

/**
 * Pick the executable name for Composer per OS. The Composer Windows
 * installer creates a `composer.bat` shim on PATH; Node's spawn won't
 * find a bare `composer` (no PATHEXT lookup without `shell: true`), so
 * we name the shim explicitly. On Unix `composer` is a plain executable.
 */
function composerCommand(): string {
    return process.platform === "win32" ? "composer.bat" : "composer";
}

/**
 * Spawn wrapper that splits stdout + stderr into lines and pushes each to
 * `onLine`. Buffers partial lines across chunks (composer paints progress
 * bars with CRs that would otherwise land mid-line).
 */
function run(opts: {
    command: string;
    args: string[];
    cwd: string;
    onLine: (line: string) => void;
}): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
        let stderrBuf = "";
        let stdoutBuf = "";
        let proc;
        try {
            proc = spawn(opts.command, opts.args, { cwd: opts.cwd });
        } catch (err) {
            resolve({ ok: false, error: (err as Error).message });
            return;
        }

        const pump = (chunk: Buffer, sink: "out" | "err"): void => {
            const text = chunk.toString("utf8").replace(/\r/g, "\n");
            const buf = sink === "out" ? stdoutBuf + text : stderrBuf + text;
            const parts = buf.split("\n");
            const tail = parts.pop() ?? "";
            if (sink === "out") stdoutBuf = tail;
            else stderrBuf = tail;
            for (const line of parts) {
                if (line.trim()) opts.onLine(line);
            }
        };

        proc.stdout?.on("data", (c: Buffer) => pump(c, "out"));
        proc.stderr?.on("data", (c: Buffer) => pump(c, "err"));
        proc.on("error", (err) => {
            const msg =
                (err as NodeJS.ErrnoException).code === "ENOENT"
                    ? `Command not found: ${opts.command}. Make sure it's installed and on your PATH.`
                    : err.message;
            resolve({ ok: false, error: msg });
        });
        proc.on("exit", (code) => {
            for (const line of [stdoutBuf, stderrBuf]) {
                if (line.trim()) opts.onLine(line);
            }
            if (code === 0) resolve({ ok: true });
            else resolve({ ok: false, error: `exit code ${code}` });
        });
    });
}
