import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // The Vite renderer config has its own root pointing at src/renderer
        // for the dev server; tests are executed from the repo root and need
        // to import from any of src/{main,renderer,shared}.
        root: ".",
        include: ["src/**/*.test.ts"],
        environment: "node",
        // Renderer-side tests pull in `monaco-editor` types but never touch
        // the editor instance — pure logic. If a future renderer test does
        // need the DOM, switch the affected file to `// @vitest-environment jsdom`.
        deps: {
            optimizer: {
                ssr: { include: ["monaco-editor"] },
            },
        },
    },
});
