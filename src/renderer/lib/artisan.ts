/**
 * Shared helpers for the artisan runner — used by both the modal
 * (ArtisanDialog) and the always-visible toolbar input (ArtisanInput).
 *
 * The "PHP wrapper" approach keeps us off a dedicated IPC handler: the
 * Laravel worker already has the framework bootstrapped, so we synthesize
 * a Symfony BufferedOutput + console-kernel call and pipe the result back
 * through the standard runner stdout pipeline.
 */

const HISTORY_KEY = "lsp.artisan-history";
const HISTORY_MAX = 20;

/**
 * Wraps the user's command in a console-kernel call so the artisan output
 * comes back as a single stdout chunk via our standard frame pipeline. The
 * command is escaped for PHP single-quoted strings (backslashes first, then
 * quotes — order matters) and passed as the first argument to `$kernel->call()`.
 *
 * No comment header: any command containing a PHP end-of-comment sequence
 * would otherwise garble the generated source.
 */
export function synthesizeArtisanCode(command: string): string {
    const escaped = command.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `
$__out = new \\Symfony\\Component\\Console\\Output\\BufferedOutput();
$__kernel = app(\\Illuminate\\Contracts\\Console\\Kernel::class);
$__exitCode = $__kernel->call('${escaped}', [], $__out);
echo $__out->fetch();
if ($__exitCode !== 0) { fwrite(STDERR, "artisan exit code: $__exitCode\\n"); }
`;
}

export function loadArtisanHistory(): string[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch {
        return [];
    }
}

export function saveArtisanHistory(entries: string[]): void {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
    } catch {
        // localStorage may be disabled or full — best-effort.
    }
}

/** Push a command to the front, dedupe, cap to HISTORY_MAX, persist. Returns
 *  the new list so callers can update reactive state in one shot. */
export function recordArtisanCommand(prev: string[], command: string): string[] {
    const trimmed = command.trim();
    if (!trimmed) return prev;
    const next = [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, HISTORY_MAX);
    saveArtisanHistory(next);
    return next;
}
