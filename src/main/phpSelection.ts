import fs from "node:fs";
import type { Project } from "../shared/ipc.js";
import type { SettingsStore } from "./settings.js";
import { discoverPhpVersions } from "./phpVersions.js";
import { pickPhpForConstraint } from "./laravelVersion.js";
import { writeLaravelBootstrap } from "./runner.js";

/**
 * Pick the PHP binary to launch for a given LOCAL project. SSH
 * projects use whatever `php` the remote host resolves — this module
 * is not on that code path.
 *
 * Priority:
 *   1. User's explicit `settings.php.defaultBinary` (if set and exists
 *      on disk). The "I want to run everything with this PHP" override.
 *   2. The highest installed PHP version that satisfies the project's
 *      `composer.json` → `require.php` constraint.
 *   3. The first-discovered PHP, as a last resort — the Composer
 *      platform-check bypass in `laravel-bootstrap.php` keeps things
 *      running even when (3) can't satisfy the project's requirement.
 */
export async function choosePhpFor(proj: Project, settings: SettingsStore): Promise<string> {
    const explicit = settings.get().php.defaultBinary;
    if (explicit && fs.existsSync(explicit)) return explicit;

    const found = await discoverPhpVersions(settings.get().php.customPaths);
    if (!found.length) throw new Error("No PHP binary found. Install via Homebrew, asdf, or Laravel Herd.");

    if (proj.requiredPhp) {
        const matched = pickPhpForConstraint(proj.requiredPhp, found);
        if (matched) return matched.path;
    }

    return found[0]!.path;
}

export function buildLocalContextFor(proj: Project): {
    bootstrapPath: string;
    cwd: string;
    projectName: string;
} {
    if (proj.kind !== "laravel") {
        throw new Error(`buildLocalContextFor: unexpected project kind ${proj.kind}`);
    }
    const bootstrapPath = writeLaravelBootstrap(proj.projectPath);
    return { bootstrapPath, cwd: proj.projectPath, projectName: proj.name };
}
