import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PhpVersionInfo } from "../shared/ipc.js";

const execFileP = promisify(execFile);

const LSP_PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4", "8.5"] as const;

type LspPhpVersion = (typeof LSP_PHP_VERSIONS)[number];

const lspPhpVersionSet = new Set<string>(LSP_PHP_VERSIONS);

export function normalizeLspPhpVersion(input: unknown): LspPhpVersion | "unknown" {
    if (typeof input !== "string") return "unknown";
    const [major, minor] = input.split(".");
    const normalized = `${major}.${minor}`;
    return lspPhpVersionSet.has(normalized) ? (normalized as LspPhpVersion) : "unknown";
}

/// Discovers PHP CLI binaries across the common managers on each
/// supported platform. Skips fpm/cgi/phar variants that return usage
/// text instead of a version.
export async function discoverPhpVersions(customPaths: string[] = []): Promise<PhpVersionInfo[]> {
    const candidates: Array<{ path: string; source: PhpVersionInfo["source"] }> = [];

    const add = (p: string, source: PhpVersionInfo["source"]) => {
        try {
            if (fs.statSync(p).isFile() && !isNonCli(p)) {
                candidates.push({ path: p, source });
            }
        } catch {
            /* skip */
        }
    };

    for (const c of platformCandidates()) add(c.path, c.source);
    for (const p of customPaths) add(p, "Custom");

    // Probe in parallel — sequential `await execFileP` was ~50 ms × N
    // candidates, which added noticeable latency every time Settings opened.
    const results = await Promise.all(
        candidates.map(async ({ path: p, source }) => {
            const v = await probe(p);
            return v ? { path: p, version: v, source } : null;
        }),
    );
    const probed: PhpVersionInfo[] = results.filter((r): r is PhpVersionInfo => r !== null);

    // Dedupe by resolved real path: collapses symlinks (e.g. /opt/homebrew/bin/php →
    // /opt/homebrew/Cellar/php/.../bin/php) AND the same file surfaced twice because its
    // directory is both a dedicated source (Homebrew, Herd, asdf) and on $PATH.
    const priority: Record<PhpVersionInfo["source"], number> = {
        Homebrew: 0,
        asdf: 1,
        Herd: 2,
        System: 3,
        Custom: 4,
    };
    const byReal = new Map<string, PhpVersionInfo>();
    for (const v of probed) {
        const key = realpath(v.path);
        const existing = byReal.get(key);
        if (!existing || priority[v.source] < priority[existing.source]) byReal.set(key, v);
    }
    return [...byReal.values()].sort((a, b) => {
        if (a.version !== b.version) return b.version.localeCompare(a.version, undefined, { numeric: true });
        return priority[a.source] - priority[b.source];
    });
}

interface Candidate {
    path: string;
    source: PhpVersionInfo["source"];
}

/**
 * Per-OS list of well-known php install locations to probe. Augmented at
 * the end by every directory on PATH, which is the right answer for the
 * long tail (chocolatey shims, scoop, custom installs, sudo make install,
 * snap exposes /snap/bin, etc.).
 */
function platformCandidates(): Candidate[] {
    if (process.platform === "win32") return windowsCandidates();
    if (process.platform === "darwin") return macCandidates();
    return linuxCandidates();
}

function macCandidates(): Candidate[] {
    const home = os.homedir();
    const out: Candidate[] = [];

    // Homebrew — both Apple Silicon and Intel prefixes, plus per-version
    // formulas (`php@8.3`).
    for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
        for (const formula of ["php", ...phpFormulaNames()]) {
            out.push({ path: `${prefix}/${formula}/bin/php`, source: "Homebrew" });
        }
    }
    out.push({ path: "/opt/homebrew/bin/php", source: "Homebrew" });
    out.push({ path: "/usr/local/bin/php", source: "Homebrew" });

    // asdf
    const asdfRoot = path.join(home, ".asdf/installs/php");
    for (const v of safeReaddir(asdfRoot)) {
        out.push({ path: `${asdfRoot}/${v}/bin/php`, source: "asdf" });
    }

    // Herd
    const herdBin = path.join(home, "Library/Application Support/Herd/bin");
    for (const e of safeReaddir(herdBin)) {
        if (e.startsWith("php")) out.push({ path: `${herdBin}/${e}`, source: "Herd" });
    }

    out.push({ path: "/usr/bin/php", source: "System" });
    out.push(...pathSearch("php"));
    return out;
}

function linuxCandidates(): Candidate[] {
    const home = os.homedir();
    const out: Candidate[] = [];

    // Distro packages (`php`, `php8.3`, `php8.4`…) typically install into
    // /usr/bin; sury / Ondrej PPA on Debian/Ubuntu and software-collections
    // on RHEL also drop versioned binaries here.
    out.push({ path: "/usr/bin/php", source: "System" });
    for (const formula of phpFormulaNames()) {
        out.push({ path: `/usr/bin/${formula}`, source: "System" });
    }

    // Manual builds typically land here.
    out.push({ path: "/usr/local/bin/php", source: "System" });

    // snap exposes binaries via /snap/bin (the snap manager itself adds
    // this to PATH for graphical apps via /etc/profile.d, but Electron
    // launched from a desktop file may not see it).
    out.push({ path: "/snap/bin/php", source: "System" });

    // Homebrew on Linux installs to /home/linuxbrew/.linuxbrew
    for (const prefix of ["/home/linuxbrew/.linuxbrew/bin", path.join(home, ".linuxbrew/bin")]) {
        out.push({ path: `${prefix}/php`, source: "Homebrew" });
    }

    // asdf
    const asdfRoot = path.join(home, ".asdf/installs/php");
    for (const v of safeReaddir(asdfRoot)) {
        out.push({ path: `${asdfRoot}/${v}/bin/php`, source: "asdf" });
    }

    // Herd Linux installs under Application Support inside the user's
    // home, mirroring the macOS layout.
    const herdLinux = path.join(home, ".config/herd-lite/bin");
    for (const e of safeReaddir(herdLinux)) {
        if (e.startsWith("php")) out.push({ path: `${herdLinux}/${e}`, source: "Herd" });
    }

    out.push(...pathSearch("php"));
    return out;
}

function windowsCandidates(): Candidate[] {
    const home = os.homedir();
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData\\Local");
    const out: Candidate[] = [];

    // XAMPP — most common Apache+MySQL+PHP stack on Windows. Standard
    // installer drops it at C:\xampp\php\php.exe; corporate machines
    // sometimes choose a different drive but the structure stays the same.
    for (const root of ["C:\\xampp", "D:\\xampp", path.join(programFiles, "xampp")]) {
        out.push({ path: path.join(root, "php", "php.exe"), source: "System" });
    }

    // Laragon — popular alternative. `php-X.Y` per-version dirs under
    // C:\laragon\bin\php\.
    for (const root of ["C:\\laragon", "D:\\laragon"]) {
        const php = path.join(root, "bin", "php");
        out.push({ path: path.join(php, "php.exe"), source: "System" });
        for (const v of safeReaddir(php)) {
            out.push({ path: path.join(php, v, "php.exe"), source: "System" });
        }
    }

    // Herd for Windows installs to %LOCALAPPDATA%\Herd\bin and ships
    // versioned binaries (php-8.3.exe, php-8.4.exe, ...).
    const herdBin = path.join(localAppData, "Herd", "bin");
    for (const e of safeReaddir(herdBin)) {
        if (e.toLowerCase().startsWith("php") && e.toLowerCase().endsWith(".exe")) {
            out.push({ path: path.join(herdBin, e), source: "Herd" });
        }
    }

    // WAMP — wampserver puts PHP binaries under C:\wamp[64]\bin\php\php-X.Y.Z\.
    for (const root of ["C:\\wamp64", "C:\\wamp"]) {
        const phpRoot = path.join(root, "bin", "php");
        for (const v of safeReaddir(phpRoot)) {
            out.push({ path: path.join(phpRoot, v, "php.exe"), source: "System" });
        }
    }

    // Chocolatey — `choco install php` lands here.
    out.push({ path: path.join(programFiles, "PHP", "php.exe"), source: "System" });
    out.push({ path: path.join(programFilesX86, "PHP", "php.exe"), source: "System" });

    // Scoop — per-user package manager. Default install root is under
    // %USERPROFILE%\scoop\apps\php\current, with shims at %USERPROFILE%\scoop\shims.
    const scoopRoot = process.env["SCOOP"] ?? path.join(home, "scoop");
    out.push({ path: path.join(scoopRoot, "apps", "php", "current", "php.exe"), source: "System" });
    out.push({ path: path.join(scoopRoot, "shims", "php.exe"), source: "System" });

    out.push(...pathSearch("php.exe"));
    return out;
}

/**
 * Walk every directory on $PATH and return any `name`-shaped binary we
 * find. Catches the long tail (custom installs, package managers we
 * don't have a hardcoded path for, version managers we haven't heard of
 * yet). Synchronous — `fs.statSync` on at most ~50 dirs is sub-ms even
 * on a cold cache.
 */
function pathSearch(name: string): Candidate[] {
    const env = process.env.PATH ?? "";
    const sep = process.platform === "win32" ? ";" : ":";
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const dir of env.split(sep)) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        out.push({ path: candidate, source: "System" });
    }
    return out;
}

function phpFormulaNames(): string[] {
    // PHP 8.1 → 8.x: covers every released minor through PHP 8.9.
    const out: string[] = [];
    for (let major = 8; major <= 9; major++) {
        const max = major === 8 ? 9 : 0;
        for (let minor = 0; minor <= max; minor++) {
            out.push(`php@${major}.${minor}`);
            out.push(`php${major}.${minor}`);
        }
    }
    return out;
}

function safeReaddir(p: string): string[] {
    try {
        return fs.readdirSync(p);
    } catch {
        return [];
    }
}

function realpath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}

async function probe(php: string): Promise<string | null> {
    try {
        const { stdout } = await execFileP(php, ["-r", "echo PHP_VERSION;"], { timeout: 2000 });
        const s = stdout.trim();
        if (!s || !/^\d/.test(s)) return null;
        if (s.split(".").length < 2) return null;
        return s;
    } catch {
        return null;
    }
}

function isNonCli(p: string): boolean {
    const name = path.basename(p).toLowerCase();
    // Strip the .exe suffix Windows binaries carry so the trailing-suffix
    // checks below fire on `php-fpm.exe` the same way they do on `php-fpm`.
    const stripped = name.endsWith(".exe") ? name.slice(0, -4) : name;
    return /-fpm$|-cgi$|-phar$|-dbg$|-debug$|-config$|-legacy$|ize$/.test(stripped);
}
