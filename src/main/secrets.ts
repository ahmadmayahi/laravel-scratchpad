import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "./paths.js";

/**
 * OS-backed secret store for SSH passwords + private-key passphrases.
 *
 * Uses Electron's `safeStorage`, which holds the encryption key in the
 * platform's native credential vault:
 *
 *   • macOS:   Keychain
 *   • Windows: DPAPI (user-scoped — ciphertext is bound to the Windows
 *              account that created it)
 *   • Linux:   libsecret (gnome-keyring / kwallet via DBus). Falls back
 *              to basic encryption if no keyring daemon is running;
 *              `isEncryptionAvailable()` returns false in that case and
 *              we refuse to persist the secret rather than pretend it's
 *              protected.
 *
 * Only the key lives in the OS vault. The ciphertext itself is written
 * to `ssh-secrets.json` under the app's support dir — base64 so it
 * round-trips through JSON cleanly. Separating the two means the file is
 * safe to back up, inspect, or sync without leaking secrets: a ciphertext
 * without the vault key is unreadable on another machine (Windows) or
 * another user account.
 *
 * Lifecycle is keyed by project id — add/remove a project and the secret
 * follows it. `main.ts` wires the cascade delete on `projects:remove`.
 */

type Ciphertext = string; // base64

export class SecretStore {
    private readonly file: string;
    private cache: Record<string, Ciphertext>;

    constructor() {
        const dir = appDataDir();
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, "ssh-secrets.json");
        this.cache = this.load();
    }

    /**
     * Whether the OS credential vault is reachable. False on Linux when
     * no keyring daemon is running. Callers should refuse to persist a
     * secret and tell the user why — no silent fallback to plaintext.
     */
    isAvailable(): boolean {
        try {
            return safeStorage.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    /**
     * Encrypt and persist `plaintext` under `id`. Throws if the backend
     * isn't available; callers must check `isAvailable()` first and
     * surface a helpful message.
     */
    set(id: string, plaintext: string): void {
        if (!this.isAvailable()) {
            throw new Error("OS credential storage unavailable (no keyring daemon on Linux?)");
        }
        const ct = safeStorage.encryptString(plaintext);
        this.cache[id] = ct.toString("base64");
        this.save();
    }

    /**
     * Retrieve + decrypt, or null if the id isn't stored / decryption
     * fails (e.g. the ciphertext came from a different user account on
     * Windows, or the Keychain entry was deleted out-of-band).
     */
    get(id: string): string | null {
        const b64 = this.cache[id];
        if (!b64) return null;
        try {
            return safeStorage.decryptString(Buffer.from(b64, "base64"));
        } catch {
            // Stale / unreadable ciphertext — drop it so the UI can
            // prompt the user to re-enter their password next time.
            delete this.cache[id];
            this.save();
            return null;
        }
    }

    has(id: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.cache, id);
    }

    remove(id: string): void {
        if (!(id in this.cache)) return;
        delete this.cache[id];
        this.save();
    }

    private load(): Record<string, Ciphertext> {
        try {
            if (!fs.existsSync(this.file)) return {};
            const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
            const out: Record<string, Ciphertext> = {};
            for (const [k, v] of Object.entries(raw)) {
                if (typeof v === "string") out[k] = v;
            }
            return out;
        } catch {
            return {};
        }
    }

    private save(): void {
        // Atomic write — matches SettingsStore / ProjectStore so a crash
        // mid-write can't truncate the file and lose every stored secret.
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), "utf8");
        // 0600 so other local users can't even read the ciphertext
        // envelope. Defence-in-depth: the ciphertext alone is useless
        // without the vault key, but narrowing the read surface removes
        // one class of offline attacks entirely. chmod is a no-op on
        // Windows, where file permissions use ACLs instead.
        try {
            fs.chmodSync(tmp, 0o600);
        } catch {
            /* best-effort */
        }
        fs.renameSync(tmp, this.file);
    }
}
