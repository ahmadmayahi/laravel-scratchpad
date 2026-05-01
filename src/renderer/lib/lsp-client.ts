/**
 * Renderer-side LSP client for Intelephense, wired to Monaco.
 *
 * Intentionally narrow surface: completion (with resolve), hover,
 * signature help, plus diagnostics + work-done progress streams.
 * Anything more ambitious belongs in a full IDE — this is a scratchpad.
 *
 * Scratch buffers always begin with a visible `<?php` opener on line 1,
 * so Intelephense and Monaco share the *exact same* view of the
 * document — no synthetic prefix injection, no line-offset bookkeeping,
 * no drift. The opener is also what flips Monaco's PHP tokenizer on;
 * without it, the buffer highlights as HTML. The runner strips the
 * opener before eval'ing.
 *
 * Wire transport (request/response correlation, heartbeat, bridge
 * subscription) lives in {@link ./jsonRpcClient.ts} so this file owns
 * only the parts that diverge from laravel-ls: initialize options,
 * server-side request handling, and Monaco glue.
 */

import * as monaco from "monaco-editor";
import { JsonRpcClient } from "./jsonRpcClient";

const LANGUAGE_ID = "php";

// LSP `CompletionTriggerKind` values per spec.
const TRIGGER_KIND_INVOKED = 1;
const TRIGGER_KIND_TRIGGER_CHARACTER = 2;
const TEXT_DOCUMENT_SYNC_KIND_FULL = 1;
const TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL = 2;

export interface LspDiagnostic {
    uri: string;
    markers: monaco.editor.IMarkerData[];
}

interface LspProgressEvent {
    token: string | number;
    kind: "begin" | "report" | "end";
    title?: string;
    message?: string;
    percentage?: number;
}

interface IntelephenseClientOptions {
    storagePath?: string;
    globalStoragePath?: string;
    onDiagnostics?: (d: LspDiagnostic) => void;
    onProgress?: (e: LspProgressEvent) => void;
    phpVersion?: string;
}

export interface LspTextChange {
    range: LspRange;
    text: string;
}

/** Per-client monotonic discriminator for JSON-RPC ids. */
let nextClientSeq = 0;

export class IntelephenseClient extends JsonRpcClient {
    private textDocumentSyncKind = TEXT_DOCUMENT_SYNC_KIND_FULL;
    private openDocs = new Map<string, { version: number; languageId: string }>();

    constructor(
        private rootUri: string,
        private options: IntelephenseClientOptions = {},
        private capabilities: unknown = defaultClientCapabilities(),
    ) {
        super({
            bridge: window.lspBridge,
            idPrefix: `ip${++nextClientSeq}-`,
            serverName: "LSP",
            timeoutFor,
        });
    }

    async start(): Promise<void> {
        this.startTransport();
        const initResult = await this.request("initialize", {
            processId: null,
            rootUri: this.rootUri,
            capabilities: this.capabilities,
            workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
            initializationOptions: {
                globalStoragePath: this.options.globalStoragePath ?? null,
                storagePath: this.options.storagePath ?? null,
                clearCache: false,
                licenceKey: null,
            },
        });
        // The spec requires initialize to return `{ capabilities: {...} }`.
        // A null / non-object response means the server is malformed or the
        // transport lied to us — either way, downstream capability reads
        // would silently fall through to defaults and mis-configure sync,
        // so bail noisily instead.
        if (!initResult || typeof initResult !== "object") {
            throw new Error("LSP initialize returned an invalid response");
        }
        this.textDocumentSyncKind = resolveTextDocumentSyncKind(initResult);
        this.notify("initialized", {});
        this.notify("workspace/didChangeConfiguration", {
            settings: { intelephense: this.intelephenseSettings() },
        });
        this.completeStart();
    }

    didOpen(uri: string, languageId: string, text: string): void {
        const run = (): void => {
            this.openDocs.set(uri, { version: 1, languageId });
            this.notify("textDocument/didOpen", {
                textDocument: { uri, languageId, version: 1, text },
            });
        };
        if (this.initialized) run();
        else this.queuedOpens.push(run);
    }

    supportsIncrementalSync(): boolean {
        return this.textDocumentSyncKind === TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL;
    }

    didChange(uri: string, changes: LspTextChange[] | string): void {
        if (!this.initialized) return;
        const doc = this.openDocs.get(uri);
        if (!doc) return;
        doc.version++;
        this.notify("textDocument/didChange", {
            textDocument: { uri, version: doc.version },
            contentChanges: Array.isArray(changes)
                ? changes.map((change) => ({
                      range: change.range,
                      text: change.text,
                  }))
                : [{ text: changes }],
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

    async resolveCompletionItem(item: CompletionItem): Promise<CompletionItem | null> {
        if (!this.initialized) return null;
        try {
            return (await this.request("completionItem/resolve", item)) as CompletionItem;
        } catch (err) {
            // Resolve failures are usually a timeout while the server is
            // busy indexing — surfacing them helps diagnose why hover docs
            // occasionally come back blank. Not fatal; the un-resolved
            // item is still shown in the suggest widget.
            console.warn("[lsp] completionItem/resolve failed:", (err as Error).message);
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

    async signatureHelp(
        uri: string,
        position: monaco.IPosition,
        triggerCharacter?: string,
    ): Promise<SignatureHelpResponse | null> {
        if (!this.initialized) return null;
        try {
            return (await this.request("textDocument/signatureHelp", {
                textDocument: { uri },
                position: { line: position.lineNumber - 1, character: position.column - 1 },
                context: triggerCharacter
                    ? { triggerKind: TRIGGER_KIND_TRIGGER_CHARACTER, triggerCharacter, isRetrigger: false }
                    : { triggerKind: TRIGGER_KIND_INVOKED, isRetrigger: false },
            })) as SignatureHelpResponse | null;
        } catch {
            return null;
        }
    }

    protected override handleServerRequest(msg: {
        id: number | string;
        method: string;
        params?: unknown;
    }): void {
        switch (msg.method) {
            case "workspace/configuration": {
                const items = (msg.params as { items?: Array<{ section?: string }> })?.items ?? [];
                this.respond(
                    msg.id,
                    items.map((item) =>
                        !item.section || item.section === "intelephense" ? this.intelephenseSettings() : null,
                    ),
                );
                return;
            }
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "window/workDoneProgress/create":
                this.respond(msg.id, null);
                return;
            default:
                this.respondError(msg.id, -32601, `Method not handled: ${msg.method}`);
        }
    }

    protected override handleServerNotification(msg: { method: string; params?: unknown }): void {
        switch (msg.method) {
            case "textDocument/publishDiagnostics": {
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
                        source: d.source ?? "intelephense",
                        code: d.code !== undefined ? String(d.code) : undefined,
                    })),
                });
                return;
            }
            case "$/progress": {
                const params = msg.params as {
                    token: string | number;
                    value: {
                        kind: "begin" | "report" | "end";
                        title?: string;
                        message?: string;
                        percentage?: number;
                    };
                };
                this.options.onProgress?.({
                    token: params.token,
                    kind: params.value.kind,
                    title: params.value.title,
                    message: params.value.message,
                    percentage: params.value.percentage,
                });
                return;
            }
            case "indexingStarted":
                this.options.onProgress?.({
                    token: "intelephense-index",
                    kind: "begin",
                    title: "Indexing Laravel project",
                });
                return;
            case "indexingEnded":
                this.options.onProgress?.({ token: "intelephense-index", kind: "end" });
                return;
            default:
                // window/logMessage, window/showMessage, etc. — ignore.
                return;
        }
    }

    private intelephenseSettings(): unknown {
        return {
            environment: {
                phpVersion: this.options.phpVersion ?? "8.2",
                includePaths: [],
            },
            files: {
                associations: ["*.php", "*.phtml"],
                exclude: [
                    "**/.git/**",
                    "**/.svn/**",
                    "**/.hg/**",
                    "**/CVS/**",
                    "**/.DS_Store/**",
                    "**/node_modules/**",
                    "**/bower_components/**",
                    "**/vendor/**/{Tests,tests}/**",
                    "**/.history/**",
                    "**/vendor/**/vendor/**",
                    "**/storage/framework/**",
                    "**/storage/logs/**",
                    "**/bootstrap/cache/**",
                ],
                maxSize: 5_000_000,
            },
            completion: {
                insertUseDeclaration: true,
                fullyQualifyGlobalConstantsAndFunctions: false,
                triggerParameterHints: true,
                // Default (100) was truncating `Model::__callStatic` fan-outs
                // on Eloquent — the common `where`, `whereHas`, `whereIn`
                // were getting cut in favor of less-frequent variants because
                // Intelephense's truncation order isn't frequency-aware.
                // Monaco filters the full list client-side, so a bigger
                // payload here is essentially free.
                maxItems: 1000,
            },
            format: { enable: false },
            diagnostics: {
                enable: true,
                run: "onType",
                embeddedLanguages: true,
                undefinedTypes: true,
                undefinedFunctions: true,
                undefinedConstants: true,
                undefinedClassConstants: true,
                undefinedMethods: true,
                undefinedProperties: true,
                undefinedVariables: true,
                unusedSymbols: true,
                unexpectedTokens: true,
                duplicateSymbols: true,
                implementationErrors: true,
                languageConstraints: true,
                deprecated: true,
            },
            phpdoc: {
                returnVoid: true,
                textFormat: "snippet",
            },
            references: { exclude: ["**/vendor/**"] },
            runtime: "node",
            telemetry: { enabled: false },
        };
    }
}

function resolveTextDocumentSyncKind(initResult: unknown): number {
    const sync = (
        initResult as {
            capabilities?: {
                textDocumentSync?: number | { change?: number };
            };
        }
    )?.capabilities?.textDocumentSync;

    if (typeof sync === "number") return sync;
    if (sync && typeof sync === "object" && typeof sync.change === "number") {
        return sync.change;
    }
    return TEXT_DOCUMENT_SYNC_KIND_FULL;
}

// Per-method timeout table. Completion gets generous slack on first use
// against a cold cache; conversational calls stay tight.
function timeoutFor(method: string): number {
    switch (method) {
        case "textDocument/completion":
            return 15_000;
        case "completionItem/resolve":
            return 10_000;
        case "textDocument/hover":
            return 3_000;
        case "textDocument/signatureHelp":
            return 3_000;
        case "initialize":
            return 30_000;
        default:
            return 5_000;
    }
}

// ---------------------------------------------------------------------------
// LSP → Monaco glue
// ---------------------------------------------------------------------------

export function registerLspProviders(client: IntelephenseClient, documentUri: string): monaco.IDisposable[] {
    return [
        monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
            triggerCharacters: ["$", ":", ">", "\\", "(", ",", "=", "-", " ", "@", "'", '"', "_"],
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
                    suggestions: items.map((item) => {
                        const mc = toMonacoCompletion(item, fallbackRange);
                        (mc as MonacoCompletionWithLsp).__lspItem = item;
                        return mc;
                    }),
                    incomplete: Array.isArray(resp) ? false : !!resp.isIncomplete,
                };
            },
            // Called by Monaco when the user focuses an item. Intelephense
            // attaches the expensive fields here — docs, detail, and the
            // `additionalTextEdits` that carry `use App\\Models\\User;`.
            async resolveCompletionItem(item) {
                const lspItem = (item as MonacoCompletionWithLsp).__lspItem;
                if (!lspItem) return item;
                const resolved = await client.resolveCompletionItem(lspItem);
                if (!resolved) return item;
                return mergeResolvedIntoMonaco(item, resolved);
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
        monaco.languages.registerSignatureHelpProvider(LANGUAGE_ID, {
            signatureHelpTriggerCharacters: ["(", ","],
            signatureHelpRetriggerCharacters: [","],
            async provideSignatureHelp(_model, position) {
                const resp = await client.signatureHelp(documentUri, {
                    lineNumber: position.lineNumber,
                    column: position.column,
                });
                if (!resp || !resp.signatures?.length) return null;
                return {
                    value: {
                        signatures: resp.signatures.map((sig) => ({
                            label: sig.label,
                            documentation: sig.documentation
                                ? {
                                      value:
                                          typeof sig.documentation === "string"
                                              ? sig.documentation
                                              : sig.documentation.value,
                                  }
                                : undefined,
                            parameters: (sig.parameters ?? []).map((p) => ({
                                label: p.label as string | [number, number],
                                documentation: p.documentation
                                    ? {
                                          value:
                                              typeof p.documentation === "string"
                                                  ? p.documentation
                                                  : p.documentation.value,
                                      }
                                    : undefined,
                            })),
                        })),
                        activeSignature: resp.activeSignature ?? 0,
                        activeParameter: resp.activeParameter ?? 0,
                    },
                    dispose: () => {},
                };
            },
        }),
    ];
}

/**
 * Snippet-format detection: Intelephense sometimes tags plain class names
 * as `insertTextFormat: 2` (Snippet). Monaco's snippet parser treats `\`
 * as an escape char, mangling `App\Models\User` into `AppModelsUser`. We
 * only treat the text as a snippet if it actually contains `$N` / `${…}`
 * placeholder syntax.
 */
function isRealSnippet(text: string): boolean {
    return /\$\d|\$\{/.test(text);
}

type MonacoCompletionRange = monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange };

function completionTextEditRangeToMonaco(textEdit: NonNullable<CompletionItem["textEdit"]>): MonacoCompletionRange {
    return "range" in textEdit
        ? lspRangeToMonaco(textEdit.range)
        : {
              insert: lspRangeToMonaco(textEdit.insert),
              replace: lspRangeToMonaco(textEdit.replace),
          };
}

function toMonacoCompletion(item: CompletionItem, fallbackRange: monaco.Range): monaco.languages.CompletionItem {
    const textEdit = item.textEdit;
    // Preserve Intelephense's insert/replace split when it sends one.
    // Dropping the replace range made Monaco filter items the moment the
    // cursor crossed the insert-range end — the popup looked like it
    // "worked once and disappeared" because each subsequent keystroke
    // fell outside every item's range and Monaco discarded the list.
    const range: MonacoCompletionRange = textEdit ? completionTextEditRangeToMonaco(textEdit) : fallbackRange;
    const labelText = typeof item.label === "string" ? item.label : item.label.label;
    const insertText = textEdit ? textEdit.newText : (item.insertText ?? labelText);

    const additionalTextEdits = item.additionalTextEdits?.map((e) => ({
        range: lspRangeToMonaco(e.range),
        text: e.newText,
    }));

    return {
        label: labelText,
        kind: mapKind(item.kind),
        insertText,
        insertTextRules:
            item.insertTextFormat === 2 && isRealSnippet(insertText)
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
        additionalTextEdits,
        command: item.command
            ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments }
            : undefined,
    };
}

interface MonacoCompletionWithLsp extends monaco.languages.CompletionItem {
    __lspItem?: CompletionItem;
}

function mergeResolvedIntoMonaco(
    item: monaco.languages.CompletionItem,
    resolved: CompletionItem,
): monaco.languages.CompletionItem {
    const labelText = typeof resolved.label === "string" ? resolved.label : resolved.label.label;
    const additionalTextEdits = resolved.additionalTextEdits?.map((e) => ({
        range: lspRangeToMonaco(e.range),
        text: e.newText,
    }));

    return {
        ...item,
        label: labelText,
        detail: resolved.detail ?? item.detail,
        documentation: resolved.documentation
            ? {
                  value:
                      typeof resolved.documentation === "string"
                          ? resolved.documentation
                          : resolved.documentation.value,
              }
            : item.documentation,
        additionalTextEdits: additionalTextEdits ?? item.additionalTextEdits,
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
            synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
            completion: {
                dynamicRegistration: false,
                completionItem: {
                    snippetSupport: true,
                    documentationFormat: ["markdown", "plaintext"],
                    preselectSupport: true,
                    insertReplaceSupport: true,
                    resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
                },
                completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
                contextSupport: true,
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            signatureHelp: {
                signatureInformation: {
                    documentationFormat: ["markdown", "plaintext"],
                    parameterInformation: { labelOffsetSupport: true },
                    activeParameterSupport: true,
                },
            },
            publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
            workspaceFolders: true,
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: false },
        },
        window: { workDoneProgress: true },
    };
}

// ---------------------------------------------------------------------------
// LSP protocol types (subset used here)
// ---------------------------------------------------------------------------

export interface LspRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

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
    additionalTextEdits?: Array<{ range: LspRange; newText: string }>;
    command?: { title: string; command: string; arguments?: unknown[] };
}

type CompletionResponse = CompletionItem[] | { isIncomplete?: boolean; items: CompletionItem[] } | null;

interface HoverResponse {
    contents: string | { value: string } | Array<string | { value: string }>;
    range?: LspRange;
}

interface SignatureHelpResponse {
    signatures: Array<{
        label: string;
        documentation?: string | { value: string };
        parameters?: Array<{
            label: string | [number, number];
            documentation?: string | { value: string };
        }>;
    }>;
    activeSignature?: number;
    activeParameter?: number;
}
