/// <reference types="vite/client" />

import type { LspBridge } from "../../shared/ipc";

// Tell TypeScript that `.vue` files exist — the Volar / vue-tsc tooling
// reads the real shapes out of the <script setup> block; this shim just
// keeps plain `tsc` from complaining about unknown module types in case
// something in the non-Vue tooling path imports a `.vue` file directly.
declare module "*.vue" {
    import type { DefineComponent } from "vue";
    const component: DefineComponent<{}, {}, unknown>;
    export default component;
}

// Splitpanes ships no TS types of its own — declare the two runtime exports
// so `<script setup>` can import them without `any` complaints.
declare module "splitpanes" {
    import type { DefineComponent } from "vue";
    export const Splitpanes: DefineComponent<Record<string, unknown>>;
    export const Pane: DefineComponent<Record<string, unknown>>;
}
declare module "splitpanes/dist/splitpanes.css";

/**
 * Renderer-side shape of the JSON-RPC transport bridges (`window.lspBridge`,
 * `window.laravelLsBridge`). Both speak the same wire protocol; the two
 * exposed surfaces are identical so the renderer-side clients stay
 * independent without having to multiplex on a shared stream.
 */
interface LspWireBridge {
    send(msg: unknown): void;
    ensureRunning(): Promise<void>;
    onMessage(cb: (msg: unknown) => void): () => void;
    onDisconnected(cb: () => void): () => void;
}

declare global {
    /**
     * Surfaces exposed from preload via `contextBridge.exposeInMainWorld` —
     * see [src/preload/preload.ts](../../preload/preload.ts).
     */
    interface Window {
        /**
         * One of Node's `process.platform` strings
         * ("darwin" | "win32" | "linux" | …). Typed as string to keep
         * renderer tsconfig free of node types.
         */
        platform: string;

        /**
         * Menu-driven keyboard shortcut bridge. Subscribers receive events
         * fired by the native application menu (see setupMenu in main.ts)
         * and return an unsubscribe fn. Free-form shortcuts (⌘K, ⌘T, etc.)
         * are captured directly via `keydown` in useKeyboardShortcuts.
         */
        shortcuts: {
            onRun: (cb: () => void) => () => void;
            onCancel: (cb: () => void) => () => void;
            onSettings: (cb: () => void) => () => void;
        };

        /**
         * Main-process IPC surface. Implemented in `src/preload/preload.ts`
         * as a typed proxy over `ipcRenderer.invoke`; channel names are
         * centralised in `src/shared/ipcChannels.ts`.
         */
        lsp: LspBridge;

        /** JSON-RPC bridge to the Intelephense subprocess. */
        lspBridge: LspWireBridge;

        /** JSON-RPC bridge to the laravel-ls subprocess. */
        laravelLsBridge: LspWireBridge;
    }
}

export {};
