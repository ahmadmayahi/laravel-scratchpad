import type { BrowserWindow } from "electron";
import type { Project } from "../../shared/ipc.js";
import type { Runner } from "../runner.js";
import type { SnippetsStore } from "../db.js";
import type { SkeletonsStore, SkeletonProvisioner } from "../skeletons.js";
import type { TabsStore } from "../tabs.js";
import type { ProjectStore } from "../projects.js";
import type { SettingsStore } from "../settings.js";
import type { SecretStore } from "../secrets.js";
import type { LspServer } from "../lsp.js";
import type { LaravelLsManager, LaravelLsServer } from "../laravelLs.js";
import type { AvailabilityService } from "../availability.js";

/**
 * Dependencies every IPC module receives. The two getter functions
 * exist so modules see the current `BrowserWindow` / `LaravelLsServer`
 * instances even though the references are rebound after construction
 * (window closes and re-opens on macOS; laravel-ls spawns only after
 * the download manager reaches `ready`).
 */
export interface MainContext {
    /** `null` until the first window is created, and between close+reopen on macOS. */
    getMainWindow(): BrowserWindow | null;

    runner: Runner;
    snippets: SnippetsStore;
    skeletonsStore: SkeletonsStore;
    skeletonProvisioner: SkeletonProvisioner;
    tabsStore: TabsStore;
    projects: ProjectStore;
    settings: SettingsStore;
    secrets: SecretStore;
    lsp: LspServer;
    laravelLsManager: LaravelLsManager;
    availability: AvailabilityService;

    /** Mutable — filled in by the laravelLs IPC module when the manager hits `ready`. */
    getLaravelLs(): LaravelLsServer | null;
    setLaravelLs(ls: LaravelLsServer | null): void;

    resolveProjectById(id: string): Project | null;
    resolveSshSecret(proj: Project): Promise<string | null>;
    enrichSecretStored(p: Project): Project;
    choosePhpFor(proj: Project): Promise<string>;
    buildLocalContextFor(proj: Project): { bootstrapPath: string; cwd: string; projectName: string };
}
