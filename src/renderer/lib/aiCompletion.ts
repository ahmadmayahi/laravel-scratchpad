import * as monaco from "monaco-editor";
import type { FimTemplate, Settings } from "../../shared/ipc";

/**
 * Monaco inline-completions (ghost text) provider backed by a local Ollama
 * server.
 *
 * The HTTP call itself happens in the main process (see `src/main/ollama.ts`)
 * — Electron's `net.fetch` there has no CORS check, so we don't run into
 * Ollama's default `OLLAMA_ORIGINS` rejection of `file://` / `null`
 * renderer origins. The renderer just shapes the request and handles the
 * Monaco-side lifecycle.
 *
 * Debouncing uses Monaco's CancellationToken so in-flight HTTP calls abort
 * as soon as the cursor moves again — no stale suggestions and no wasted
 * inference cycles.
 */

const LANGUAGES = ["php"];

export interface AiProviderHandle {
    dispose(): void;
}

export function registerAiInlineProvider(ai: Settings["ai"]): AiProviderHandle {
    if (!ai.enabled) return { dispose() {} };

    const disposables: monaco.IDisposable[] = [];
    for (const languageId of LANGUAGES) {
        disposables.push(
            monaco.languages.registerInlineCompletionsProvider(languageId, {
                async provideInlineCompletions(model, position, _context, token) {
                    if (await cancelled(ai.debounceMs, token)) return null;

                    const { prefix, suffix } = splitAtCursor(model, position, ai.maxContextChars);
                    if (prefix.trim().length === 0) return null;

                    const text = await callOllama(ai, prefix, suffix, token);
                    if (!text || token.isCancellationRequested) return null;

                    return {
                        items: [
                            {
                                insertText: text,
                                range: new monaco.Range(
                                    position.lineNumber,
                                    position.column,
                                    position.lineNumber,
                                    position.column,
                                ),
                            },
                        ],
                    };
                },
                // Monaco 0.55+ renamed `freeInlineCompletions` →
                // `disposeInlineCompletions`. It's a required member now; we
                // have nothing to free per-request, so the body is empty.
                disposeInlineCompletions() {
                    /* noop — no per-result state */
                },
            }),
        );
    }
    return {
        dispose() {
            for (const d of disposables) d.dispose();
        },
    };
}

let nextRequestId = 0;

async function callOllama(
    cfg: Settings["ai"],
    prefix: string,
    suffix: string,
    token: monaco.CancellationToken,
): Promise<string | null> {
    const requestId = `ai-${++nextRequestId}`;
    const stop = fimStopTokens(cfg.fimTemplate);

    // `auto` → let Ollama apply the model's native FIM template by passing
    // `suffix` alongside the prompt. For explicit templates, we format the
    // prompt client-side and omit `suffix`.
    const body: Parameters<typeof window.lsp.aiGenerate>[2] = {
        model: cfg.model,
        prompt:
            cfg.fimTemplate === "auto" || cfg.fimTemplate === "none"
                ? prefix
                : formatFim(cfg.fimTemplate, prefix, suffix),
        options: {
            temperature: cfg.temperature,
            num_predict: cfg.maxTokens,
            stop,
        },
    };
    if (cfg.fimTemplate === "auto") {
        body.suffix = suffix;
    }

    // Bind the cancellation token to the main-process AbortController so
    // in-flight completions tear down the moment the cursor moves again.
    const reg = token.onCancellationRequested(() => {
        void window.lsp.aiAbort(requestId);
    });

    try {
        const { text } = await window.lsp.aiGenerate(cfg.endpoint, requestId, body);
        return sanitize(text ?? undefined, stop);
    } catch {
        return null;
    } finally {
        reg.dispose();
    }
}

function formatFim(template: FimTemplate, prefix: string, suffix: string): string {
    switch (template) {
        case "qwen":
            return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
        case "codellama":
            return `<PRE> ${prefix} <SUF>${suffix} <MID>`;
        case "deepseek":
            return `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`;
        case "starcoder":
            return `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`;
        default:
            return prefix;
    }
}

function fimStopTokens(template: FimTemplate): string[] {
    switch (template) {
        case "qwen":
            return ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>", "<|file_separator|>"];
        case "codellama":
            return ["<PRE>", "<SUF>", "<MID>", "<EOT>"];
        case "deepseek":
            return ["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>"];
        case "starcoder":
            return ["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|endoftext|>"];
        default:
            return [];
    }
}

/**
 * Clip the returned text at the first FIM marker the model leaked — some
 * models occasionally echo these back in their output even though we asked
 * them to stop at them.
 */
function sanitize(raw: string | undefined, stops: string[]): string | null {
    if (!raw) return null;
    let text = raw;
    for (const s of stops) {
        const idx = text.indexOf(s);
        if (idx >= 0) text = text.slice(0, idx);
    }
    while (text.endsWith("\0")) {
        text = text.slice(0, -1);
    }
    return text.length > 0 ? text : null;
}

function splitAtCursor(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    maxChars: number,
): { prefix: string; suffix: string } {
    const lineCount = model.getLineCount();
    const last = model.getLineMaxColumn(lineCount);
    const rawPrefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
    const rawSuffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, lineCount, last));
    return {
        prefix: rawPrefix.length > maxChars ? rawPrefix.slice(rawPrefix.length - maxChars) : rawPrefix,
        suffix: rawSuffix.length > maxChars ? rawSuffix.slice(0, maxChars) : rawSuffix,
    };
}

/**
 * Sleep `ms` or until the token fires. Returns true if the wait was
 * cancelled. Declarations are ordered so no closure captures a variable
 * before its `const` binding has run — avoids any TDZ ambiguity even
 * though the setTimeout callback only ever fires after both bindings
 * exist.
 */
function cancelled(ms: number, token: monaco.CancellationToken): Promise<boolean> {
    if (token.isCancellationRequested) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        let reg: monaco.IDisposable | null = null;
        const t = setTimeout(() => {
            reg?.dispose();
            resolve(false);
        }, ms);
        reg = token.onCancellationRequested(() => {
            clearTimeout(t);
            resolve(true);
        });
    });
}
