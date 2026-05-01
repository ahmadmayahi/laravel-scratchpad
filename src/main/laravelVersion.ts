import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the Laravel framework version installed in a project by reading
 * its `vendor/composer/installed.json`. This is the same file Composer
 * writes after `composer install`, and it's reliably up-to-date on every
 * dependency change — more so than parsing the loose `composer.lock`.
 *
 * Returns null when:
 *   - the project has no `vendor/` yet (fresh clone, needs `composer install`)
 *   - the file is present but parseable JSON didn't list `laravel/framework`
 *   - anything on the happy path throws (permission errors, etc.)
 *
 * The `v` prefix Composer uses for tags (`v12.1.0`) is stripped so callers
 * can render the version cleanly.
 */
export function readLaravelVersion(projectPath: string): string | null {
    const installed = path.join(projectPath, "vendor/composer/installed.json");
    if (!fs.existsSync(installed)) return null;
    try {
        const json = JSON.parse(fs.readFileSync(installed, "utf8"));
        // Composer 2 wraps packages inside `{ packages: [...], "dev-package-names": [...] }`,
        // older Composer writes the array directly. Support both.
        const packages: Array<{ name?: string; version?: string }> = Array.isArray(json.packages)
            ? json.packages
            : json;
        for (const p of packages) {
            if (p.name === "laravel/framework") {
                return String(p.version ?? "").replace(/^v/, "");
            }
        }
    } catch {
        /* ignore — return null below */
    }
    return null;
}

/**
 * Read the PHP version constraint the project declares in `composer.json`
 * under `require.php` (e.g. `"^8.2"`, `">=8.1"`, `"^8.2|^8.3"`).
 * Returns the raw constraint string, or null if the file is missing /
 * unparseable / doesn't require PHP explicitly.
 */
export function readRequiredPhp(projectPath: string): string | null {
    const composer = path.join(projectPath, "composer.json");
    if (!fs.existsSync(composer)) return null;
    try {
        const json = JSON.parse(fs.readFileSync(composer, "utf8"));
        const req = json?.require?.php;
        return typeof req === "string" && req.length > 0 ? req : null;
    } catch {
        return null;
    }
}

/**
 * Given a Composer PHP constraint like `"^8.2"` or `"^8.2|^8.3"` and a list
 * of installed PHP versions, return the **best match**: the highest version
 * that satisfies any of the constraint's alternatives.
 *
 * We implement a minimal subset of Composer's version-constraint grammar —
 * enough for the shapes that turn up in real-world `composer.json` files:
 *   - `X.Y` or `X.Y.Z`         — exact (or prefix) match
 *   - `^X.Y` / `^X.Y.Z`        — compatible within the same major
 *   - `~X.Y` / `~X.Y.Z`        — last segment may float
 *   - `>=X.Y`, `>X.Y`, `<=X.Y`, `<X.Y` — simple comparators
 *   - any of the above `|`-joined as alternatives
 *
 * Returns null when nothing matches, which is the signal for the caller to
 * fall back to the user's global default / platform-check bypass.
 */
export function pickPhpForConstraint<T extends { path: string; version: string }>(
    constraint: string,
    available: readonly T[],
): T | null {
    const alternatives = constraint
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
    const matching = available.filter((v) => alternatives.some((alt) => satisfies(v.version, alt)));
    if (matching.length === 0) return null;
    // Highest version wins — e.g. if a project accepts 8.2 or 8.3 and both
    // are installed, 8.3 is the better pick.
    matching.sort((a, b) => compareSemver(b.version, a.version));
    return matching[0] ?? null;
}

// ---------------------------------------------------------------------------
// Internal: semver-ish parsing. Composer constraints aren't strictly semver,
// but for the narrow set of shapes we care about this is enough.
// ---------------------------------------------------------------------------

function parse(version: string): [number, number, number] {
    const m = version.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return [0, 0, 0];
    return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareSemver(a: string, b: string): number {
    const [a1, a2, a3] = parse(a);
    const [b1, b2, b3] = parse(b);
    return a1 - b1 || a2 - b2 || a3 - b3;
}

/**
 * Does a single version satisfy one alternative of a constraint?
 * Handles `^`, `~`, `>=`, `>`, `<=`, `<`, exact, and exact-prefix forms.
 */
function satisfies(version: string, constraint: string): boolean {
    const c = constraint.trim();

    // Range comparators first — must come before the "^"/"~" checks below.
    const cmp = c.match(/^(>=|<=|>|<|=)?\s*(\d[\d.]*)/);
    if (c.startsWith("^")) {
        const [cMaj, cMin, cPatch] = parse(c.slice(1));
        const [vMaj, vMin, vPatch] = parse(version);
        if (vMaj !== cMaj) return false;
        if (vMin < cMin) return false;
        if (vMin === cMin && vPatch < cPatch) return false;
        return true;
    }
    if (c.startsWith("~")) {
        const parts = c.slice(1).split(".");
        const [cMaj, cMin, cPatch] = parse(c.slice(1));
        const [vMaj, vMin, vPatch] = parse(version);
        if (vMaj !== cMaj) return false;
        if (parts.length >= 3) {
            // ~X.Y.Z → >=X.Y.Z, <X.(Y+1).0
            if (vMin !== cMin) return false;
            return vPatch >= cPatch;
        }
        // ~X.Y → >=X.Y.0, <(X+1).0.0
        return vMin >= cMin;
    }
    if (cmp) {
        const op = cmp[1] ?? "=";
        const diff = compareSemver(version, cmp[2]!);
        switch (op) {
            case ">":
                return diff > 0;
            case ">=":
                return diff >= 0;
            case "<":
                return diff < 0;
            case "<=":
                return diff <= 0;
            case "=":
                return diff === 0;
        }
    }
    return false;
}
