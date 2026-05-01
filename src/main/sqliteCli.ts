import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export interface SqliteCliInfo {
    path: string;
    version: string;
}

/**
 * Probe the host for a usable `sqlite3` CLI. Mirrors the discovery
 * pattern in `phpVersions.ts`: per-OS hardcoded candidates plus every
 * directory on PATH, probed in parallel for `--version`. Caller-supplied
 * custom path is tried first so a user override can recover from a
 * stripped install (Windows out-of-box, minimal Linux containers).
 *
 * Returns the first probe that responds — we don't need a list, just
 * one working binary. Null when nothing works.
 */
export async function discoverSqliteCli(customPath: string | null = null): Promise<SqliteCliInfo | null> {
    const seen = new Set<string>();
    const candidates: string[] = [];

    if (customPath) {
        candidates.push(customPath);
        seen.add(customPath);
    }
    for (const c of platformCandidates()) {
        if (!seen.has(c)) {
            candidates.push(c);
            seen.add(c);
        }
    }
    for (const c of pathSearch(sqliteName())) {
        if (!seen.has(c)) {
            candidates.push(c);
            seen.add(c);
        }
    }

    // Filter to existing files first (cheap), then probe in parallel.
    const existing = candidates.filter((p) => {
        try {
            return fs.statSync(p).isFile();
        } catch {
            return false;
        }
    });

    const results = await Promise.all(
        existing.map(async (p) => {
            const v = await probeVersion(p);
            return v ? { path: p, version: v } : null;
        }),
    );

    return results.find((r): r is SqliteCliInfo => r !== null) ?? null;
}

function sqliteName(): string {
    return process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
}

function platformCandidates(): string[] {
    if (process.platform === "win32") return windowsCandidates();
    if (process.platform === "darwin") return macCandidates();
    return linuxCandidates();
}

function macCandidates(): string[] {
    return [
        "/opt/homebrew/bin/sqlite3", // Apple Silicon Homebrew
        "/usr/local/bin/sqlite3", // Intel Homebrew
        "/usr/bin/sqlite3", // System (always present on macOS)
    ];
}

function linuxCandidates(): string[] {
    const home = os.homedir();
    return [
        "/usr/bin/sqlite3", // Distro packages
        "/usr/local/bin/sqlite3", // Manual builds
        "/snap/bin/sqlite3", // Snap exposes binaries here
        "/home/linuxbrew/.linuxbrew/bin/sqlite3", // Linuxbrew system install
        path.join(home, ".linuxbrew/bin/sqlite3"), // Linuxbrew per-user
    ];
}

function windowsCandidates(): string[] {
    const home = os.homedir();
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData\\Local");
    const scoopRoot = process.env["SCOOP"] ?? path.join(home, "scoop");
    return [
        // The official sqlite.org "command-line tools" zip is usually
        // unzipped manually — common locations follow.
        path.join(localAppData, "Programs", "sqlite", "sqlite3.exe"),
        "C:\\sqlite\\sqlite3.exe",
        "C:\\Program Files\\sqlite\\sqlite3.exe",
        // Scoop and Chocolatey land it on PATH via shims; those get
        // picked up by the PATH walk below, but include the canonical
        // shim location anyway in case PATH is empty.
        path.join(scoopRoot, "shims", "sqlite3.exe"),
        path.join(scoopRoot, "apps", "sqlite", "current", "sqlite3.exe"),
    ];
}

function pathSearch(name: string): string[] {
    const env = process.env.PATH ?? "";
    const sep = process.platform === "win32" ? ";" : ":";
    const out: string[] = [];
    const seen = new Set<string>();
    for (const dir of env.split(sep)) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        out.push(candidate);
    }
    return out;
}

/**
 * `sqlite3 --version` prints `<version> <date> <hash>` on stdout. We
 * grab just the leading version token. Anything that doesn't look
 * like a digit-led string is treated as a non-sqlite binary that
 * happened to be named `sqlite3` (rare, but possible on a renamed
 * shim).
 */
async function probeVersion(bin: string): Promise<string | null> {
    try {
        const { stdout } = await execFileP(bin, ["--version"], { timeout: 2000 });
        const first = stdout.trim().split(/\s+/)[0];
        if (!first || !/^\d/.test(first)) return null;
        return first;
    } catch {
        return null;
    }
}
