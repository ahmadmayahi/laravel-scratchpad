import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import vueParser from "vue-eslint-parser";

export default [
    {
        ignores: ["dist/**", "release/**", "node_modules/**", "build/**", "resources/**", "**/*.d.ts"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...vue.configs["flat/recommended"],
    {
        files: ["**/*.vue"],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tseslint.parser,
                extraFileExtensions: [".vue"],
                ecmaVersion: "latest",
                sourceType: "module",
                project: ["./tsconfig.main.json", "./tsconfig.renderer.json"],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                project: ["./tsconfig.main.json", "./tsconfig.renderer.json"],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ["eslint.config.mjs", "vite.config.ts"],
        languageOptions: {
            parserOptions: {
                project: null,
            },
        },
    },
    {
        files: ["**/*.ts", "**/*.tsx", "**/*.vue"],
        rules: {
            "no-undef": "off",
            // Strict mode + zero `any` in source today — keep it that way.
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            // Catches forgotten `await` on async IPC calls — the renderer fires
            // ~92 of these and a missing await silently hides errors.
            "@typescript-eslint/no-floating-promises": "error",
            "no-console": ["warn", { allow: ["warn", "error"] }],
            "vue/multi-word-component-names": "off",
        },
    },
    prettier,
];
