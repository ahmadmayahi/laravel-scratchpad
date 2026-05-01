# Contributing to Laravel ScratchPad

Thanks for your interest in contributing. This document covers how to set up a dev environment, what we expect in a PR, and the conventions the codebase follows.

All project spaces are covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Requirements

- **Node.js** 20 or newer (Electron 41 ships with a bundled runtime; these are for the build toolchain).
- **npm** 10+ (ships with Node 20).
- **PHP** 8.1 or newer on `$PATH` if you want to run the app end-to-end (the app discovers Homebrew / Herd / asdf / system installs automatically — see [`src/main/phpVersions.ts`](src/main/phpVersions.ts)).
- **Composer** 2.x — needed the first time the app provisions a Laravel skeleton.
- **Platform:** macOS 11+, Windows 10+, or a modern Linux distro with glibc ≥ 2.31. On Windows, native module rebuilds (`better-sqlite3`, `ssh2`) require Visual Studio 2019+ Build Tools.

## Getting started

```bash
git clone https://github.com/ahmadmayahi/laravel-scratchpad.git
cd laravel-scratchpad
npm install
npm run dev        # Vite + Electron with hot reload
```

`npm run dev` boots Vite on `http://127.0.0.1:5173` and launches Electron against it. Main-process changes (`src/main/**`) require a restart — kill the process and re-run.

Other useful scripts:

```bash
npm run typecheck   # tsc + vue-tsc, no emit
npm run lint        # ESLint across main + renderer
npm run format      # Prettier write
npm run build       # compile main + bundle renderer for production
npm run pack        # unpacked Electron build under ./release (fast sanity check)
npm run dist        # full platform installer(s) under ./release
```

## Project layout

See the tree at the top of [README.md](README.md) for the full map. The essentials:

- `src/main/` — Node/Electron main process: IPC handlers, child-process orchestration, SQLite, LSP lifecycle, secret vault, SSH transport.
- `src/renderer/` — Vue 3 + Monaco + Pinia. No Node APIs; talks to main over the typed bridge in `src/preload/preload.ts`.
- `src/shared/` — types and helpers shared across the process boundary. Keep this dependency-free.
- `resources/worker.php` — the PHP REPL worker. Security-critical — see [README.md](README.md#security--privacy).

## Code style

- **TypeScript strict.** Avoid `any`; reach for discriminated unions instead.
- **ESLint + Prettier** enforce formatting. Run `npm run lint` and `npm run format` before opening a PR.
- **Comments explain _why_, never _what_.** Identifier names handle the _what_.
- **No dead code** or commented-out blocks — delete or ship.
- **Error handling at boundaries.** Internal code trusts its callers; only validate at IPC / shell / filesystem edges.
- **Security over ergonomics** when they conflict, especially around the IPC surface and child-process args.

## Security boundaries

The renderer is sandboxed (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`) and can only talk to main via the typed bridge on `window.lsp` (see [src/preload/preload.ts](src/preload/preload.ts)). When adding a new IPC handler:

1. Add the type to [src/shared/ipc.ts](src/shared/ipc.ts).
2. Expose it on the preload bridge.
3. **Validate every input** in the main-process handler — strings that become paths, command arguments, or filesystem writes must be bounded by regex or whitelist.
4. Never interpolate renderer-supplied values into shell strings. Pass as argv arrays, or quote with the `shellQuote` helper in [src/main/sshSession.ts](src/main/sshSession.ts).

If you spot a security issue, **do not** open a public issue — email the maintainer directly (see `package.json` → `author.email`).

## Commit and PR conventions

- **One logical change per PR.** Unrelated cleanups are easier to review separately.
- **Commit messages:** short imperative subject (<72 chars), blank line, optional body explaining _why_. We don't mandate Conventional Commits but consistent prefixes (`fix:`, `feat:`, `chore:`) are welcome.
- **Before requesting review:** `npm run typecheck && npm run lint && npm run build` all green.
- **Describe user-visible changes** in the PR body. Screenshots or a short screen recording for UI changes are gold.

## Reporting bugs

Open an issue with:

- What you did (steps).
- What you expected.
- What happened (stack trace, screenshot, copy of the result pane).
- Platform + app version (visible in the About panel) + PHP version.

For crashes, attach the log file. On macOS it lives at `~/Library/Logs/Laravel ScratchPad/`; on Linux at `~/.config/Laravel ScratchPad/logs/`; on Windows at `%APPDATA%\Laravel ScratchPad\logs\`.

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
