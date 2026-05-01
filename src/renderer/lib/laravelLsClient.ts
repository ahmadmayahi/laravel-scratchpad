/**
 * Renderer-side LSP client for laravel-ls — the Laravel-aware companion
 * to Intelephense. Scope is intentionally narrow: completion, hover,
 * and diagnostics. Anything outside those (formatting, rename, code
 * actions) either isn't in laravel-ls yet (v0.1.0) or belongs to
 * Intelephense and would fight it for the dropdown.
 *
 * Wire transport (request/response correlation, heartbeat, bridge
 * subscription) lives in {@link ./jsonRpcClient.ts} so this file owns
 * only what's specific to laravel-ls — its narrower capability set,
 * different bridge identity, and different default trigger characters
 * for the Monaco completion provider.
 */

import * as monaco from "monaco-editor";
import { JsonRpcClient } from "./jsonRpcClient";
import type { LspDiagnostic, LspRange } from "./lsp-client";

const LANGUAGE_ID = "php";

const TRIGGER_KIND_INVOKED = 1;
const TRIGGER_KIND_TRIGGER_CHARACTER = 2;

interface LaravelLsClientOptions {
    onDiagnostics?: (d: LspDiagnostic) => void;
}

let nextLaravelLsClientSeq = 0;

export class LaravelLsClient extends JsonRpcClient {
    private openDocs = new Map<string, { version: number }>();

    constructor(
        private rootUri: string,
        private options: LaravelLsClientOptions = {},
    ) {
        super({
            bridge: window.laravelLsBridge,
            idPrefix: `ll${++nextLaravelLsClientSeq}-`,
            serverName: "laravel-ls",
            timeoutFor,
        });
    }

    async start(): Promise<void> {
        this.startTransport();
        await this.request("initialize", {
            processId: null,
            rootUri: this.rootUri,
            capabilities: defaultClientCapabilities(),
            workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
            initializationOptions: {},
        });
        this.notify("initialized", {});
        this.completeStart();
    }

    didOpen(uri: string, text: string): void {
        const run = (): void => {
            this.openDocs.set(uri, { version: 1 });
            this.notify("textDocument/didOpen", {
                textDocument: { uri, languageId: LANGUAGE_ID, version: 1, text },
            });
        };
        if (this.initialized) run();
        else this.queuedOpens.push(run);
    }

    /**
     * laravel-ls declares `TextDocumentSyncKindIncremental` in its init
     * response — it expects range-delimited edits, not full-document
     * replacements (its handler tree-sitter-edits against the supplied
     * range, and a zero-valued range on a full-doc payload corrupts the
     * parse tree). Callers should forward Monaco's per-event
     * `onDidChangeModelContent` changes directly here, no debounce.
     */
    didChange(uri: string, changes: Array<{ range: LspRange; text: string }>): void {
        if (!this.initialized) return;
        const doc = this.openDocs.get(uri);
        if (!doc) return;
        if (changes.length === 0) return;
        doc.version++;
        this.notify("textDocument/didChange", {
            textDocument: { uri, version: doc.version },
            contentChanges: changes,
        });
    }

    didClose(uri: string): void {
        if (!this.initialized || !this.openDocs.has(uri)) return;
        this.openDocs.delete(uri);
        this.notify("textDocument/didClose", { textDocument: { uri } });
    }

    async completion(
        uri: string,
        position: monaco.IPosition,
        triggerCharacter?: string,
    ): Promise<CompletionResponse | null> {
        if (!this.initialized) return null;
        try {
            return (await this.request("textDocument/completion", {
                textDocument: { uri },
                position: { line: position.lineNumber - 1, character: position.column - 1 },
                context: triggerCharacter
                    ? { triggerKind: TRIGGER_KIND_TRIGGER_CHARACTER, triggerCharacter }
                    : { triggerKind: TRIGGER_KIND_INVOKED },
            })) as CompletionResponse | null;
        } catch {
            return null;
        }
    }

    async hover(uri: string, position: monaco.IPosition): Promise<HoverResponse | null> {
        if (!this.initialized) return null;
        try {
            return (await this.request("textDocument/hover", {
                textDocument: { uri },
                position: { line: position.lineNumber - 1, character: position.column - 1 },
            })) as HoverResponse | null;
        } catch {
            return null;
        }
    }

    protected override handleServerRequest(msg: {
        id: number | string;
        method: string;
        params?: unknown;
    }): void {
        // Acknowledge silently for the lifecycle methods we know to expect;
        // everything else gets `-32601` so the server can adapt instead of
        // assuming we silently implemented a capability we never declared.
        if (
            msg.method === "client/registerCapability" ||
            msg.method === "client/unregisterCapability" ||
            msg.method === "window/workDoneProgress/create"
        ) {
            this.respond(msg.id, null);
            return;
        }
        this.respondError(msg.id, -32601, `Method not handled: ${msg.method}`);
    }

    protected override handleServerNotification(msg: { method: string; params?: unknown }): void {
        if (msg.method === "textDocument/publishDiagnostics") {
            if (!this.options.onDiagnostics) return;
            const params = msg.params as {
                uri: string;
                diagnostics: Array<{
                    range: LspRange;
                    severity?: 1 | 2 | 3 | 4;
                    message: string;
                    source?: string;
                    code?: string | number;
                }>;
            };
            this.options.onDiagnostics({
                uri: params.uri,
                markers: params.diagnostics.map((d) => ({
                    severity: mapSeverity(d.severity),
                    startLineNumber: d.range.start.line + 1,
                    startColumn: d.range.start.character + 1,
                    endLineNumber: d.range.end.line + 1,
                    endColumn: d.range.end.character + 1,
                    message: d.message,
                    source: d.source ?? "laravel-ls",
                    code: d.code !== undefined ? String(d.code) : undefined,
                })),
            });
            return;
        }
        // Everything else (window/logMessage, $/progress, workspace/*) is
        // safe to ignore — laravel-ls is chatty but we don't need to react
        // to its log lines.
    }
}

function timeoutFor(method: string): number {
    switch (method) {
        case "textDocument/completion":
            return 10_000;
        case "textDocument/hover":
            return 3_000;
        case "initialize":
            return 15_000;
        default:
            return 5_000;
    }
}

// ---------------------------------------------------------------------------
// LSP → Monaco glue
// ---------------------------------------------------------------------------

/**
 * Register laravel-ls's completion + hover providers against Monaco's
 * "php" language. Monaco supports multiple providers per language out of
 * the box — our Intelephense providers from lsp-client.ts keep running
 * alongside these and the suggestion dropdown merges both sets. We route
 * all diagnostics through a dedicated `"laravel-ls"` marker owner so
 * they sit independently of Intelephense's own markers.
 */
export function registerLaravelLsProviders(client: LaravelLsClient, documentUri: string): monaco.IDisposable[] {
    return [
        monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
            // Narrow trigger chars: only the quotes that open a string
            // literal. Wider triggers (`.`, `(`, `,`, `-`, `>`) fire on
            // every PHP method call, string concat, comma, etc. — each
            // sends a completion request to laravel-ls that returns
            // empty for non-Laravel contexts, and an empty response
            // replaces the current Monaco suggestion list (clobbering
            // Intelephense's results, making the popup vanish mid-type).
            // Dotted config keys like `app.database` don't need `.` as
            // a trigger because Monaco keeps filtering the initial list
            // client-side as you type.
            triggerCharacters: ["'", '"'],
            async provideCompletionItems(model, position, context) {
                const triggerCharacter =
                    context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter
                        ? context.triggerCharacter
                        : undefined;
                const resp = await client.completion(
                    documentUri,
                    { lineNumber: position.lineNumber, column: position.column },
                    triggerCharacter,
                );
                if (!resp) return { suggestions: [] };
                const items = Array.isArray(resp) ? resp : resp.items;
                if (!items) return { suggestions: [] };

                const word = model.getWordUntilPosition(position);
                const fallbackRange = new monaco.Range(
                    position.lineNumber,
                    word.startColumn,
                    position.lineNumber,
                    word.endColumn,
                );
                return {
                    suggestions: items.map((item) => toMonacoCompletion(item, fallbackRange)),
                    incomplete: Array.isArray(resp) ? false : !!resp.isIncomplete,
                };
            },
        }),
        monaco.languages.registerHoverProvider(LANGUAGE_ID, {
            async provideHover(_model, position) {
                const resp = await client.hover(documentUri, {
                    lineNumber: position.lineNumber,
                    column: position.column,
                });
                if (!resp || !resp.contents) return null;
                const contents = Array.isArray(resp.contents) ? resp.contents : [resp.contents];
                return {
                    contents: contents.map((c) => ({ value: typeof c === "string" ? c : c.value })),
                    range: resp.range ? lspRangeToMonaco(resp.range) : undefined,
                };
            },
        }),
    ];
}

function toMonacoCompletion(item: CompletionItem, fallbackRange: monaco.Range): monaco.languages.CompletionItem {
    const textEdit = item.textEdit;
    // Keep insert + replace ranges separate when the server sends them.
    // Collapsing to just `insert` caused Monaco to filter items out as
    // soon as the cursor crossed the insert end — the "second time
    // never works" symptom — because no item's range contained the new
    // cursor position.
    const range: monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange } = textEdit
        ? "range" in textEdit
            ? lspRangeToMonaco(textEdit.range)
            : { insert: lspRangeToMonaco(textEdit.insert), replace: lspRangeToMonaco(textEdit.replace) }
        : fallbackRange;
    const labelText = typeof item.label === "string" ? item.label : item.label.label;
    const insertText = textEdit ? textEdit.newText : (item.insertText ?? labelText);

    return {
        label: labelText,
        kind: mapKind(item.kind),
        insertText,
        insertTextRules:
            item.insertTextFormat === 2 && /\$\d|\$\{/.test(insertText)
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
        detail: item.detail,
        documentation: item.documentation
            ? { value: typeof item.documentation === "string" ? item.documentation : item.documentation.value }
            : undefined,
        range,
        sortText: item.sortText,
        filterText: item.filterText,
        preselect: item.preselect,
    };
}

function mapKind(kind: number | undefined): monaco.languages.CompletionItemKind {
    const K = monaco.languages.CompletionItemKind;
    switch (kind) {
        case 1:
            return K.Text;
        case 2:
            return K.Method;
        case 3:
            return K.Function;
        case 4:
            return K.Constructor;
        case 5:
            return K.Field;
        case 6:
            return K.Variable;
        case 7:
            return K.Class;
        case 8:
            return K.Interface;
        case 9:
            return K.Module;
        case 10:
            return K.Property;
        case 11:
            return K.Unit;
        case 12:
            return K.Value;
        case 13:
            return K.Enum;
        case 14:
            return K.Keyword;
        case 15:
            return K.Snippet;
        case 16:
            return K.Color;
        case 17:
            return K.File;
        case 18:
            return K.Reference;
        case 19:
            return K.Folder;
        case 20:
            return K.EnumMember;
        case 21:
            return K.Constant;
        case 22:
            return K.Struct;
        case 23:
            return K.Event;
        case 24:
            return K.Operator;
        case 25:
            return K.TypeParameter;
        default:
            return K.Value;
    }
}

function mapSeverity(sev: number | undefined): monaco.MarkerSeverity {
    const S = monaco.MarkerSeverity;
    switch (sev) {
        case 1:
            return S.Error;
        case 2:
            return S.Warning;
        case 3:
            return S.Info;
        case 4:
            return S.Hint;
        default:
            return S.Info;
    }
}

function lspRangeToMonaco(range: LspRange): monaco.Range {
    return new monaco.Range(
        range.start.line + 1,
        range.start.character + 1,
        range.end.line + 1,
        range.end.character + 1,
    );
}

function defaultClientCapabilities(): unknown {
    return {
        textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: {
                dynamicRegistration: false,
                completionItem: {
                    snippetSupport: true,
                    documentationFormat: ["markdown", "plaintext"],
                    preselectSupport: true,
                    insertReplaceSupport: true,
                },
                completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
                contextSupport: true,
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
            workspaceFolders: true,
            configuration: true,
        },
        window: { workDoneProgress: false },
    };
}

// ---------------------------------------------------------------------------
// LSP protocol types (subset used here)
// ---------------------------------------------------------------------------

interface CompletionItem {
    label: string | { label: string };
    kind?: number;
    detail?: string;
    documentation?: string | { kind: string; value: string };
    insertText?: string;
    insertTextFormat?: 1 | 2;
    textEdit?: { range: LspRange; newText: string } | { insert: LspRange; replace: LspRange; newText: string };
    sortText?: string;
    filterText?: string;
    preselect?: boolean;
}

type CompletionResponse = CompletionItem[] | { isIncomplete?: boolean; items: CompletionItem[] } | null;

interface HoverResponse {
    contents: string | { value: string } | Array<string | { value: string }>;
    range?: LspRange;
}
