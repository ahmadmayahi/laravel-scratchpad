import * as fs from "node:fs";
import * as path from "node:path";
import { scratchFileUri as sharedScratchFileUri } from "../shared/uri.js";

/**
 * Materialises scratch buffers to disk inside the user's Laravel project.
 *
 * laravel-ls reads files from the filesystem on `didOpen` — giving it a
 * purely in-memory URI just returns "file not opened" on every subsequent
 * request. We work around that by writing each scratch tab to
 * `<projectPath>/.laravel-scratchpad/tab-<tabId>.php`, keeping the URI
 * and on-disk path in sync. A `.gitignore` dropped alongside the files
 * means users never accidentally commit them.
 *
 * The Monaco in-memory model remains the source of truth for Intelephense
 * (which accepts synthetic URIs fine) and for the editor itself. The disk
 * file is a one-way mirror, rewritten on every change.
 */

const SCRATCH_DIR = ".laravel-scratchpad";

/** Reject tab ids that contain anything but alphanumerics, dashes, and
 *  underscores. Belt-and-braces against path traversal — the id comes from
 *  the renderer via IPC, where we can't trust it on shape alone. The
 *  resulting filename is `tab-<id>.php`, so the regex also implicitly
 *  rules out Windows-forbidden chars (`<>:"/\|?*`), control bytes, and
 *  DOS reserved names (CON, PRN, NUL, AUX, COM1…) since none of those
 *  match `[A-Za-z0-9_-]+`. */
const SAFE_TAB_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeTabId(tabId: string): void {
    if (!SAFE_TAB_ID.test(tabId)) {
        throw new Error(`Unsafe tab id: ${tabId}`);
    }
}

function scratchDirFor(projectPath: string): string {
    return path.join(projectPath, SCRATCH_DIR);
}

function scratchFilePath(projectPath: string, tabId: string): string {
    assertSafeTabId(tabId);
    return path.join(scratchDirFor(projectPath), `tab-${tabId}.php`);
}

/** Encode an absolute filesystem path as a `file://` URI. Delegates to the
 *  shared encoder so renderer and main produce byte-identical URIs — a
 *  prior platform-dependent split (main on `path.sep`, renderer on `/`)
 *  drifted on Windows and made Intelephense + laravel-ls see distinct
 *  documents for the same buffer. */
export function scratchFileUri(projectPath: string, tabId: string): string {
    assertSafeTabId(tabId);
    return sharedScratchFileUri(projectPath, tabId);
}

/**
 * Write `content` to the scratch file for this tab, creating the scratch
 * directory + `.gitignore` on first use. Overwrites any prior content.
 * Throws if the project path doesn't exist (the user would have had to
 * delete it mid-session — bail noisily rather than silently miscreate).
 */
export function writeScratchFile(projectPath: string, tabId: string, content: string): string {
    assertSafeTabId(tabId);
    if (!fs.existsSync(projectPath)) {
        throw new Error(`Project path no longer exists: ${projectPath}`);
    }
    const dir = scratchDirFor(projectPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        // Drop a `.gitignore` the first time we touch this dir. Ignoring
        // the whole dir, not just *.php, so the .gitignore itself is
        // ignored (self-contained) and users don't see a diff in their
        // project from us.
        fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", "utf8");
    }
    const target = path.join(dir, `tab-${tabId}.php`);
    fs.writeFileSync(target, content, "utf8");
    return target;
}

/** Remove a single tab's scratch file. Silent when it's already missing
 *  so repeat cleanups are safe. */
export function deleteScratchFile(projectPath: string, tabId: string): void {
    assertSafeTabId(tabId);
    const target = scratchFilePath(projectPath, tabId);
    try {
        fs.unlinkSync(target);
    } catch {
        /* already gone */
    }
}
