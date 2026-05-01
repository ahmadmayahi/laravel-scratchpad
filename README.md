# Laravel ScratchPad

A PHP / Laravel REPL scratchpad, built with **Electron + Vue 3 + Monaco + Tailwind**.

```
laravel-scratchpad/
├── package.json              # Electron + Vite + tailwind
├── tsconfig.{json,main,renderer}
├── vite.config.ts
├── tailwind.config.js
├── build/                    # mac entitlements
├── src/
│   ├── main/                 # Node / Electron main process
│   │   ├── main.ts           # ← entry; creates BrowserWindow, wires IPC
│   │   ├── runner.ts         # spawns worker.php, multiplexes requests
│   │   ├── phpVersions.ts    # detect Homebrew / Herd / asdf / system PHPs
│   │   ├── skeleton.ts       # bundled Laravel skeleton + update check
│   │   ├── db.ts             # SQLite — snippets (better-sqlite3)
│   │   ├── tabs.ts           # tab persistence (restoreTabsOnLaunch)
│   │   ├── lsp.ts            # Intelephense child process + LSP framing
│   │   ├── ollama.ts         # Ollama HTTP proxy (net.fetch, bypasses CORS)
│   │   ├── settings.ts       # JSON-backed user preferences
│   │   └── connections.ts    # laravel / ssh / docker connections
│   ├── preload/
│   │   └── preload.ts        # contextBridge → window.lsp
│   ├── shared/
│   │   └── ipc.ts            # shared TS types
│   └── renderer/             # Vue 3 app
│       ├── index.html
│       ├── main.ts
│       ├── App.vue
│       ├── components/       # Toolbar, TabBar, EditorPane, ResultPane,
│       │                     # StatusBar, SettingsModal, CommandPalette,
│       │                     # ShortcutCheatsheet, ArtisanDialog,
│       │                     # SnippetsDialog, IdeHelperPrompt
│       ├── composables/      # useAppTheme, useKeyboardShortcuts
│       ├── lib/              # lsp-client.ts, aiCompletion.ts, shortcuts.ts, …
│       ├── stores/app.ts     # Pinia global state
│       └── styles/main.css
└── resources/                # copied into app bundle
    └── worker.php             # PHP REPL worker spawned per session
```

## Dev

```bash
cd laravel-scratchpad
npm install
npm run dev          # vite + electron, hot reload
```

`npm run dev` starts Vite on `http://127.0.0.1:5173` and launches Electron pointing at it. The main process watches `tsconfig.main.json` — changes there require a restart (`q` then re-run).

## Build for distribution

```bash
npm run build        # compile main + bundle renderer
npm run dist         # produces platform installers under ./release
npm run dist:mac     # produces .dmg + .zip for macOS updates
```

`electron-builder` config is in `package.json` → `build`. Entitlements in `build/entitlements.mac.plist` enable JIT for V8, disable library validation (required for `better-sqlite3`'s native binding), and turn on network client for the Packagist version check.

macOS release builds are hardened and notarized when signing credentials are present. The recommended CI setup is a Developer ID Application certificate via `CSC_LINK` / `CSC_KEY_PASSWORD` plus App Store Connect API credentials via `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. `electron-updater` needs both `dmg` and `zip` artifacts on macOS, so `dist:mac` emits both.

## How it runs PHP

1. `SkeletonsStore.reconcile()` ensures a `skeletons/latest/` row exists on first launch; `SkeletonProvisioner.provision("latest")` runs `composer create-project laravel/laravel` in the background if the folder isn't there. Additional majors (`9.x` through `13.x`) are ticked in Settings → Laravel.
2. On first Run, `Runner.start()` spawns `php worker.php laravel-bootstrap.php` via `child_process.spawn` with `cwd` set to the active skeleton (or user-added project).
3. `worker.php` emits newline-delimited JSON frames (`ready`, `stdout`, `dump`, `result`, `error`, `cancelled`).
4. Main process parses frames → forwards to renderer via `ipcMain.on("frame")` → renderer routes by `requestId` → appends to the correct tab.

Sessions are long-lived; subsequent Runs on the same project reuse the worker (REPL state persists).

## How autocomplete works

**Intelephense LSP.** The real VS Code-grade engine. We spawn `intelephense/lib/intelephense.js` inside Electron's Node (`ELECTRON_RUN_AS_NODE=1`) and talk JSON-RPC over stdin/stdout. `src/renderer/lib/lsp-client.ts` is a hand-rolled minimal client — chosen over `monaco-languageclient` because that package wants the full `@codingame/monaco-vscode-api` replacement (~5 MB shim that repaints Monaco as VS Code). Our client is ~700 lines and does everything we need:

- `textDocument/completion` with full `additionalTextEdits` passthrough — this is what makes accepting `User::count()` auto-insert `use App\Models\User;` at the top of the buffer
- `textDocument/hover`, `textDocument/signatureHelp`
- `textDocument/publishDiagnostics` → rendered as Monaco markers (red squigglies for undefined types, methods, variables)
- `$/progress` → status-bar "Indexing Laravel… 47 %" chip while `vendor/` is being walked
- Bidirectional: responds to server-side `workspace/configuration` + `client/registerCapability` requests so Intelephense doesn't fall back to defaults

Intelephense's workspace index is cached to `~/Library/Application Support/Laravel ScratchPad/intelephense-*/`, so the first cold boot indexes `vendor/` once (~15–30 s on a fresh Laravel install) and every subsequent launch is essentially instant. Settings → General → "Clear cache & restart" wipes the cache and respawns the process for a fresh scan.

## AI completion (Ollama)

Optional inline ghost-text powered by a **local Ollama** instance. No cloud, no API keys, nothing leaves the machine — which is why it's opt-in.

### Setup

```bash
brew install ollama
ollama serve                    # starts the local daemon on :11434
ollama pull qwen2.5-coder:3b    # ~2 GB, good balance for most laptops
```

Then in the app: **Settings → AI → toggle "Enable AI completions" → Test**. When the chip turns green, start typing in a scratch buffer. After ~400 ms idle the suggestion renders as ghost text behind the caret.

- <kbd>Tab</kbd> — accept
- <kbd>Esc</kbd> — dismiss

### Recommended models

| Model                   | Size    | Notes                                                                      |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `qwen2.5-coder:1.5b`    | ~1 GB   | Fastest. Surprisingly good at short completions.                           |
| `qwen2.5-coder:3b`      | ~2 GB   | **Default.** Sweet spot for most laptops — ~150 ms/suggestion on Apple M1. |
| `qwen2.5-coder:7b`      | ~4.7 GB | Noticeably smarter. Needs 16 GB+ RAM.                                      |
| `deepseek-coder-v2:16b` | ~9 GB   | Top-tier quality. 32 GB+ machines only.                                    |

### How the FIM prompt is built

Ollama ≥ 0.3 accepts a `suffix` parameter on `/api/generate` and applies the model's native Fill-in-Middle template automatically. That's the `"auto"` FIM template option — works transparently with every model in the table above.

For exotic models or older Ollama builds, you can switch the FIM template to `qwen` / `codellama` / `deepseek` / `starcoder` / `none` in Settings → AI. The renderer will then format the prompt client-side with the template's tokens and drop the `suffix` parameter.

Request shape (pseudo-Ollama JSON):

```json
{
  "model": "qwen2.5-coder:3b",
  "prompt": "<max 4000 chars of prefix>",
  "suffix": "<max 4000 chars of suffix>",
  "stream": false,
  "options": {
    "temperature": 0.2,
    "num_predict": 128,
    "stop": ["<|endoftext|>", "<|fim_prefix|>", …]
  }
}
```

Debouncing + cancellation: the provider waits the configured `debounceMs` before firing, and binds Monaco's `CancellationToken` to an `AbortController`. If the user keeps typing, the in-flight HTTP call is aborted mid-stream — no stale ghost text, no wasted inference cycles.

Implementation lives in [`src/renderer/lib/aiCompletion.ts`](src/renderer/lib/aiCompletion.ts) (~180 lines).

## Security & Privacy

- **Renderer isolation:** the renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Privileged work stays in the main process behind the typed preload bridge.
- **IPC validation:** filesystem writes, skeleton actions, JSON-RPC forwarding, SSH configs, tab ids, and external URL opens are validated in the main process before they touch disk, shell, child processes, or the network.
- **CSP:** `src/renderer/index.html` sets a renderer CSP. Monaco currently requires `blob:` workers and dev-mode still needs inline/eval allowances; keep this list tight when touching the editor pipeline.
- **PHP `eval()` trust model:** code typed into the scratchpad executes as the current user, inside the selected local project or remote SSH project. Treat it like running `php artisan tinker` in that project: it can read project files, use the database credentials in `.env`, and call application code. It is not a sandbox for untrusted code.
- **Worker limits:** the PHP worker resets `memory_limit` to `512M` by default and applies each request's execution timeout before `eval()`. Set `LARAVEL_SCRATCHPAD_WORKER_MEMORY_LIMIT` before launching the app if a project legitimately needs more memory.
- **Secrets:** SSH passwords and key passphrases are stored only when the user chooses keychain storage, encrypted via Electron `safeStorage` backed by the OS credential store. Agent auth and prompt-every-time modes store no secret.
- **Telemetry:** the app does not send usage telemetry. Local AI completion talks only to the configured local Ollama endpoint, and the main process rejects non-local Ollama hosts.
- **Updates:** `electron-updater` checks GitHub Releases in packaged builds. On macOS, updates require signed and notarized artifacts; unsigned local builds should be treated as manual-test builds only.

## Keyboard shortcuts

| Action                 | Shortcut |
| ---------------------- | -------- |
| Run current tab        | ⌘R       |
| Cancel running code    | ⌘.       |
| New tab                | ⌘T       |
| Close current tab      | ⌘W       |
| Command palette        | ⌘K       |
| Keyboard cheatsheet    | ⌘?       |
| Settings               | ⌘,       |
| Run Artisan command    | ⌘⇧A      |
| Save buffer as snippet | ⌘⇧S      |

The cheatsheet is the authoritative list and renders from `src/renderer/lib/shortcuts.ts`.

## Architecture notes

- **Zero native-UI shenanigans**: everything is DOM + Vue. No NSTextView, no WKWebView gymnastics.
- **Process isolation**: renderer runs sandboxed with `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`. All privileged work (child_process, fs, dialog, better-sqlite3) lives in the main process, behind the typed IPC surface.
- **IPC surface** is a single typed object on `window.lsp` (see `src/shared/ipc.ts` and `src/preload/preload.ts`). A separate `window.lspBridge` carries raw JSON-RPC for Intelephense. External URL opens go through a scheme allowlist in the main process.
- **State**: Pinia for app-level state (single `useAppStore`). No Vuex.
- **Editor**: Monaco wired via a hand-rolled mount (`EditorPane.vue`) with configurable themes. Monaco ships with proper PHP tokenization — no mode quirks like CodeMirror. Scratch buffers live under the active project's workspace URI (`file://<project>/.laravel-scratchpad/tab-<id>.php`) so Intelephense treats them as real files and cross-file resolution (auto-imports, go-to-def) works.
- **SQLite layout**: one connection in WAL mode. Currently only the `snippets` table is used; old installs may also have a dormant `history` table from a previous release.
- **Tab persistence replaces run history**: the app deliberately does _not_ keep a SQLite history of every run. Tabs already cover "I want to re-run that thing from earlier" — they persist across restarts (opt-in via `general.restoreTabsOnLaunch`) and every tab holds its last run's result. Saves are debounced 400 ms to `~/Library/Application Support/LaravelScratchPad/tabs.json` and contain only `(id, title, code, connectionId)` — frames and sessionIds are runtime-only.

## Known limitations / TODOs

- Docker projects are not wired yet.
- The updater is wired to GitHub Releases, but every release candidate should be tested through a draft/prerelease before promoting it.
- **Tools pane** (models browser / routes list / env viewer / config viewer) — Tinkerwell parity still pending.
- **Embedded Ollama**: right now the user runs `ollama serve` themselves. A follow-up could bundle `llama-server` + a model download button for zero-install AI.
