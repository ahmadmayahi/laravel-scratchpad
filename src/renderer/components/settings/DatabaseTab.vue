<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Plug,
  FolderSearch,
  RefreshCcw,
  X,
} from "lucide-vue-next";
import type { DatabaseConnection, DatabaseTestResult, Settings, SqliteAvailability } from "../../../shared/ipc";
import DatabaseConnectionModal from "../DatabaseConnectionModal.vue";
import DatabaseDriverIcon from "../icons/DatabaseDriverIcon.vue";

/**
 * CRUD list for database connection profiles. There's no "active
 * connection" concept here — each tab picks its own from the toolbar
 * dropdown, and the default is always the project's own `.env`.
 * Settings is just the catalog: add, edit, delete, test. The seeded
 * SQLite is undeletable (lock icon matches LaravelTab's `latest`-
 * skeleton treatment).
 *
 * The list is loaded via `databaseList()` so we get the runtime-
 * enriched `secretStored` flag. Re-loaded after every mutation and
 * on `onSettingsChanged` so external edits stay in sync.
 */

const connections = ref<DatabaseConnection[]>([]);
const editing = ref<DatabaseConnection | null>(null);
const modalOpen = ref(false);
// Per-row test state — keyed by connection id so the inline result
// chip survives across re-renders without leaking into other rows.
const testStatus = ref<Map<string, { phase: "testing" | "ok" | "fail"; result?: DatabaseTestResult }>>(new Map());

const sqliteAvailability = ref<SqliteAvailability | null>(null);
const sqliteSettings = ref<Settings["database"]["sqlite"] | null>(null);
const rescanning = ref(false);

async function refresh(): Promise<void> {
  connections.value = await window.lsp.databaseList();
}

async function refreshSqliteStatus(): Promise<void> {
  sqliteAvailability.value = await window.lsp.sqliteAvailability();
}

async function refreshSqliteSettings(): Promise<void> {
  const settings = await window.lsp.settingsGet();
  sqliteSettings.value = settings.database.sqlite;
}

let offSettings: (() => void) | null = null;
let offSqlite: (() => void) | null = null;

onMounted(() => {
  void refresh();
  void refreshSqliteStatus();
  void refreshSqliteSettings();
  offSettings = window.lsp.onSettingsChanged(() => {
    void refresh();
    void refreshSqliteSettings();
  });
  offSqlite = window.lsp.onSqliteAvailability((snapshot) => {
    sqliteAvailability.value = snapshot;
  });
});

onBeforeUnmount(() => {
  offSettings?.();
  offSqlite?.();
});

async function pickCustomCli(): Promise<void> {
  const picked = await window.lsp.sqlitePickCliBinary();
  if (!picked) return;
  await window.lsp.settingsSet({ database: { sqlite: { customCliPath: picked } } });
}

async function clearCustomCli(): Promise<void> {
  await window.lsp.settingsSet({ database: { sqlite: { customCliPath: null } } });
}

async function pickCustomDb(): Promise<void> {
  const picked = await window.lsp.databasePickSqliteFile();
  if (!picked) return;
  await window.lsp.settingsSet({ database: { sqlite: { customDatabasePath: picked } } });
}

async function clearCustomDb(): Promise<void> {
  await window.lsp.settingsSet({ database: { sqlite: { customDatabasePath: null } } });
}

async function rescanSqlite(): Promise<void> {
  if (rescanning.value) return;
  rescanning.value = true;
  try {
    sqliteAvailability.value = await window.lsp.sqliteRescan();
  } finally {
    rescanning.value = false;
  }
}

function driverLabel(driver: DatabaseConnection["driver"]): string {
  switch (driver) {
    case "sqlite":
      return "SQLite";
    case "mysql":
      return "MySQL";
    case "pgsql":
      return "PostgreSQL";
  }
}

function driverTarget(c: DatabaseConnection): string {
  if (c.driver === "sqlite") return c.database;
  return `${c.username ? c.username + "@" : ""}${c.host}:${c.port}/${c.database}`;
}

function openAdd(): void {
  editing.value = null;
  modalOpen.value = true;
}
function openEdit(c: DatabaseConnection): void {
  editing.value = c;
  modalOpen.value = true;
}

async function onSaved(): Promise<void> {
  modalOpen.value = false;
  editing.value = null;
  await refresh();
}

async function onDelete(c: DatabaseConnection): Promise<void> {
  // Hard delete — no confirm, matches LaravelTab's untick behaviour.
  // Recovery: the user re-creates the connection. Keychain entry is
  // cleared by the IPC handler. Tabs that picked this connection
  // silently fall back to the project's `.env` on next run.
  await window.lsp.databaseRemove(c.id);
  testStatus.value.delete(c.id);
  await refresh();
}

async function testRow(c: DatabaseConnection): Promise<void> {
  const next = new Map(testStatus.value);
  next.set(c.id, { phase: "testing" });
  testStatus.value = next;
  try {
    const result = await window.lsp.databaseTest({ id: c.id });
    const after = new Map(testStatus.value);
    after.set(c.id, { phase: result.ok ? "ok" : "fail", result });
    testStatus.value = after;
  } catch (err) {
    const after = new Map(testStatus.value);
    after.set(c.id, {
      phase: "fail",
      result: { ok: false, error: (err as Error).message ?? String(err) },
    });
    testStatus.value = after;
  }
}

function statusOf(id: string): { phase: "testing" | "ok" | "fail"; result?: DatabaseTestResult } | undefined {
  return testStatus.value.get(id);
}

function failureMessage(status: { result?: DatabaseTestResult } | undefined): string {
  return status?.result && !status.result.ok ? status.result.error : "unknown";
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h3 class="font-medium text-fg mb-1">Database connections</h3>
      <p class="text-[12px] text-fg-muted">
        Manage connection profiles for bundled Laravel skeletons. Pick one per tab from the toolbar's database dropdown.
        Local + SSH projects always use their own <code class="font-mono">.env</code>.
      </p>
    </div>

    <div class="border border-line rounded-lg overflow-hidden">
      <div class="px-3 py-2.5 bg-surface-2/40">
        <div class="text-[12px] font-medium text-fg mb-2">SQLite tooling</div>

        <!-- pdo_sqlite extension status -->
        <div class="flex items-start gap-2 text-[11px]">
          <CheckCircle2
            v-if="sqliteAvailability?.pdoSqlite.available"
            :size="12"
            class="text-success mt-0.5 shrink-0"
          />
          <AlertTriangle v-else :size="12" class="text-warning mt-0.5 shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-fg">
              <span class="font-mono">pdo_sqlite</span>
              <template v-if="sqliteAvailability?.pdoSqlite.available">
                — available via
                <span class="font-mono text-fg-muted">{{ sqliteAvailability.pdoSqlite.phpBinary }}</span>
              </template>
              <template v-else> — not available </template>
            </div>
            <div v-if="!sqliteAvailability?.pdoSqlite.available" class="text-fg-muted">
              Fresh skeletons will boot without a database binding (DB_* lines commented out).
            </div>
          </div>
        </div>

        <!-- sqlite3 CLI status -->
        <div class="flex items-start gap-2 text-[11px] mt-2">
          <CheckCircle2 v-if="sqliteAvailability?.cli.available" :size="12" class="text-success mt-0.5 shrink-0" />
          <AlertTriangle v-else :size="12" class="text-warning mt-0.5 shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-fg">
              <span class="font-mono">sqlite3</span>
              <template v-if="sqliteAvailability?.cli.available">
                — found at <span class="font-mono text-fg-muted">{{ sqliteAvailability.cli.path }}</span>
                <span v-if="sqliteAvailability.cli.version" class="text-fg-muted">
                  (v{{ sqliteAvailability.cli.version }})</span
                >
              </template>
              <template v-else> — not found </template>
            </div>
          </div>
          <button
            v-if="!sqliteAvailability?.cli.available"
            class="icon-btn"
            title="Specify sqlite3 CLI location"
            @click="pickCustomCli"
          >
            <FolderSearch :size="12" />
          </button>
          <button
            v-else-if="sqliteSettings?.customCliPath"
            class="icon-btn"
            title="Clear custom path (use auto-discovery)"
            @click="clearCustomCli"
          >
            <X :size="12" />
          </button>
        </div>

        <!-- Custom skeleton SQLite database file -->
        <div class="flex items-start gap-2 text-[11px] mt-2">
          <div class="w-3 shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-fg">Custom skeleton database</div>
            <div class="text-fg-muted font-mono truncate">
              {{ sqliteSettings?.customDatabasePath ?? "Default — [skeleton]/database/database.sqlite" }}
            </div>
          </div>
          <button class="icon-btn" title="Pick a SQLite file" @click="pickCustomDb">
            <FolderSearch :size="12" />
          </button>
          <button
            v-if="sqliteSettings?.customDatabasePath"
            class="icon-btn"
            title="Reset to default"
            @click="clearCustomDb"
          >
            <X :size="12" />
          </button>
        </div>

        <div class="flex justify-end mt-2">
          <button class="btn-subtle text-[11px]" :disabled="rescanning" @click="rescanSqlite">
            <RefreshCcw :size="11" :class="rescanning ? 'animate-spin' : ''" />
            {{ rescanning ? "Rescanning…" : "Rescan" }}
          </button>
        </div>
      </div>
    </div>

    <div class="border border-line rounded-lg divide-y divide-line overflow-hidden">
      <div v-if="connections.length === 0" class="p-3 text-fg-muted text-xs">No connections configured.</div>
      <div v-for="c in connections" :key="c.id" class="px-3 py-2.5 flex items-center gap-3 text-xs">
        <DatabaseDriverIcon :driver="c.driver" :size="16" class="shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-fg font-medium truncate">{{ c.name }}</span>
            <span class="text-[10px] uppercase tracking-wider text-fg-muted">{{ driverLabel(c.driver) }}</span>
            <span
              v-if="c.driver !== 'sqlite' && c.secretStored"
              class="text-[10px] text-success/90"
              title="Password stored in OS keychain"
              >secret stored</span
            >
          </div>
          <div class="text-[11px] text-fg-muted font-mono truncate">{{ driverTarget(c) }}</div>
          <div v-if="statusOf(c.id)" class="text-[11px] mt-1">
            <template v-if="statusOf(c.id)?.phase === 'testing'">
              <span class="inline-flex items-center gap-1.5 text-accent">
                <Loader2 :size="10" class="animate-spin" />
                Testing…
              </span>
            </template>
            <template v-else-if="statusOf(c.id)?.phase === 'ok'">
              <span class="inline-flex items-center gap-1.5 text-success">
                <CheckCircle2 :size="10" />
                Connected
                <span
                  v-if="
                    statusOf(c.id)?.result?.ok && (statusOf(c.id)?.result as { serverVersion?: string }).serverVersion
                  "
                  >· {{ (statusOf(c.id)?.result as { serverVersion?: string }).serverVersion }}</span
                >
              </span>
            </template>
            <template v-else-if="statusOf(c.id)?.phase === 'fail'">
              <span class="inline-flex items-start gap-1.5 text-danger" :title="failureMessage(statusOf(c.id))">
                <AlertTriangle :size="10" class="mt-0.5" />
                <span class="break-all">Failed — {{ failureMessage(statusOf(c.id)) }}</span>
              </span>
            </template>
          </div>
        </div>
        <button class="icon-btn" title="Test connection" @click="testRow(c)">
          <Plug :size="12" />
        </button>
        <button class="icon-btn" title="Edit" @click="openEdit(c)">
          <Pencil :size="12" />
        </button>
        <button class="icon-btn text-danger hover:opacity-80" title="Remove connection" @click="onDelete(c)">
          <Trash2 :size="12" />
        </button>
      </div>
    </div>

    <div>
      <button class="btn-subtle" @click="openAdd">
        <Plus :size="12" />
        Add connection
      </button>
    </div>

    <p class="text-[11px] text-fg-muted">
      Selecting a connection injects <code class="font-mono">DB_*</code> environment variables when running a bundled
      skeleton — phpdotenv lets these win over the skeleton's <code class="font-mono">.env</code>.
    </p>

    <DatabaseConnectionModal :open="modalOpen" :editing="editing" @close="modalOpen = false" @saved="onSaved" />
  </div>
</template>
