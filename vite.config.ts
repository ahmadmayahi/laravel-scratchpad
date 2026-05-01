import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
    // Tailwind 4 is CSS-first: the theme + layers live inside `main.css`,
    // and `@tailwindcss/vite` swaps the PostCSS pipeline v3 used for a
    // Lightning-CSS-powered one with built-in vendor prefixing.
    plugins: [vue(), tailwindcss()],
    root: path.resolve(__dirname, "src/renderer"),
    base: "./",
    build: {
        outDir: path.resolve(__dirname, "dist/renderer"),
        emptyOutDir: true,
        rollupOptions: {
            input: path.resolve(__dirname, "src/renderer/index.html"),
        },
    },
    server: {
        port: 5173,
    },
    resolve: {
        alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
        },
    },
    // Pre-bundle Monaco + its workers so the first editor mount doesn't trigger
    // an on-demand 20-second re-optimisation pass.
    optimizeDeps: {
        include: [
            "monaco-editor/esm/vs/editor/editor.api",
            "monaco-editor/esm/vs/basic-languages/php/php.contribution",
            "monaco-editor/esm/vs/basic-languages/html/html.contribution",
            "monaco-editor/esm/vs/basic-languages/css/css.contribution",
            "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution",
        ],
    },
});
