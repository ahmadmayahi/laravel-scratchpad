<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { Database, X, AlertTriangle, CheckCircle2, Loader2, Plug, Eye, EyeOff, FolderOpen } from "lucide-vue-next";
import type { DatabaseConnection, DatabaseDriver, DatabaseTestResult } from "../../shared/ipc";
import Modal from "./Modal.vue";

/**
 * Add / Edit modal for a single database connection. Used by
 * DatabaseTab via a single instance, swapping between create + edit
 * mode through the `editing` prop.
 *
 * Per-driver fields:
 *   • sqlite — file path + Browse button.
 *   • mysql / pgsql — host, port (auto-defaults 3306 / 5432 when the
 *     driver changes), database name, username, password.
 *
 * Password handling matches the SSH dialog pattern: plaintext only
 * crosses the IPC boundary on save, gets encrypted into the OS
 * keychain via the SecretStore, and the form only ever sees a
 * `secretStored: true` flag back. For edits, the placeholder reads
 * "stored" and the user can either type a new password (overwrites)
 * or click "Clear" (removes the keychain entry).
 */

const DEFAULT_PORT: Record<DatabaseDriver, number | null> = {
  sqlite: null,
  mysql: 3306,
  pgsql: 5432,
};

const props = defineProps<{ open: boolean; editing: DatabaseConnection | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const name = ref("");
const driver = ref<DatabaseDriver>("sqlite");
const database = ref("");
const host = ref("");
const port = ref<number | null>(null);
const username = ref("");
const password = ref("");
const showPassword = ref(false);
// Tracks whether the existing connection has a stored secret. Drives
// the "•••• stored" placeholder + the Clear button. Reset on every
// open() so a previous edit doesn't bleed into a fresh add.
const hadStoredSecret = ref(false);
// Set when the user clicks Clear — sent as `clearSecret: true` on
// save, separate from "user typed an empty password" (which is a
// no-op on the keychain).
const clearSecret = ref(false);

const phase = ref<"idle" | "saving" | "error" | "success">("idle");
const errorMessage = ref<string | null>(null);

const testPhase = ref<"idle" | "testing" | "ok" | "fail">("idle");
const testResult = ref<DatabaseTestResult | null>(null);

const nameInput = useTemplateRef<HTMLInputElement>("nameInput");

const isEdit = computed(() => props.editing !== null);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    if (props.editing) {
      name.value = props.editing.name;
      driver.value = props.editing.driver;
      database.value = props.editing.database;
      host.value = props.editing.host ?? "";
      port.value = props.editing.port ?? DEFAULT_PORT[props.editing.driver];
      username.value = props.editing.username ?? "";
      hadStoredSecret.value = !!props.editing.secretStored;
    } else {
      name.value = "";
      driver.value = "sqlite";
      database.value = "";
      host.value = "";
      port.value = null;
      username.value = "";
      hadStoredSecret.value = false;
    }
    password.value = "";
    showPassword.value = false;
    clearSecret.value = false;
    phase.value = "idle";
    errorMessage.value = null;
    testPhase.value = "idle";
    testResult.value = null;
    void nextTick(() => setTimeout(() => nameInput.value?.focus(), 10));
  },
);

// Driver swap auto-fills the canonical port for the new driver — but
// only for new connections. On edit we preserve whatever the user
// previously saved (could be a non-default like 5433 for a Docker
// Postgres).
watch(driver, (next, prev) => {
  if (next === prev) return;
  if (!isEdit.value) {
    port.value = DEFAULT_PORT[next];
  }
  // Any meaningful field change invalidates a previous test result.
  if (testPhase.value !== "idle") {
    testPhase.value = "idle";
    testResult.value = null;
  }
});

watch(
  () =>
    [name.value, database.value, host.value, port.value, username.value, password.value, clearSecret.value] as const,
  () => {
    if (testPhase.value !== "idle") {
      testPhase.value = "idle";
      testResult.value = null;
    }
  },
);

const isNetworkDriver = computed(() => driver.value === "mysql" || driver.value === "pgsql");

const passwordPlaceholder = computed(() => {
  if (!isNetworkDriver.value) return "";
  if (clearSecret.value) return "(will clear stored password)";
  if (hadStoredSecret.value) return "•••• stored — type to replace";
  return "password";
});

const databaseLabel = computed(() => (driver.value === "sqlite" ? "Database file" : "Database"));
const databasePlaceholder = computed(() =>
  driver.value === "sqlite" ? "/path/to/database.sqlite" : driver.value === "pgsql" ? "postgres" : "my_app",
);

// Name field placeholder follows the driver so the example doesn't lie
// when you swap to SQLite / PostgreSQL.
const namePlaceholder = computed(() => {
  if (driver.value === "sqlite") return "Local SQLite";
  if (driver.value === "pgsql") return "Local PostgreSQL";
  return "Local MySQL";
});

const canSubmit = computed(() => {
  if (phase.value === "saving") return false;
  if (!name.value.trim()) return false;
  if (!database.value.trim()) return false;
  if (isNetworkDriver.value) {
    if (!host.value.trim()) return false;
    if (port.value == null || !Number.isInteger(port.value) || port.value < 1 || port.value > 65535) return false;
  }
  return true;
});

const canTest = computed(() => canSubmit.value && testPhase.value !== "testing");

function buildPayload(): {
  name: string;
  driver: DatabaseDriver;
  database: string;
  host?: string;
  port?: number;
  username?: string;
} {
  const base = {
    name: name.value.trim(),
    driver: driver.value,
    database: database.value.trim(),
  };
  if (isNetworkDriver.value) {
    return {
      ...base,
      host: host.value.trim(),
      port: port.value ?? DEFAULT_PORT[driver.value]!,
      username: username.value.trim(),
    };
  }
  return base;
}

async function pickSqliteFile(): Promise<void> {
  const picked = await window.lsp.databasePickSqliteFile();
  if (picked) database.value = picked;
}

async function test(): Promise<void> {
  if (!canTest.value) return;
  testPhase.value = "testing";
  testResult.value = null;
  // For edits with a stored secret + no typed password + not clearing,
  // pass `id` so the IPC reuses the keychain value. Otherwise pass an
  // inline payload so the user can probe an unsaved form.
  const useStored = isEdit.value && hadStoredSecret.value && !password.value && !clearSecret.value;
  const inlineSecret = isNetworkDriver.value ? password.value : undefined;
  try {
    const result = useStored
      ? await window.lsp.databaseTest({ id: props.editing!.id, secret: inlineSecret || undefined })
      : await window.lsp.databaseTest({ connection: buildPayload(), secret: inlineSecret || undefined });
    testResult.value = result;
    testPhase.value = result.ok ? "ok" : "fail";
  } catch (err) {
    testResult.value = { ok: false, error: (err as Error).message ?? String(err) };
    testPhase.value = "fail";
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  phase.value = "saving";
  errorMessage.value = null;
  try {
    if (isEdit.value) {
      await window.lsp.databaseUpdate({
        id: props.editing!.id,
        patch: buildPayload(),
        secret: isNetworkDriver.value && password.value ? password.value : undefined,
        clearSecret: isNetworkDriver.value && clearSecret.value && !password.value,
      });
    } else {
      await window.lsp.databaseAdd({
        connection: buildPayload(),
        secret: isNetworkDriver.value && password.value ? password.value : undefined,
      });
    }
    phase.value = "success";
    emit("saved");
  } catch (err) {
    phase.value = "error";
    errorMessage.value = (err as Error).message ?? String(err);
  }
}

function clearStoredPassword(): void {
  clearSecret.value = true;
  password.value = "";
}
</script>

<template>
  <Modal
    :open="open"
    :elevated="true"
    :title="isEdit ? 'Edit connection' : 'Add connection'"
    description="Database connection profile"
    content-class="dialog-shell w-[600px] max-w-[92vw]"
    @close="emit('close')"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
      <Database :size="14" class="text-accent" />
      <h2 class="text-[13px] font-semibold text-fg">{{ isEdit ? "Edit connection" : "Add connection" }}</h2>
      <div class="flex-1" />
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <form class="px-5 py-4 space-y-3" @submit.prevent="submit">
      <div class="grid grid-cols-[110px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Name</label>
        <input
          ref="nameInput"
          v-model="name"
          class="field font-mono"
          :placeholder="namePlaceholder"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="grid grid-cols-[110px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Driver</label>
        <select v-model="driver" class="select">
          <option value="sqlite">SQLite</option>
          <option value="mysql">MySQL</option>
          <option value="pgsql">PostgreSQL</option>
        </select>
      </div>

      <div v-if="isNetworkDriver" class="grid grid-cols-[110px_1fr_60px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Host</label>
        <input v-model="host" class="field font-mono" placeholder="127.0.0.1" autocomplete="off" spellcheck="false" />
        <label class="text-[12px] text-fg-muted text-right">Port</label>
        <input v-model.number="port" type="number" min="1" max="65535" class="field font-mono" />
      </div>

      <div class="grid grid-cols-[110px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">{{ databaseLabel }}</label>
        <div v-if="driver === 'sqlite'" class="flex items-center gap-2">
          <input
            v-model="database"
            class="field font-mono flex-1 min-w-0"
            :placeholder="databasePlaceholder"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" class="btn-subtle shrink-0" title="Choose SQLite file" @click="pickSqliteFile">
            <FolderOpen :size="12" />
            Browse…
          </button>
        </div>
        <input
          v-else
          v-model="database"
          class="field font-mono"
          :placeholder="databasePlaceholder"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div v-if="isNetworkDriver" class="grid grid-cols-[110px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Username</label>
        <input v-model="username" class="field font-mono" placeholder="root" autocomplete="off" spellcheck="false" />
      </div>

      <div v-if="isNetworkDriver" class="grid grid-cols-[110px_1fr_auto] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Password</label>
        <div class="relative">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="field font-mono w-full pr-8"
            :placeholder="passwordPlaceholder"
            autocomplete="new-password"
            spellcheck="false"
          />
          <button
            type="button"
            class="absolute inset-y-0 right-1.5 flex items-center text-fg-muted hover:text-fg"
            :title="showPassword ? 'Hide password' : 'Show password'"
            @click="showPassword = !showPassword"
          >
            <Eye v-if="showPassword" :size="12" />
            <EyeOff v-else :size="12" />
          </button>
        </div>
        <button
          v-if="hadStoredSecret && !clearSecret"
          type="button"
          class="btn-subtle"
          title="Remove the stored password from the keychain"
          @click="clearStoredPassword"
        >
          Clear
        </button>
        <span v-else-if="clearSecret" class="text-[11px] text-warning">will clear</span>
      </div>

      <p v-if="isNetworkDriver" class="text-[11px] text-fg-muted pl-[122px]">
        Password is encrypted via your OS keychain — never written to settings.json.
      </p>

      <div
        v-if="phase === 'error' && errorMessage"
        class="flex items-start gap-2 p-2 rounded-md border border-danger/40 bg-danger/10 text-danger text-[12px]"
      >
        <AlertTriangle :size="12" class="mt-0.5 shrink-0" />
        <span class="break-all">{{ errorMessage }}</span>
      </div>
    </form>

    <footer class="px-4 py-3 border-t border-line flex flex-col gap-2">
      <div v-if="testPhase === 'ok' && testResult?.ok" class="flex items-center gap-1.5 text-[11px] text-success">
        <CheckCircle2 :size="11" />
        <span>Connected</span>
        <span v-if="testResult.serverVersion" class="text-success/80"
          >· <span class="font-mono">{{ testResult.serverVersion }}</span></span
        >
      </div>
      <div
        v-else-if="testPhase === 'fail' && testResult && !testResult.ok"
        class="flex items-start gap-1.5 text-[11px] text-danger min-w-0"
      >
        <AlertTriangle :size="11" class="mt-0.5 shrink-0" />
        <span class="break-all">{{ testResult.error }}</span>
      </div>

      <div class="flex items-center justify-between gap-2">
        <button
          type="button"
          class="btn-subtle disabled:opacity-40"
          :disabled="!canTest"
          :title="canTest ? 'Probe the connection' : 'Fill in the required fields first'"
          @click="test"
        >
          <Loader2 v-if="testPhase === 'testing'" :size="12" class="animate-spin" />
          <Plug v-else :size="12" />
          {{ testPhase === "testing" ? "Testing…" : "Test connection" }}
        </button>
        <div class="flex items-center gap-2">
          <button type="button" class="btn-subtle" @click="emit('close')">Cancel</button>
          <button class="btn-primary disabled:opacity-40" :disabled="!canSubmit" @click="submit">
            {{ phase === "saving" ? "Saving…" : isEdit ? "Save" : "Add" }}
          </button>
        </div>
      </div>
    </footer>
  </Modal>
</template>
