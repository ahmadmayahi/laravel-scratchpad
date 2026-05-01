/**
 * Cross-process URI canonicalisation. Both main (scratchFiles.ts) and
 * renderer (lspManager.ts) derive `file://…` URIs for scratch buffers;
 * drift between the two encodings means Intelephense and laravel-ls
 * would see the same buffer under different identifiers and diagnostics
 * would never land on the Monaco model.
 *
 * Kept in `shared/` and used by BOTH sides so there's exactly one source
 * of truth for what a scratch URI looks like. In particular:
 *   - Windows paths (`C:\Users\x`) normalise their backslashes before
 *     percent-encoding — previously main split on `path.sep` while the
 *     renderer split on `/`, yielding distinct URIs for the same file.
 *   - A leading `/` is prepended when the absolute path doesn't already
 *     start with one (Windows drive letters), so the `file://…` URI has
 *     the three-slash `file:///C:/…` shape LSP servers expect.
 */

const SCRATCH_DIR_SEGMENT = ".laravel-scratchpad";

/** Percent-encode a raw absolute filesystem path as a canonical `file://` URI. */
function pathToFileUri(absPath: string): string {
    // Windows paths use `\`; LSP/URI form wants `/`. Convert first so the
    // split below produces the correct segment boundaries regardless of
    // which side (main with `path.sep = "\"` vs renderer with `/`) built
    // the string.
    const normalized = absPath.replace(/\\/g, "/");
    const encoded = normalized.split("/").map(encodeURIComponent).join("/");
    const prefixed = encoded.startsWith("/") ? encoded : `/${encoded}`;
    return `file://${prefixed}`;
}

/** Canonical `file://` URI for a scratch buffer's on-disk materialisation. */
export function scratchFileUri(projectPath: string, tabId: string): string {
    const joined = `${projectPath.replace(/[/\\]+$/, "")}/${SCRATCH_DIR_SEGMENT}/tab-${tabId}.php`;
    return pathToFileUri(joined);
}
