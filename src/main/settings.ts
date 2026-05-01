import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { DeepPartial, Settings } from "../shared/ipc.js";
import { appDataDir } from "./paths.js";

/**
 * App settings — user-adjustable preferences persisted to `settings.json`
 * under the per-user app data dir. All writes are atomic; reads return a
 * deep-merged copy of the defaults and the saved file so new keys added in
 * future releases get sane defaults.
 *
 * The `Settings` shape lives in `../shared/ipc.ts` so both processes agree
 * on the wire format; the types were previously duplicated here and in
 * shared/ipc.ts — drift risk.
 */
export type { Settings } from "../shared/ipc.js";

const defaultSettings: Settings = {
    ui: {
        mode: "system",
    },
    editor: {
        theme: "vs-dark",
        fontSize: 13,
        tabSize: 4,
        wordWrap: false,
        lineNumbers: true,
    },
    php: {
        defaultBinary: null,
        customPaths: [],
        enabledPaths: [],
    },
    general: {
        restoreTabsOnLaunch: true,
    },
    ai: {
        // Opt-in — the user has to flip this on after Ollama is reachable.
        // Zero AI traffic leaves the app before that happens.
        enabled: false,
        endpoint: "http://127.0.0.1:11434",
        model: "qwen2.5-coder:3b",
        // "auto" lets Ollama's native FIM template kick in for models it
        // recognizes (qwen2.5-coder, codellama, deepseek, starcoder variants).
        // Power users can pick the template explicitly if they're running
        // a model on an older Ollama that doesn't know it.
        fimTemplate: "auto",
        maxTokens: 128,
        temperature: 0.2,
        debounceMs: 400,
        maxContextChars: 4000,
    },
    database: {
        // Empty on first install — `seedDefaultSqliteIfMissing()` (called
        // from main.ts at boot) inserts the "Scratchpad SQLite" row when
        // this list is empty. Upgraders without this key inherit the
        // empty default via deep-merge and get the same seed on next launch.
        // No global "active" — selection is per-tab; the toolbar picker
        // writes to the tab, never to settings.
        connections: [],
        sqlite: {
            // User-set SQLite tooling overrides — both null until the
            // user explicitly picks one in Settings → Database. The
            // Availability service prefers the override over discovery.
            customCliPath: null,
            customDatabasePath: null,
        },
    },
};

export class SettingsStore extends EventEmitter {
    private readonly file: string;
    private current: Settings;

    constructor() {
        super();
        const dir = appDataDir();
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, "settings.json");
        this.current = this.load();
    }

    get(): Settings {
        return JSON.parse(JSON.stringify(this.current));
    }

    /**
     * Apply a deep partial patch. Only keys present in the patch are touched,
     * which lets the renderer send `{ editor: { theme: "dracula" } }` without
     * clobbering fontSize or anything else.
     */
    set(patch: DeepPartial<Settings>): Settings {
        this.current = deepMerge(this.current, patch) as Settings;
        this.save();
        this.emit("change", this.get());
        return this.get();
    }

    /** Read-modify-write path for custom PHP paths. */
    addCustomPhp(p: string): Settings {
        if (!this.current.php.customPaths.includes(p)) {
            this.current.php.customPaths.push(p);
            this.save();
            this.emit("change", this.get());
        }
        return this.get();
    }

    removeCustomPhp(p: string): Settings {
        this.current.php.customPaths = this.current.php.customPaths.filter((x) => x !== p);
        this.save();
        this.emit("change", this.get());
        return this.get();
    }

    private load(): Settings {
        try {
            if (!fs.existsSync(this.file)) return structuredClone(defaultSettings);
            const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
            return deepMerge(structuredClone(defaultSettings), raw) as Settings;
        } catch {
            return structuredClone(defaultSettings);
        }
    }

    private save(): void {
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), "utf8");
        fs.renameSync(tmp, this.file);
    }
}

// Keys that must never be assigned from untrusted patches — a crafted
// `settings.json` or IPC payload could otherwise walk the prototype chain
// and pollute `Object.prototype` for the main process.
const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge<T>(base: T, patch: unknown): T {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        return patch as T;
    }
    if (base === null || typeof base !== "object" || Array.isArray(base)) {
        return patch as T;
    }
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (FORBIDDEN_MERGE_KEYS.has(k)) continue;
        out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    return out as T;
}
