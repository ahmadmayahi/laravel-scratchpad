import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "./paths.js";

/**
 * Tiny host-key trust store. `ssh2` has no built-in equivalent of
 * OpenSSH's `~/.ssh/known_hosts`; if we don't verify the host key
 * ourselves, `ssh2` accepts anything — that's the classic MITM hole.
 *
 * We store SHA-256 fingerprints of the first-seen host key, keyed by
 * `user@host:port`. Subsequent connects compare against the stored
 * fingerprint and refuse on mismatch (key changed, likely MITM or
 * reprovisioned host).
 *
 * "accept-new" trusts on first use (TOFU); "yes" requires a pre-seeded
 * fingerprint and refuses unknown hosts outright. The file lives next
 * to the other app-scoped JSON stores so it's easy to back up and
 * survive-or-replace.
 */
export class KnownHostsStore {
    private readonly file: string;
    private cache: Record<string, string>;

    constructor() {
        const dir = appDataDir();
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, "ssh-known-hosts.json");
        this.cache = this.load();
    }

    get(user: string | undefined, host: string, port: number): string | null {
        return this.cache[keyFor(user, host, port)] ?? null;
    }

    set(user: string | undefined, host: string, port: number, fingerprint: string): void {
        this.cache[keyFor(user, host, port)] = fingerprint;
        this.save();
    }

    remove(user: string | undefined, host: string, port: number): void {
        const k = keyFor(user, host, port);
        if (k in this.cache) {
            delete this.cache[k];
            this.save();
        }
    }

    private load(): Record<string, string> {
        try {
            if (!fs.existsSync(this.file)) return {};
            const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(raw)) {
                if (typeof v === "string") out[k] = v;
            }
            return out;
        } catch {
            return {};
        }
    }

    private save(): void {
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), "utf8");
        // 0600 so an attacker on the same system can't enumerate the
        // hosts the user connects to. Fingerprints aren't secret per se,
        // but the list itself is — it doubles as a connection history.
        // chmod is a no-op on Windows (file ACLs are separate); the
        // call is safe to run unconditionally.
        try {
            fs.chmodSync(tmp, 0o600);
        } catch {
            /* best-effort */
        }
        fs.renameSync(tmp, this.file);
    }
}

function keyFor(user: string | undefined, host: string, port: number): string {
    const u = user && user.length > 0 ? `${user}@` : "";
    return `${u}${host}:${port}`;
}

/** Same shape as OpenSSH's fingerprint display: "SHA256:<base64>" (no padding). */
export function fingerprintHostKey(key: Buffer): string {
    const b64 = crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
    return `SHA256:${b64}`;
}
