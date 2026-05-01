<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { Sparkles, X, CheckCircle2, AlertTriangle } from "lucide-vue-next";
import type { IdeHelperProgress } from "../../shared/ipc";
import Modal from "./Modal.vue";

/**
 * One-shot prompt that offers to install `barryvdh/laravel-ide-helper` into
 * a Laravel project that doesn't have it. Runs composer require + three
 * artisan commands in the main process; streams progress into a scrollable
 * log below the CTA.
 *
 * Three terminal states per open:
 *   - Installed (success): auto-closes after a brief success message; parent
 *     refreshes the connections list.
 *   - Dismissed ("Not now"): closes without persisting — the renderer may
 *     choose to remember this for the session, but we don't call back into
 *     the store here.
 *   - Declined ("Don't ask again"): persists `ideHelperDeclined: true` for
 *     the connection in the main process so we never re-prompt.
 */

const props = defineProps<{
  /** Project id the prompt is for, or null when closed. */
  projectId: string | null;
  /** Human-readable name (e.g. "Laravel", "acme-app"). */
  projectName: string;
}>();

const emit = defineEmits<{
  close: [];
  /** Fired when "don't ask again" is clicked. Parent persists the flag. */
  declined: [projectId: string];
  /** Fired when the install succeeds. Parent refreshes projects. */
  installed: [projectId: string];
}>();

type Phase = "idle" | "installing" | "success" | "error";

const phase = ref<Phase>("idle");
const logLines = ref<string[]>([]);
const errorMessage = ref<string | null>(null);
const logEl = useTemplateRef<HTMLElement>("logEl");

const open = computed(() => props.projectId !== null);

// Reset state every time the prompt opens for a new project.
watch(open, (isOpen) => {
  if (!isOpen) return;
  phase.value = "idle";
  logLines.value = [];
  errorMessage.value = null;
});

// Stream composer / artisan lines into the log while `ideHelper:install`
// runs. Subscribe in onMounted so the listener's lifetime is tied to the
// component as Vue normally expects (rather than running at setup time,
// which is subtler to reason about).
let offProgress: (() => void) | null = null;
onMounted(() => {
  offProgress = window.lsp.onIdeHelperProgress((event: IdeHelperProgress) => {
    if (event.projectId !== props.projectId) return;
    if (event.stage === "done") {
      phase.value = "success";
      return;
    }
    if (event.stage === "error") {
      phase.value = "error";
      errorMessage.value = event.message;
      return;
    }
    logLines.value = [...logLines.value, `${stageLabel(event.stage)} › ${event.line}`];
    // Auto-scroll to the newest line.
    void nextTick(() => {
      const el = logEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
});

onBeforeUnmount(() => offProgress?.());

function stageLabel(stage: "composer-require" | "artisan-generate" | "artisan-models" | "artisan-meta"): string {
  switch (stage) {
    case "composer-require":
      return "composer";
    case "artisan-generate":
      return "generate";
    case "artisan-models":
      return "models";
    case "artisan-meta":
      return "meta";
  }
}

async function install(): Promise<void> {
  if (!props.projectId) return;
  phase.value = "installing";
  logLines.value = [];
  errorMessage.value = null;
  const ok = await window.lsp.ideHelperInstall(props.projectId);
  if (ok) {
    // Success phase is set from the "done" progress event. Notify
    // parent so it refreshes the project list (flipping
    // `ideHelperInstalled` to true).
    emit("installed", props.projectId);
  }
  // Failure leaves the modal open so the user can read the error tail.
}

function notNow(): void {
  emit("close");
}

async function dontAskAgain(): Promise<void> {
  if (props.projectId) emit("declined", props.projectId);
  emit("close");
}
</script>

<template>
  <Modal
    :open="open"
    title="Smarter autocomplete for Laravel"
    description="Install barryvdh/laravel-ide-helper to give Intelephense facade, model, and container-binding stubs."
    content-class="dialog-shell w-[560px] max-w-[92vw]"
    @close="emit('close')"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
      <Sparkles :size="14" class="text-accent" />
      <h2 class="text-[13px] font-semibold text-fg">Smarter autocomplete</h2>
      <div class="flex-1" />
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="notNow">
        <X :size="14" />
      </button>
    </header>

    <div class="px-5 py-4 space-y-3">
      <p class="text-[13px] text-fg leading-relaxed">
        <span class="font-medium">{{ projectName }}</span> doesn't have
        <code class="font-mono text-[12px] bg-surface-2 px-1 py-0.5 rounded">barryvdh/laravel-ide-helper</code>
        installed. Adding it generates stubs that teach Intelephense about your facades, Eloquent columns, and container
        bindings — so autocomplete, hover, and go-to-definition stop guessing.
      </p>
      <p class="text-[12px] text-fg-muted">
        We'll run <code class="font-mono">composer require --dev</code> and three
        <code class="font-mono">ide-helper</code> artisan commands inside the project.
      </p>

      <div v-if="phase !== 'idle'" class="mt-3 rounded-md border border-line bg-surface-2 overflow-hidden">
        <div
          class="px-3 py-1.5 border-b border-line flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
        >
          <template v-if="phase === 'installing'">
            <div class="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            <span class="text-fg-muted">Installing…</span>
          </template>
          <template v-else-if="phase === 'success'">
            <CheckCircle2 :size="12" class="text-success" />
            <span class="text-success">Installed — Intelephense will pick up the stubs shortly.</span>
          </template>
          <template v-else>
            <AlertTriangle :size="12" class="text-danger" />
            <span class="text-danger">Install failed</span>
          </template>
        </div>
        <div ref="logEl" class="max-h-48 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.5] text-fg-muted">
          <div v-for="(line, i) in logLines" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</div>
          <div v-if="phase === 'error' && errorMessage" class="mt-1 text-danger whitespace-pre-wrap break-all">
            {{ errorMessage }}
          </div>
        </div>
      </div>
    </div>

    <footer class="px-4 py-3 border-t border-line flex items-center justify-end gap-2">
      <template v-if="phase === 'success'">
        <button class="btn-primary" @click="emit('close')">Done</button>
      </template>
      <template v-else>
        <button
          class="btn-subtle text-fg-subtle disabled:opacity-40"
          :disabled="phase === 'installing'"
          @click="dontAskAgain"
        >
          Don't ask again
        </button>
        <button class="btn-subtle disabled:opacity-40" :disabled="phase === 'installing'" @click="notNow">
          Not now
        </button>
        <button class="btn-primary disabled:opacity-40" :disabled="phase === 'installing'" @click="install">
          {{ phase === "error" ? "Retry" : "Install" }}
        </button>
      </template>
    </footer>
  </Modal>
</template>
