<?php
/**
 * Laravel ScratchPad PHP worker.
 *
 * Reads newline-delimited JSON requests from stdin, evaluates PHP code,
 * and writes newline-delimited JSON frames to stdout.
 *
 * Request shape:
 *   {"id":"<uuid>","code":"<php source>","timeout_ms":30000}
 *
 * Frame shapes:
 *   {"id":"...","type":"stdout","chunk":"..."}
 *   {"id":"...","type":"dump","value":{...}}
 *   {"id":"...","type":"result","duration_ms":42}
 *   {"id":"...","type":"error","class":"Error","message":"...","trace":[...]}
 *   {"id":"...","type":"ready"}           // boot complete
 *   {"id":"...","type":"cancelled"}
 *
 * Bootstrap file (optional) is the first CLI argument; if present, it is
 * required before the REPL loop starts so the user's Laravel/Composer
 * environment is available.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');

const LSP_DEFAULT_TIMEOUT_MS = 30000;
const LSP_MAX_TIMEOUT_MS = 120000;

$LSP_MEMORY_LIMIT = getenv('LARAVEL_SCRATCHPAD_WORKER_MEMORY_LIMIT');
if (! is_string($LSP_MEMORY_LIMIT) || trim($LSP_MEMORY_LIMIT) === '') {
    $LSP_MEMORY_LIMIT = '512M';
}
@ini_set('memory_limit', $LSP_MEMORY_LIMIT);
@set_time_limit((int) ceil(LSP_DEFAULT_TIMEOUT_MS / 1000));

// The only allowed writer to real stdout: emit() — everything else is captured.
$LSP_STDOUT = fopen('php://stdout', 'wb');
$LSP_STDIN  = fopen('php://stdin',  'rb');
stream_set_write_buffer($LSP_STDOUT, 0);

/**
 * Emit a single frame. JSON-encoded, no unescaped newlines.
 */
function lsp_emit(array $frame): void {
    global $LSP_STDOUT;
    $json = json_encode(
        $frame,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR
    );
    if ($json === false) {
        $json = json_encode(['type' => 'error', 'class' => 'EncodingError', 'message' => 'frame encoding failed', 'trace' => []]);
    }
    fwrite($LSP_STDOUT, $json . "\n");
    fflush($LSP_STDOUT);
}

/** Internal: used to stop execution after dd() without killing the worker. */
final class LSP_DumpAndDie extends \RuntimeException {}

function lsp_request_timeout_ms(array $request): int {
    $raw = $request['timeout_ms'] ?? LSP_DEFAULT_TIMEOUT_MS;
    if (! is_int($raw) && ! is_float($raw)) {
        return LSP_DEFAULT_TIMEOUT_MS;
    }
    return max(1000, min(LSP_MAX_TIMEOUT_MS, (int) $raw));
}

/** Describe a value as a JSON-serializable tree. Depth-limited to prevent OOMs. */
function lsp_describe(mixed $value, int $depth = 0, int $maxDepth = 6): array {
    if ($depth > $maxDepth) {
        return ['kind' => 'truncated'];
    }

    if ($value === null) return ['kind' => 'null'];
    if (is_bool($value)) return ['kind' => 'bool', 'value' => $value];
    if (is_int($value)) return ['kind' => 'int', 'value' => $value];
    if (is_float($value)) {
        if (is_nan($value)) return ['kind' => 'float', 'value' => 'NaN'];
        if (is_infinite($value)) return ['kind' => 'float', 'value' => $value > 0 ? 'INF' : '-INF'];
        return ['kind' => 'float', 'value' => $value];
    }
    if (is_string($value)) {
        $truncated = mb_strlen($value) > 4096;
        return [
            'kind' => 'string',
            'value' => $truncated ? mb_substr($value, 0, 4096) : $value,
            'length' => mb_strlen($value),
            'truncated' => $truncated,
        ];
    }
    if (is_array($value)) {
        $items = [];
        $i = 0;
        foreach ($value as $k => $v) {
            if ($i++ >= 200) { $items[] = ['kind' => 'truncated']; break; }
            $items[] = [
                'key' => is_int($k) ? $k : (string) $k,
                'keyKind' => is_int($k) ? 'int' : 'string',
                'value' => lsp_describe($v, $depth + 1, $maxDepth),
            ];
        }
        return ['kind' => 'array', 'count' => count($value), 'items' => $items];
    }
    if (is_object($value)) {
        return lsp_describeObject($value, $depth, $maxDepth);
    }
    if (is_resource($value)) {
        return ['kind' => 'resource', 'type' => get_resource_type($value), 'id' => (int) $value];
    }
    return ['kind' => 'unknown'];
}

function lsp_describeObject(object $obj, int $depth, int $maxDepth): array {
    $class = get_class($obj);

    // Eloquent model: attributes + loaded relations.
    if (method_exists($obj, 'getAttributes') && method_exists($obj, 'getRelations')) {
        try {
            /** @psalm-suppress PossiblyInvalidMethodCall */
            $attrs = $obj->getAttributes();
            /** @psalm-suppress PossiblyInvalidMethodCall */
            $rels = $obj->getRelations();
            $key = method_exists($obj, 'getKey') ? $obj->getKey() : null;
            $props = [];
            foreach ($attrs as $k => $v) {
                $props[] = ['name' => (string) $k, 'visibility' => 'attribute', 'value' => lsp_describe($v, $depth + 1, $maxDepth)];
            }
            foreach ($rels as $k => $v) {
                $props[] = ['name' => (string) $k, 'visibility' => 'relation', 'value' => lsp_describe($v, $depth + 1, $maxDepth)];
            }
            return ['kind' => 'eloquent', 'class' => $class, 'key' => $key, 'props' => $props];
        } catch (\Throwable) {
            // Fall through to generic object handling.
        }
    }

    // DateTimeInterface: iso + timezone.
    if ($obj instanceof \DateTimeInterface) {
        return ['kind' => 'datetime', 'class' => $class, 'iso' => $obj->format(\DateTimeInterface::ATOM), 'tz' => $obj->getTimezone()->getName()];
    }

    // Collections / iterables: render as array-like.
    if ($obj instanceof \Traversable) {
        $items = [];
        $count = 0;
        foreach ($obj as $k => $v) {
            if ($count++ >= 200) { $items[] = ['kind' => 'truncated']; break; }
            $items[] = [
                'key' => is_int($k) ? $k : (string) $k,
                'keyKind' => is_int($k) ? 'int' : 'string',
                'value' => lsp_describe($v, $depth + 1, $maxDepth),
            ];
        }
        return ['kind' => 'iterable', 'class' => $class, 'count' => $count, 'items' => $items];
    }

    // Generic object: public + protected props.
    $props = [];
    $visited = 0;
    try {
        $ref = new \ReflectionObject($obj);
        foreach ($ref->getProperties() as $p) {
            if ($visited++ >= 100) { $props[] = ['name' => '…', 'visibility' => 'truncated', 'value' => ['kind' => 'truncated']]; break; }
            if ($p->isStatic()) continue;
            $visibility = $p->isPublic() ? 'public' : ($p->isProtected() ? 'protected' : 'private');
            if (! $p->isInitialized($obj)) {
                $props[] = ['name' => $p->getName(), 'visibility' => $visibility, 'value' => ['kind' => 'uninitialized']];
                continue;
            }
            $value = $p->getValue($obj);
            $props[] = ['name' => $p->getName(), 'visibility' => $visibility, 'value' => lsp_describe($value, $depth + 1, $maxDepth)];
        }
    } catch (\Throwable $e) {
        $props[] = ['name' => '__error__', 'visibility' => 'public', 'value' => ['kind' => 'string', 'value' => $e->getMessage(), 'length' => strlen($e->getMessage()), 'truncated' => false]];
    }
    return ['kind' => 'object', 'class' => $class, 'props' => $props];
}

function lsp_buildTrace(\Throwable $e): array {
    $frames = [];
    foreach ($e->getTrace() as $frame) {
        $frames[] = [
            'file' => $frame['file'] ?? null,
            'line' => $frame['line'] ?? null,
            'function' => ($frame['class'] ?? '') . ($frame['type'] ?? '') . ($frame['function'] ?? ''),
        ];
    }
    return $frames;
}

/**
 * Transform the user's code so a trailing expression is captured via `return`.
 *
 * Handles, in order:
 *   1. trailing comments / whitespace — stripped when finding the tail
 *   2. trailing semicolon — does not disqualify a wrap (the statement *before*
 *      it is the candidate)
 *   3. code ending in `}` (block/function/class body) — no wrap
 *   4. last segment starts with a statement keyword (`echo`, `if`, `return`,
 *      `throw`, …) — no wrap
 *   5. last segment is an expression — wrapped as `return (expr);`
 *
 * Uses `token_get_all` for correct handling of strings, comments and nested
 * parens/brackets/braces.
 */
function lsp_transform(string $code): string {
    $code = trim($code);
    if ($code === '') return '';

    $tokens = @token_get_all('<?php ' . $code);
    if ($tokens === false) return $code . (str_ends_with($code, ';') ? '' : ';');

    $isTrivia = static fn($t): bool => is_array($t)
        && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG], true);

    // Walk backward, skipping whitespace and comments, to find the last
    // meaningful token.
    $lastIdx = count($tokens) - 1;
    while ($lastIdx > 0 && $isTrivia($tokens[$lastIdx])) {
        $lastIdx--;
    }
    if ($lastIdx <= 0) return $code; // entirely whitespace / comments

    $lastTok = $tokens[$lastIdx];

    // Code ending in a block — don't wrap.
    if (is_string($lastTok) && $lastTok === '}') {
        return $code;
    }

    // Collect top-level `;` positions.
    $depth = 0;
    $semiPositions = [];
    foreach ($tokens as $i => $t) {
        if (is_string($t)) {
            if ($t === '(' || $t === '[' || $t === '{') $depth++;
            elseif ($t === ')' || $t === ']' || $t === '}') $depth--;
            elseif ($t === ';' && $depth === 0) $semiPositions[] = $i;
        } elseif (is_array($t) && ($t[0] === T_CURLY_OPEN || $t[0] === T_DOLLAR_OPEN_CURLY_BRACES)) {
            $depth++;
        }
    }

    $endsWithSemi = is_string($lastTok) && $lastTok === ';';
    if ($endsWithSemi) {
        array_pop($semiPositions); // drop the terminal `;`
        $segEnd = $lastIdx - 1;
    } else {
        $segEnd = count($tokens) - 1;
    }
    $segStart = empty($semiPositions) ? 1 : (end($semiPositions) + 1);

    // Advance past leading whitespace/comments inside the segment so a tail
    // like "//\n echo 1" is recognised as starting with the `echo` keyword,
    // not with `//` (which would break a `return (…)` wrap).
    $firstMeaningful = -1;
    for ($i = $segStart; $i <= $segEnd; $i++) {
        if (!$isTrivia($tokens[$i])) { $firstMeaningful = $i; break; }
    }
    if ($firstMeaningful === -1) {
        // Segment is entirely trivia (only comments / whitespace).
        return $code . ($endsWithSemi ? '' : ';');
    }

    // Statement-keyword tokens — if the segment starts with one, evaluate as-is.
    // Use real T_* constants rather than a regex, which can't distinguish
    // keywords from identifiers inside strings or variable names.
    $statementKw = [
        T_IF, T_ELSE, T_ELSEIF, T_FOR, T_FOREACH, T_WHILE, T_DO, T_SWITCH,
        T_CASE, T_BREAK, T_CONTINUE, T_RETURN, T_THROW, T_TRY, T_CATCH,
        T_FINALLY, T_FUNCTION, T_CLASS, T_INTERFACE, T_TRAIT, T_NAMESPACE,
        T_USE, T_REQUIRE, T_REQUIRE_ONCE, T_INCLUDE, T_INCLUDE_ONCE,
        T_DECLARE, T_ECHO, T_PRINT, T_GLOBAL, T_GOTO, T_STATIC,
        T_ABSTRACT, T_FINAL, T_PUBLIC, T_PRIVATE, T_PROTECTED, T_READONLY,
        T_ENUM,
    ];
    $first = $tokens[$firstMeaningful];
    if (is_array($first) && in_array($first[0], $statementKw, true)) {
        return $code . ($endsWithSemi ? '' : ';');
    }

    // Reconstruct head (everything before the tail's first meaningful token)
    // and tail (the trailing expression).
    $head = '';
    $tail = '';
    foreach ($tokens as $i => $t) {
        if ($i === 0) continue;
        $text = is_string($t) ? $t : $t[1];
        if ($i < $firstMeaningful) {
            $head .= $text;
        } elseif ($i <= $segEnd) {
            $tail .= $text;
        }
    }
    $tail = rtrim($tail);

    return $head . ' return (' . $tail . ');';
}

/**
 * Pre-define our `dump()` / `dd()` BEFORE the Laravel bootstrap runs so
 * Laravel's own helpers.php sees them already defined and its
 * `if (! function_exists('dd'))` guard skips registering its version.
 * Critical: the upstream `dd()` calls `exit(1)` after dumping, which
 * kills the long-lived worker — the renderer then sees "WorkerExited /
 * worker exited during request". Our version throws
 * {@see LSP_DumpAndDie} instead, which the eval loop catches and treats
 * as a normal request completion so the REPL stays alive.
 *
 * Separate from {@see lsp_installDumpHandlers} (which runs AFTER the
 * bootstrap to wire Symfony's VarDumper handler) because VarDumper's
 * class isn't loaded until the autoload has been pulled in.
 */
function lsp_preinstallDdHandlers(): void {
    if (! function_exists('dump')) {
        // Matches Laravel's upstream `dump()` signature: returns void.
        // Returning the first arg (a previous iteration's attempt at
        // chaining ergonomics) doubled the output — `lsp_transform`
        // wraps a trailing expression in `return (...)`, so the
        // dumper's return value would land in `$result` and trigger a
        // second `lsp_emit` from the eval-loop's trailing-value path.
        eval(<<<'PHP'
        function dump(mixed ...$vars): void {
            global $LSP_ACTIVE_ID;
            foreach ($vars as $v) {
                lsp_emit(['id' => $LSP_ACTIVE_ID, 'type' => 'dump', 'value' => lsp_describe($v)]);
            }
        }
        PHP);
    }
    if (! function_exists('dd')) {
        eval(<<<'PHP'
        function dd(mixed ...$vars): never {
            global $LSP_ACTIVE_ID;
            foreach ($vars as $v) {
                lsp_emit(['id' => $LSP_ACTIVE_ID, 'type' => 'dump', 'value' => lsp_describe($v)]);
            }
            throw new \LSP_DumpAndDie('dd');
        }
        PHP);
    }
}

/**
 * Post-bootstrap dump-handler wiring. Now that the autoload has run we
 * can rebind Symfony's VarDumper handler — so `dump(...)` from Laravel
 * code that calls VarDumper directly also lands in our frame stream
 * instead of the default CLI renderer. Our own `dump()` / `dd()` were
 * already installed by {@see lsp_preinstallDdHandlers}.
 */
function lsp_installDumpHandlers(string &$activeId): void {
    if (class_exists(\Symfony\Component\VarDumper\VarDumper::class)) {
        \Symfony\Component\VarDumper\VarDumper::setHandler(static function (mixed $var) use (&$activeId): void {
            lsp_emit(['id' => $activeId, 'type' => 'dump', 'value' => lsp_describe($var)]);
        });
    }
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

$LSP_ACTIVE_ID = '';

// Pre-define our dump()/dd() BEFORE the Laravel bootstrap — otherwise
// Laravel's helpers.php registers its own `dd()` that calls exit(1) on
// completion, killing the long-lived worker process.
lsp_preinstallDdHandlers();

// Optional bootstrap file — passed as argv[1].
if (isset($argv[1]) && is_string($argv[1]) && $argv[1] !== '') {
    $bootstrap = $argv[1];
    if (is_file($bootstrap)) {
        try {
            require $bootstrap;
        } catch (\Throwable $e) {
            lsp_emit([
                'id' => 'boot',
                'type' => 'error',
                'class' => get_class($e),
                'message' => 'bootstrap failed: ' . $e->getMessage(),
                'trace' => lsp_buildTrace($e),
            ]);
            exit(2);
        }
    }
}

lsp_installDumpHandlers($LSP_ACTIVE_ID);

lsp_emit([
    'id' => 'boot',
    'type' => 'ready',
    'php' => PHP_VERSION,
    'pid' => getmypid(),
]);

// -----------------------------------------------------------------------------
// REPL loop
// -----------------------------------------------------------------------------

// Ignore SIGPIPE — parent may close our stdout. SIGINT is used for cancel.
if (function_exists('pcntl_async_signals')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGPIPE, SIG_IGN);
    pcntl_signal(SIGINT, static function (): void {
        global $LSP_ACTIVE_ID;
        throw new \LSP_DumpAndDie('cancelled:' . $LSP_ACTIVE_ID);
    });
}

while (! feof($LSP_STDIN)) {
    $line = fgets($LSP_STDIN);
    if ($line === false) break;
    $line = rtrim($line, "\r\n");
    if ($line === '') continue;

    $req = json_decode($line, true);
    if (! is_array($req) || ! isset($req['id'], $req['code']) || ! is_string($req['id']) || ! is_string($req['code'])) {
        lsp_emit(['id' => 'boot', 'type' => 'error', 'class' => 'ProtocolError', 'message' => 'malformed request', 'trace' => []]);
        continue;
    }

    $id = $req['id'];
    $LSP_ACTIVE_ID = $id;
    $start = microtime(true);
    $timeoutMs = lsp_request_timeout_ms($req);
    @ini_set('memory_limit', $LSP_MEMORY_LIMIT);
    @set_time_limit((int) ceil($timeoutMs / 1000));

    // Capture stdout produced by the user code.
    ob_start(static function (string $chunk) use ($id): string {
        if ($chunk !== '') {
            lsp_emit(['id' => $id, 'type' => 'stdout', 'chunk' => $chunk]);
        }
        return '';
    }, 1024);

    $transformed = lsp_transform($req['code']);
    $result = null;
    $hadReturn = str_contains($transformed, 'return (');

    try {
        // eval returns the `return` value if present; otherwise null.
        $result = eval($transformed);
    } catch (LSP_DumpAndDie $e) {
        // dd() and cancel both funnel through this exception type but mean
        // different things to the UI — dd() is "stop, I've shown you what
        // I wanted to show you" (treat as a normal result), cancel is
        // "abort this run and tell the user it was cancelled."
        $hadReturn = false;
        if (str_starts_with($e->getMessage(), 'cancelled:')) {
            @ob_end_flush();
            lsp_emit(['id' => $id, 'type' => 'cancelled']);
            $LSP_ACTIVE_ID = '';
            continue;
        }
    } catch (\Throwable $e) {
        @ob_end_flush();
        lsp_emit([
            'id' => $id,
            'type' => 'error',
            'class' => get_class($e),
            'message' => $e->getMessage(),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => lsp_buildTrace($e),
        ]);
        $LSP_ACTIVE_ID = '';
        continue;
    }

    @ob_end_flush();

    if ($hadReturn && $result !== null) {
        lsp_emit(['id' => $id, 'type' => 'dump', 'value' => lsp_describe($result)]);
    }

    $duration = (int) round((microtime(true) - $start) * 1000);
    lsp_emit(['id' => $id, 'type' => 'result', 'duration_ms' => $duration]);
    $LSP_ACTIVE_ID = '';
}
