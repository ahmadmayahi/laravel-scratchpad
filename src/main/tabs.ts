import fs from "node:fs";
import path from "node:path";
import type { PersistedTab, PersistedTabs } from "../shared/ipc.js";
import { appDataDir } from "./paths.js";

/**
 * Persists the user's open tabs (id, title, code, projectId) to
 * `tabs.json` under the per-user app data dir so they can be rehydrated
 * on next launch when `settings.general.restoreTabsOnLaunch` is true.
 * Writes are atomic via tmp + rename.
 *
 * Only the minimal textual state is persisted — live frames, session ids,
 * and `isRunning` flags are intentionally dropped because they're
 * meaningless across a process restart.
 */
export class TabsStore {
    private readonly file: string;

    constructor() {
        const dir = appDataDir();
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, "tabs.json");
    }

    load(): PersistedTabs | null {
        try {
            // Recover from a crash that landed between `writeFileSync`
            // and `renameSync`. Without this, a single mid-write crash
            // silently wipes every persisted tab on next boot — the
            // target is missing, load() returns null, and tabs.json.tmp
            // sits orphaned indefinitely. If the tmp parses as JSON, it
            // was fully written and just never got renamed; promote it.
            if (!fs.existsSync(this.file)) {
                const tmp = this.file + ".tmp";
                if (fs.existsSync(tmp)) {
                    try {
                        JSON.parse(fs.readFileSync(tmp, "utf8"));
                        fs.renameSync(tmp, this.file);
                    } catch {
                        // Half-written tmp — clear it so the next save
                        // isn't blocked by our own mess.
                        try {
                            fs.unlinkSync(tmp);
                        } catch {
                            /* ignore */
                        }
                    }
                }
            }
            if (!fs.existsSync(this.file)) return null;
            const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (!raw || typeof raw !== "object" || !Array.isArray(raw.tabs)) return null;
            // Defensive — filter any malformed tab entries rather than crashing.
            // Also migrate the pre-rename `connectionId` field to `projectId`
            // so users who had tabs persisted before the rename don't lose them.
            const tabs: PersistedTab[] = [];
            for (const t of raw.tabs) {
                if (!t || typeof t !== "object") continue;
                const obj = t as Record<string, unknown>;
                if (typeof obj.id !== "string") continue;
                if (typeof obj.title !== "string") continue;
                if (typeof obj.code !== "string") continue;
                const projectId =
                    typeof obj.projectId === "string"
                        ? obj.projectId
                        : typeof obj.connectionId === "string"
                          ? obj.connectionId
                          : null;
                if (!projectId) continue;
                // Per-tab PHP + database picks — both optional in the
                // persisted shape (tabs saved before the per-tab feature
                // landed don't have them). Default both to null = "no
                // override / use the project's .env (or Settings → PHP
                // default for PHP)".
                const persisted: PersistedTab = { id: obj.id, title: obj.title, code: obj.code, projectId };
                if (typeof obj.phpBinary === "string" || obj.phpBinary === null) {
                    persisted.phpBinary = obj.phpBinary;
                }
                if (typeof obj.databaseConnectionId === "string" || obj.databaseConnectionId === null) {
                    persisted.databaseConnectionId = obj.databaseConnectionId;
                }
                tabs.push(persisted);
            }
            return {
                tabs,
                selectedTabId: typeof raw.selectedTabId === "string" ? raw.selectedTabId : null,
            };
        } catch {
            return null;
        }
    }

    save(payload: PersistedTabs): void {
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
        fs.renameSync(tmp, this.file);
    }
}
