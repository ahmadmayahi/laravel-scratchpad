<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import {
  Network,
  X,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plug,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  FolderOpen,
} from "lucide-vue-next";
import type {
  NewSshProjectInput,
  Project,
  SshAuthMode,
  SshConfig,
  SshSecretStrategy,
  SshTestResult,
  TestSshInput,
} from "../../shared/ipc";
import Modal from "./Modal.vue";

/**
 * Form for registering a remote Laravel project reachable over SSH.
 * Shape mirrors the TablePlus connection pane: server / port / user /
 * password / "Use SSH key" toggle + identity-file picker.
 *
 * Auth mode is derived from the form's own state, not picked directly
 * by the user:
 *
 *   • "Use SSH key" OFF + password filled  → authMode = "password"
 *   • "Use SSH key" OFF + password empty   → authMode = "agent"
 *   • "Use SSH key" ON  + key path empty   → authMode = "agent"
 *   • "Use SSH key" ON  + key path filled  → authMode = "key"
 *       (password, if present, is used as the passphrase)
 *
 * The password / passphrase is handed to the main process exactly once
 * and encrypted with the OS credential vault (macOS Keychain, Windows
 * DPAPI, Linux libsecret) via Electron's `safeStorage`. It never touches
 * `projects.json` — only the ciphertext lives in `ssh-secrets.json`,
 * and only a boolean flag ("we have a stored secret") comes back to
 * this form.
 */

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; added: [project: Project] }>();

const name = ref("");
const host = ref("");
const port = ref<number | null>(null);
const user = ref("");
const password = ref("");
const showPassword = ref(false);
const useKey = ref(false);
const identityFile = ref("");
const strictHostKeyChecking = ref<"yes" | "accept-new">("accept-new");
// How the secret is sourced at connect time. `keychain` persists the
// typed password; `prompt` asks every time (never stored); `none` sends
// no secret.
const secretStrategy = ref<SshSecretStrategy>("keychain");

// Identity-file placeholder shape varies per OS — Windows users live
// under C:\Users, Unix users under /Users or /home. The path is sent to
// ssh2 verbatim, so showing the OS-native shape avoids a "what do I
// type here?" moment.
const identityFilePlaceholder = computed(() => {
  if (window.platform === "win32") return "C:\\Users\\you\\.ssh\\id_ed25519";
  if (window.platform === "darwin") return "/Users/you/.ssh/id_ed25519";
  return "/home/you/.ssh/id_ed25519";
});

const phase = ref<"idle" | "saving" | "error" | "success">("idle");
const errorMessage = ref<string | null>(null);

const testPhase = ref<"idle" | "testing" | "ok" | "fail">("idle");
const testResult = ref<SshTestResult | null>(null);

const hostInput = useTemplateRef<HTMLInputElement>("hostInput");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    name.value = "";
    host.value = "";
    port.value = null;
    user.value = "";
    password.value = "";
    showPassword.value = false;
    useKey.value = false;
    identityFile.value = "";
    strictHostKeyChecking.value = "accept-new";
    secretStrategy.value = "keychain";
    phase.value = "idle";
    errorMessage.value = null;
    testPhase.value = "idle";
    testResult.value = null;
    void nextTick(() => setTimeout(() => hostInput.value?.focus(), 10));
  },
);

// Any edit that would change the probe outcome invalidates the previous
// result — otherwise a green chip could mislead after a tweak.
watch(
  () =>
    [
      host.value,
      port.value,
      user.value,
      password.value,
      useKey.value,
      identityFile.value,
      strictHostKeyChecking.value,
      secretStrategy.value,
    ] as const,
  () => {
    if (testPhase.value !== "idle") {
      testPhase.value = "idle";
      testResult.value = null;
    }
  },
);

const remotePath = ref("");

watch(
  () => [props.open] as const,
  () => {
    if (!props.open) return;
    remotePath.value = "";
  },
);
watch(remotePath, () => {
  if (testPhase.value !== "idle") {
    testPhase.value = "idle";
    testResult.value = null;
  }
});

/**
 * Derive the canonical SshAuthMode from the form's state. See the
 * comment at the top of this file for the decision table.
 */
const authMode = computed<SshAuthMode>(() => {
  if (useKey.value) {
    return identityFile.value.trim().length > 0 ? "key" : "agent";
  }
  // A strategy of `prompt` / `none` signals intent to do password
  // auth even when the field is empty — otherwise picking "Ask every
  // time" with nothing typed would silently fall through to agent
  // auth and the whole point of the dropdown is lost.
  if (password.value.length > 0) return "password";
  if (secretStrategy.value === "prompt" || secretStrategy.value === "none") {
    return user.value.trim().length > 0 ? "password" : "agent";
  }
  return "agent";
});

const authModeLabel = computed<string>(() => {
  switch (authMode.value) {
    case "password":
      return "Password authentication";
    case "key":
      return "Private-key authentication";
    case "agent":
      return "SSH agent / ~/.ssh/config";
  }
  return "SSH agent / ~/.ssh/config";
});

/**
 * Name of the OS credential vault the secret will be encrypted with —
 * surfaced to the user so the security copy is accurate on whichever
 * platform they're running. The actual platform string comes from
 * preload (`window.platform`) so the renderer doesn't need node types.
 */
const keychainLabel = computed<string>(() => {
  switch (window.platform) {
    case "darwin":
      return "macOS Keychain";
    case "win32":
      return "Windows Credential Vault (DPAPI)";
    default:
      return "the system keyring (libsecret)";
  }
});

/**
 * Password row label — passphrase when the user opts into key auth,
 * plain "Password" otherwise.
 */
const passwordRowLabel = computed(() => (useKey.value ? "Passphrase" : "Password"));

const passwordRowPlaceholder = computed(() => {
  if (secretStrategy.value === "none") return "(none)";
  if (useKey.value) return "passphrase (optional)";
  return "password";
});

/** Summary for the footer security note — depends on strategy + platform. */
const secretStorageNote = computed(() => {
  switch (secretStrategy.value) {
    case "keychain":
      return `Encrypted with ${keychainLabel.value} — never written to projects.json.`;
    case "prompt":
      return "Not stored — you'll be prompted each time this project connects.";
    case "none":
      return "No password will be sent — works for unencrypted keys or agent-backed auth.";
  }
  return "No password will be sent — works for unencrypted keys or agent-backed auth.";
});

function buildSshConfig(): SshConfig {
  const ssh: SshConfig = {
    host: host.value.trim(),
    authMode: authMode.value,
    strictHostKeyChecking: strictHostKeyChecking.value,
    secretStrategy: authMode.value === "agent" ? "none" : secretStrategy.value,
  };
  if (port.value !== null) ssh.port = port.value;
  if (user.value.trim()) ssh.user = user.value.trim();
  if (authMode.value === "key" && identityFile.value.trim()) {
    ssh.identityFile = identityFile.value.trim();
  }
  return ssh;
}

// Shape check — mirrors src/main/sshSession.validateSshConfig so the
// user can't submit something we'll reject.
const canTest = computed(() => {
  if (testPhase.value === "testing" || phase.value === "saving") return false;
  if (!host.value.trim()) return false;
  if (host.value.startsWith("-")) return false;
  if (!/^[A-Za-z0-9._:%-]+$/.test(host.value)) return false;
  if (user.value && (user.value.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(user.value))) return false;
  if (port.value !== null && (!Number.isInteger(port.value) || port.value < 1 || port.value > 65535)) return false;
  const rp = remotePath.value.trim();
  if (!rp) return false;
  if (!rp.startsWith("/") && !rp.startsWith("~")) return false;
  // Password auth needs a user.
  if (authMode.value === "password" && !user.value.trim()) return false;
  // Key auth needs the file path (the agent fallback kicks in only
  // when the box is unchecked OR the path is empty).
  return true;
});

const canSubmit = computed(() => {
  if (phase.value === "saving" || testPhase.value === "testing") return false;
  if (!name.value.trim()) return false;
  return canTest.value;
});

async function pickIdentityFile(): Promise<void> {
  const picked = await window.lsp.projectsPickSshKey();
  if (!picked) return;
  identityFile.value = picked;
  useKey.value = true;
}

async function test(): Promise<void> {
  if (!canTest.value) return;
  testPhase.value = "testing";
  testResult.value = null;
  const ssh = buildSshConfig();
  // Secret for the probe:
  //   • keychain  — use whatever the user typed (even if they haven't
  //                 saved yet; the Test button is a pre-save check).
  //   • prompt    — if the user typed something, try it; otherwise let
  //                 the main process try with no secret (will surface
  //                 as auth failure).
  //   • none      — no secret supplied.
  const secret =
    (ssh.secretStrategy === "keychain" || ssh.secretStrategy === "prompt") && password.value.length > 0
      ? password.value
      : undefined;
  const input: TestSshInput = {
    projectPath: remotePath.value.trim(),
    ssh,
    secret,
  };
  try {
    const result = await window.lsp.projectsTestSsh(input);
    testResult.value = result;
    testPhase.value = result.ok ? "ok" : "fail";
  } catch (err) {
    testResult.value = { ok: false, error: (err as Error).message ?? String(err), stage: "unknown" };
    testPhase.value = "fail";
  }
}

type TestFailStage = Extract<SshTestResult, { ok: false }>["stage"];

function testStageLabel(stage: TestFailStage): string {
  switch (stage) {
    case "connect":
      return "SSH connection failed";
    case "auth":
      return "Authentication failed";
    case "no_php":
      return "PHP missing on remote";
    case "no_path":
      return "Remote path not found";
    case "not_laravel":
      return "Not a Laravel project";
    case "php_failed":
      return "PHP failed to run";
    case "timeout":
      return "Connection timed out";
    case "unknown":
      return "Connection test failed";
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  phase.value = "saving";
  errorMessage.value = null;
  const ssh = buildSshConfig();
  // The plaintext password is ONLY sent to the main process when the
  // strategy is `keychain` — that's the one strategy that persists it.
  // For `prompt` / `command` / `none` the typed value (if any) stays
  // on this form and is discarded on close.
  const shouldSendSecret = ssh.secretStrategy === "keychain" && password.value.length > 0;
  const input: NewSshProjectInput = {
    name: name.value.trim(),
    projectPath: remotePath.value.trim(),
    ssh,
    secret: shouldSendSecret ? password.value : undefined,
  };
  try {
    const created = await window.lsp.projectsAddSsh(input);
    phase.value = "success";
    emit("added", created);
    setTimeout(() => emit("close"), 600);
  } catch (err) {
    phase.value = "error";
    errorMessage.value = (err as Error).message ?? String(err);
  }
}
</script>

<template>
  <Modal
    :open="open"
    :elevated="true"
    title="Add SSH project"
    description="Connect to a remote Laravel project over SSH"
    content-class="dialog-shell w-[640px] max-w-[92vw]"
    @close="emit('close')"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
      <Network :size="14" class="text-accent" />
      <h2 class="text-[13px] font-semibold text-fg">Add SSH project</h2>
      <div class="flex-1" />
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <form class="px-5 py-4 space-y-3" @submit.prevent="submit">
      <div class="grid grid-cols-[90px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Name</label>
        <input v-model="name" class="field font-mono" placeholder="acme-prod" autocomplete="off" spellcheck="false" />
      </div>

      <div class="grid grid-cols-[90px_1fr_60px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Server</label>
        <input
          ref="hostInput"
          v-model="host"
          class="field font-mono"
          placeholder="192.168.1.1"
          autocomplete="off"
          spellcheck="false"
        />
        <label class="text-[12px] text-fg-muted text-right">Port</label>
        <input v-model.number="port" type="number" min="1" max="65535" class="field font-mono" placeholder="22" />
      </div>

      <div class="grid grid-cols-[90px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">User</label>
        <input v-model="user" class="field font-mono" placeholder="user name" autocomplete="off" spellcheck="false" />
      </div>

      <div class="grid grid-cols-[90px_1fr_170px] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">{{ passwordRowLabel }}</label>
        <div class="relative">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="field font-mono w-full pr-8"
            :placeholder="passwordRowPlaceholder"
            :disabled="secretStrategy === 'none'"
            autocomplete="off"
            spellcheck="false"
          />
          <button
            v-if="secretStrategy !== 'none'"
            type="button"
            class="absolute inset-y-0 right-1.5 flex items-center text-fg-muted hover:text-fg"
            :title="showPassword ? 'Hide password' : 'Show password'"
            @click="showPassword = !showPassword"
          >
            <Eye v-if="showPassword" :size="12" />
            <EyeOff v-else :size="12" />
          </button>
        </div>
        <select v-model="secretStrategy" class="select" :title="secretStorageNote">
          <option value="keychain">Store in keychain</option>
          <option value="prompt">Ask every time</option>
          <option value="none">No password</option>
        </select>
      </div>

      <div class="grid grid-cols-[90px_1fr] items-start gap-3">
        <label class="text-[12px] text-fg-muted text-right pt-2 inline-flex items-center gap-1.5 justify-end">
          <input v-model="useKey" type="checkbox" class="accent-[var(--accent)]" />
          <span class="whitespace-nowrap">Use SSH key</span>
        </label>
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <input
              v-model="identityFile"
              class="field font-mono flex-1 min-w-0 disabled:opacity-50"
              :disabled="!useKey"
              :placeholder="identityFilePlaceholder"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="button" class="btn-subtle shrink-0" title="Select SSH private key" @click="pickIdentityFile">
              <FolderOpen :size="12" />
              Browse…
            </button>
          </div>
          <p class="text-[11px] text-fg-muted">
            Leave empty to fall back to ssh-agent or
            <code class="font-mono">~/.ssh/config</code>.
          </p>
        </div>
      </div>

      <div class="grid grid-cols-[90px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Remote path</label>
        <input
          v-model="remotePath"
          class="field font-mono"
          placeholder="/var/www/acme"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="grid grid-cols-[90px_1fr] items-center gap-3">
        <label class="text-[12px] text-fg-muted text-right">Host-key</label>
        <select v-model="strictHostKeyChecking" class="select">
          <option value="accept-new">Accept new hosts (trust on first use)</option>
          <option value="yes">Strict — reject unknown hosts</option>
        </select>
      </div>

      <div class="flex items-start gap-2 pt-1 text-[11px] text-fg-muted border-t border-line">
        <span class="mt-0.5 shrink-0">
          <KeyRound v-if="authMode === 'key'" :size="12" />
          <Lock v-else-if="authMode === 'password'" :size="12" />
          <Network v-else :size="12" />
        </span>
        <div class="flex-1">
          <div class="text-fg">{{ authModeLabel }}</div>
          <div v-if="authMode === 'password' || authMode === 'key'">
            {{ secretStorageNote }}
          </div>
          <div v-else>No credential will be sent — authentication goes through your running agent / ~/.ssh/config.</div>
        </div>
      </div>

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
        <span
          >Connected · PHP <span class="font-mono">{{ testResult.phpVersion }}</span></span
        >
        <span v-if="testResult.laravelDetected" class="text-success/80">· Laravel detected</span>
        <span v-else class="text-warning/90">· not a Laravel project</span>
      </div>
      <div
        v-else-if="testPhase === 'fail' && testResult && !testResult.ok"
        class="flex items-start gap-1.5 text-[11px] text-danger min-w-0"
      >
        <AlertTriangle :size="11" class="mt-0.5 shrink-0" />
        <div class="flex-1 min-w-0">
          <span class="font-medium">{{ testStageLabel(testResult.stage) }}</span>
          <span class="text-danger/80"> — {{ testResult.error }}</span>
        </div>
      </div>

      <div class="flex items-center justify-between gap-2">
        <button
          class="btn-subtle disabled:opacity-40"
          :disabled="!canTest"
          :title="canTest ? 'Probe the host + path + remote PHP' : 'Fill in host and remote path first'"
          @click="test"
        >
          <Loader2 v-if="testPhase === 'testing'" :size="12" class="animate-spin" />
          <Plug v-else :size="12" />
          {{ testPhase === "testing" ? "Testing…" : "Test connection" }}
        </button>
        <div class="flex items-center gap-2">
          <button class="btn-subtle" @click="emit('close')">Cancel</button>
          <button class="btn-primary disabled:opacity-40" :disabled="!canSubmit" @click="submit">
            {{ phase === "saving" ? "Saving…" : "Add project" }}
          </button>
        </div>
      </div>
    </footer>
  </Modal>
</template>
