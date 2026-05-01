import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { Project } from "../shared/ipc.js";
import { CH } from "../shared/ipcChannels.js";
import type { SecretStore } from "./secrets.js";

/**
 * Dispatches SSH secret retrieval by the project's `secretStrategy`
 * (keychain / prompt / none), and owns the renderer-prompt correlation
 * map used by the `prompt` strategy.
 *
 * Plaintext secrets only exist on the returned promise's stack frame —
 * they're never persisted through here. The vault (OS keychain /
 * DPAPI / libsecret) is the sole durable store; `prompt` answers are
 * discarded as soon as ssh2 consumes them.
 */

export interface SecretResolutionDeps {
    getMainWindow(): BrowserWindow | null;
    secrets: SecretStore;
}

export interface SecretResolver {
    resolveSshSecret(proj: Project): Promise<string | null>;
    enrichSecretStored(p: Project): Project;
}

export function createSecretResolver(deps: SecretResolutionDeps): SecretResolver {
    /** Pending renderer-prompt requests, keyed by correlation id. */
    const pendingPrompts = new Map<string, (secret: string | null) => void>();

    ipcMain.on(CH.projectsSecretPromptRespond, (_e, id: string, secret: string | null) => {
        const resolver = pendingPrompts.get(id);
        if (!resolver) return;
        pendingPrompts.delete(id);
        resolver(secret);
    });

    /**
     * Show a password prompt in the renderer and await the response.
     * Returns null if the user cancelled. Rejects if the window is gone
     * — the alternative would be hanging forever.
     */
    function promptForSecret(proj: Project): Promise<string | null> {
        const win = deps.getMainWindow();
        if (!win || !proj.ssh) {
            return Promise.reject(new Error("Cannot prompt — window not available"));
        }
        const id = randomUUID();
        return new Promise<string | null>((resolve) => {
            pendingPrompts.set(id, resolve);
            win.webContents.send(CH.projectsSecretPrompt, {
                id,
                projectId: proj.id,
                projectName: proj.name,
                authMode: proj.ssh!.authMode,
            });
        });
    }

    /**
     * Resolve the secret for an SSH connect based on its configured
     * strategy. Returns null when no secret should be passed to ssh2
     * (agent mode, unencrypted key, strategy=none).
     */
    async function resolveSshSecret(proj: Project): Promise<string | null> {
        if (proj.kind !== "ssh" || !proj.ssh) return null;
        const { authMode, secretStrategy } = proj.ssh;
        if (authMode === "agent") return null;

        const strategy = secretStrategy ?? "keychain";
        switch (strategy) {
            case "none":
                return null;
            case "keychain": {
                const stored = deps.secrets.get(proj.id);
                if (!stored) {
                    if (authMode === "password") {
                        throw new Error(
                            "Saved password not available — the keychain entry may have been " +
                                "removed. Edit the project and re-enter the password.",
                        );
                    }
                    return null; // key auth with no stored passphrase → unencrypted key path
                }
                return stored;
            }
            case "prompt": {
                const secret = await promptForSecret(proj);
                if (secret === null) throw new Error("Password entry cancelled.");
                return secret;
            }
        }
    }

    /**
     * Stamp an SSH project with a runtime-only `secretStored` flag so
     * the renderer can render "Password: ••••••" without ever reading
     * the plaintext. Derived each list call — never persisted in
     * projects.json (the source of truth for whether a secret exists
     * is the vault itself).
     */
    function enrichSecretStored(p: Project): Project {
        if (p.kind !== "ssh" || !p.ssh) return p;
        return { ...p, ssh: { ...p.ssh, secretStored: deps.secrets.has(p.id) } };
    }

    return { resolveSshSecret, enrichSecretStored };
}
