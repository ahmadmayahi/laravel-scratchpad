import * as path from "node:path";
import * as fs from "node:fs";
import { scrubbedEnv } from "./env.js";
import { StdioJsonRpcServer } from "./stdioLsp.js";

/**
 * Intelephense-specific LSP spawn. All stdio framing and process lifecycle
 * lives in the {@link StdioJsonRpcServer} base class — this subclass only
 * resolves the entry point.
 *
 * Intelephense is distributed as a single JS file bundled with its
 * dependencies. We run it inside Electron's own Node runtime
 * (`ELECTRON_RUN_AS_NODE=1`) so users don't need a separate Node install.
 */
export class LspServer extends StdioJsonRpcServer {
    constructor() {
        // Reuse the same env scrubbing we apply to PHP workers — Intelephense
        // is third-party code and shouldn't see our shell's credentials.
        const intelephenseJs = resolveIntelephensePath();
        super(
            intelephenseJs ? process.execPath : null,
            intelephenseJs ? [intelephenseJs, "--stdio"] : [],
            { ...scrubbedEnv(), ELECTRON_RUN_AS_NODE: "1" },
            "lsp",
        );
    }
}

/** Locate `intelephense/lib/intelephense.js` across dev + packaged layouts. */
function resolveIntelephensePath(): string | null {
    const candidates = [
        // Packaged app — extraResources copies node_modules too (or it's bundled in asar)
        process.resourcesPath &&
            path.join(
                process.resourcesPath,
                "app.asar.unpacked",
                "node_modules",
                "intelephense",
                "lib",
                "intelephense.js",
            ),
        process.resourcesPath &&
            path.join(process.resourcesPath, "app", "node_modules", "intelephense", "lib", "intelephense.js"),
        // Dev
        path.resolve(__dirname, "..", "..", "node_modules", "intelephense", "lib", "intelephense.js"),
        path.resolve(process.cwd(), "node_modules", "intelephense", "lib", "intelephense.js"),
    ].filter((p): p is string => typeof p === "string");

    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            /* next */
        }
    }
    return null;
}
