/**
 * Replace the leading `<homedir>` segment of an absolute path with `~`,
 * matching the convention shells use to keep output readable.
 *
 * Handles all three OS shapes the renderer might encounter:
 *   - macOS:   /Users/<name>/...           → ~/...
 *   - Linux:   /home/<name>/...            → ~/...
 *   - Windows: C:\Users\<name>\...         → ~\...
 *   - Windows (forward slashes from a *nix-shaped trace): /c/Users/...
 *
 * Trace frames in the result pane can come from EITHER the local
 * Laravel project (matching the client's OS shape) OR an SSH project
 * (typically Linux/macOS shape regardless of client). Compressing both
 * shapes everywhere is cheap and removes the per-OS branching.
 */
export function compressHome(p: string): string {
    return p.replace(/^(?:\/Users|\/home)\/[^/]+/, "~").replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, "~");
}

/**
 * Try to parse `raw` as JSON, but only when it looks like a JSON
 * container (object or array). Bare primitives — `"hello"`, `42`,
 * `true` — technically parse, but rendering them as a "JSON tree" has
 * no user-facing benefit over just showing the string, and flipping
 * every echoed string into a JSON node would be noisy.
 *
 * Returns the parsed value on success, `undefined` otherwise. Never
 * throws.
 */
export function tryParseJsonContainer(raw: string): unknown | undefined {
    const trimmed = raw.trim();
    if (trimmed.length < 2) return undefined;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const looksLikeContainer = (first === "{" && last === "}") || (first === "[" && last === "]");
    if (!looksLikeContainer) return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        // Extra guard: `JSON.parse('"{}"')` returns the string `"{}"`
        // — we want real containers only.
        if (parsed !== null && (Array.isArray(parsed) || typeof parsed === "object")) {
            return parsed;
        }
    } catch {
        /* not JSON */
    }
    return undefined;
}
