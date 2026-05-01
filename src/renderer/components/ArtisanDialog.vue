<script setup lang="ts">
import { nextTick, ref, useTemplateRef, watch } from "vue";
import { Terminal, X, Play, ChevronRight } from "lucide-vue-next";
import Modal from "./Modal.vue";
import { loadArtisanHistory, recordArtisanCommand, synthesizeArtisanCode } from "../lib/artisan";

/**
 * Artisan command runner modal — opened from the command palette. The
 * always-visible toolbar input (ArtisanInput) is the fast path; this
 * dialog is for browsing examples + history on a wider canvas. Both
 * share `lib/artisan.ts` so the wrapping + history are identical.
 */

const EXAMPLES = [
  "route:list --json",
  "about --json",
  "config:show app",
  "tinker --execute='echo 1'",
  "db:show",
  "model:show User",
  "queue:monitor default",
];

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  close: [];
  run: [code: string];
}>();

const cmd = ref("");
const history = ref<string[]>(loadArtisanHistory());
const historyIdx = ref<number | null>(null);
const inputEl = useTemplateRef<HTMLInputElement>("inputEl");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    cmd.value = "";
    historyIdx.value = null;
    history.value = loadArtisanHistory();
    // Defer focus so Reka's focus-trap and the dialog fade-in both
    // complete before we grab the caret.
    void nextTick(() => setTimeout(() => inputEl.value?.focus(), 10));
  },
);

function submit(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  history.value = recordArtisanCommand(history.value, trimmed);
  emit("run", synthesizeArtisanCode(trimmed));
  emit("close");
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    submit(cmd.value);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (history.value.length === 0) return;
    const next = historyIdx.value === null ? 0 : Math.min(historyIdx.value + 1, history.value.length - 1);
    historyIdx.value = next;
    cmd.value = history.value[next] ?? "";
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (historyIdx.value === null) return;
    const next = historyIdx.value - 1;
    if (next < 0) {
      historyIdx.value = null;
      cmd.value = "";
    } else {
      historyIdx.value = next;
      cmd.value = history.value[next] ?? "";
    }
  }
}

function onInputChange(e: Event): void {
  cmd.value = (e.target as HTMLInputElement).value;
  historyIdx.value = null;
}
</script>

<template>
  <Modal
    :open="open"
    title="Run Artisan command"
    align="top"
    content-class="dialog-shell w-[640px] max-w-[92vw]"
    @close="emit('close')"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
      <Terminal :size="14" class="text-fg-muted" />
      <h2 class="text-[13px] font-semibold text-fg">Run Artisan command</h2>
      <div class="flex-1" />
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <div class="flex items-center gap-2 px-4 py-3 border-b border-line bg-surface-2">
      <span class="text-fg-subtle font-mono text-[12px] select-none">php&nbsp;artisan</span>
      <input
        ref="inputEl"
        class="flex-1 bg-transparent font-mono text-[13px] text-fg placeholder:text-fg-subtle outline-none"
        placeholder="route:list --json"
        :value="cmd"
        autocomplete="off"
        spellcheck="false"
        @input="onInputChange"
        @keydown="onInputKey"
      />
      <button class="btn-primary disabled:opacity-40" :disabled="!cmd.trim()" @click="submit(cmd)">
        <Play :size="11" fill="currentColor" />
        Run
      </button>
    </div>

    <div class="max-h-[48vh] overflow-y-auto p-2">
      <div v-if="history.length > 0" class="mb-3 last:mb-0">
        <div class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Recent</div>
        <button
          v-for="(h, i) in history"
          :key="`h-${i}-${h}`"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-2 cursor-default text-[12px] font-mono text-left group"
          @click="submit(h)"
        >
          <ChevronRight :size="10" class="text-fg-subtle group-hover:text-fg-muted shrink-0" />
          <span class="text-fg truncate">{{ h }}</span>
        </button>
      </div>

      <div v-if="!cmd.trim()" class="mb-3 last:mb-0">
        <div class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Examples</div>
        <button
          v-for="e in EXAMPLES"
          :key="`e-${e}`"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-2 cursor-default text-[12px] font-mono text-left group"
          @click="submit(e)"
        >
          <ChevronRight :size="10" class="text-fg-subtle group-hover:text-fg-muted shrink-0" />
          <span class="text-fg-muted truncate">{{ e }}</span>
        </button>
      </div>
    </div>

    <footer class="px-4 py-2 border-t border-line text-[11px] text-fg-subtle flex items-center gap-3">
      <span>↑↓ history · Enter run · Esc close</span>
    </footer>
  </Modal>
</template>
