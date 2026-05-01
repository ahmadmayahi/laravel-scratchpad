/**
 * Local Monaco bootstrap.
 *
 * We import Monaco directly from the `monaco-editor` npm package (no CDN
 * loader) and register its web-workers with `self.MonacoEnvironment`. Every
 * editor instance mounted anywhere in the Vue tree picks these up
 * automatically, so we don't have to plumb them through per-component.
 *
 * Monaco 0.55+ moved to a stricter `exports` map in `package.json` — the
 * old subpath imports (`monaco-editor/esm/vs/...`) still resolve at runtime
 * via the wildcard but don't expose type declarations, and TS 6 errors on
 * the side-effect imports. Using the root `monaco-editor` entry brings all
 * language contributions automatically; Vite tree-shakes the ones we don't
 * reference.
 *
 * This file MUST run before any Monaco editor mounts, so `main.ts` imports
 * it for side effects.
 */

import * as monaco from "monaco-editor";

// Web workers Monaco spawns to do tokenisation/lint off the main thread.
// Vite's `?worker` suffix turns each into an inline Worker constructor.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
        switch (label) {
            case "html":
            case "handlebars":
            case "razor":
                return new HtmlWorker();
            case "css":
            case "scss":
            case "less":
                return new CssWorker();
            case "json":
                return new JsonWorker();
            case "typescript":
            case "javascript":
                return new TsWorker();
            default:
                return new EditorWorker();
        }
    },
};

export { monaco };
