<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { KeyRound, Lock, X } from "lucide-vue-next";
import type { SshAuthMode } from "../../shared/ipc";
import Modal from "./Modal.vue";

/**
 * Password / passphrase prompt driven by the main process via
 * `onSecretPrompt`. Used when an SSH project has strategy "prompt" —
 * we deliberately don't store the secret, so every connect asks.
 *
 * Multiple prompts can arrive back-to-back (user hit Run on several
 * prompt-strategy tabs in quick succession). We handle them as a queue:
 * render one at a time, shift on resolve.
 */

interface PromptRequest {
  id: string;
  projectId: string;
  projectName: string;
  authMode: SshAuthMode;
}

const queue = ref<PromptRequest[]>([]);
const active = computed<PromptRequest | null>(() => queue.value[0] ?? null);
const open = computed(() => active.value !== null);
const value = ref("");
const inputEl = useTemplateRef<HTMLInputElement>("inputEl");

let offListener: (() => void) | null = null;
onMounted(() => {
  offListener = window.lsp.onSecretPrompt((req) => {
    queue.value = [...queue.value, req];
  });
});
onBeforeUnmount(() => {
  // Reject everything still queued so the main process isn't left
  // hanging if the window is being torn down.
  for (const req of queue.value) {
    window.lsp.secretPromptRespond(req.id, null);
  }
  queue.value = [];
  offListener?.();
});

// Every time we present a fresh prompt, reset the field and focus it
// so the user can just start typing.
watch(active, (req) => {
  if (!req) return;
  value.value = "";
  void nextTick(() => setTimeout(() => inputEl.value?.focus(), 10));
});

function submit(): void {
  const req = active.value;
  if (!req) return;
  window.lsp.secretPromptRespond(req.id, value.value);
  advance();
}

function cancel(): void {
  const req = active.value;
  if (!req) return;
  window.lsp.secretPromptRespond(req.id, null);
  advance();
}

function advance(): void {
  queue.value = queue.value.slice(1);
  value.value = "";
}

const label = computed(() => {
  if (!active.value) return "";
  return active.value.authMode === "key" ? "Passphrase" : "Password";
});

const subtitle = computed(() => {
  const req = active.value;
  if (!req) return "";
  return req.authMode === "key"
    ? `Enter the passphrase for the private key used by ${req.projectName}`
    : `Enter the SSH password for ${req.projectName}`;
});
</script>

<template>
  <Modal
    :open="open"
    :elevated="true"
    :title="label"
    :description="subtitle"
    content-class="dialog-shell w-[460px] max-w-[92vw]"
    @close="cancel"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
      <KeyRound v-if="active?.authMode === 'key'" :size="14" class="text-accent" />
      <Lock v-else :size="14" class="text-accent" />
      <h2 class="text-[13px] font-semibold text-fg">{{ label }} required</h2>
      <div class="flex-1" />
      <button class="icon-btn" title="Cancel (Esc)" aria-label="Cancel" @click="cancel">
        <X :size="14" />
      </button>
    </header>

    <form class="px-5 py-4 space-y-3" @submit.prevent="submit">
      <p class="text-[12px] text-fg-muted">{{ subtitle }}</p>
      <input
        ref="inputEl"
        v-model="value"
        type="password"
        class="field w-full font-mono"
        autocomplete="off"
        spellcheck="false"
      />
      <p class="text-[11px] text-fg-subtle">
        This prompt appears every connect because the project is configured to
        <span class="text-fg-muted">Ask every time</span>. Nothing is stored.
      </p>
    </form>

    <footer class="px-4 py-3 border-t border-line flex items-center justify-end gap-2">
      <button class="btn-subtle" @click="cancel">Cancel</button>
      <button class="btn-primary disabled:opacity-40" :disabled="value.length === 0" @click="submit">Connect</button>
    </footer>
  </Modal>
</template>
