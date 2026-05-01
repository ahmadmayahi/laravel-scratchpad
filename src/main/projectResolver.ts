import path from "node:path";
import fs from "node:fs";
import type { Project, Skeleton } from "../shared/ipc.js";
import type { ProjectStore } from "./projects.js";
import { isValidSkeletonSlug, type SkeletonsStore } from "./skeletons.js";
import { readRequiredPhp } from "./laravelVersion.js";

/**
 * Bridge between the projects.json registry and the skeletons table —
 * a skeleton presents to the rest of the main process as a runtime-
 * only Project with a `skeleton:<slug>` id, so the runner, secret
 * prompt, and tabs flows can treat it like any other local Laravel
 * project without special-casing.
 */

export const SKELETON_ID_PREFIX = "skeleton:";

export interface ProjectResolverDeps {
    projects: ProjectStore;
    skeletonsStore: SkeletonsStore;
}

/**
 * Present a ready skeleton row as a runtime-only Project. The same
 * shape real local Laravel projects have, plus `isBundled: true` so
 * the renderer can group them. `id` is `skeleton:<slug>` — not a
 * UUID, distinguishable from projects.json entries, and cheap to
 * parse back to the slug when dispatching Run / remove / etc.
 */
export function skeletonAsProject(s: Skeleton): Project {
    const name = s.installedVersion ? `Laravel ${s.installedVersion}` : `Laravel ${s.slug}`;
    return {
        id: `${SKELETON_ID_PREFIX}${s.slug}`,
        name,
        kind: "laravel",
        projectPath: s.folderPath,
        laravelVersion: s.installedVersion ?? null,
        requiredPhp: readRequiredPhp(s.folderPath),
        ideHelperInstalled: fs.existsSync(path.join(s.folderPath, "vendor/barryvdh/laravel-ide-helper")),
        isBundled: true,
    };
}

export function createProjectResolver(deps: ProjectResolverDeps): (id: string) => Project | null {
    /**
     * Resolve either a real project (by UUID from projects.json) or a
     * skeleton-backed virtual project (id = `skeleton:<slug>`). Used
     * by every IPC handler that takes a `projectId` so skeletons work
     * transparently with the existing runner / secret-prompt / tabs
     * flow.
     */
    return function resolveProjectById(id: string): Project | null {
        if (id.startsWith(SKELETON_ID_PREFIX)) {
            const slug = id.slice(SKELETON_ID_PREFIX.length);
            if (!isValidSkeletonSlug(slug)) return null;
            const s = deps.skeletonsStore.bySlug(slug);
            if (!s || s.status !== "ready") return null;
            return skeletonAsProject(s);
        }
        return deps.projects.byId(id) ?? null;
    };
}
