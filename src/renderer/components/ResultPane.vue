<script setup lang="ts">
import { computed } from "vue";
import { Terminal, CheckCircle2, Trash2, Loader2 } from "lucide-vue-next";
import type { FramePayload } from "../../shared/ipc";
import { useAppStore } from "../stores/app";
import type { Tab } from "../stores/app";
import { insertSnippetIntoActiveEditor } from "../composables/useEditorRegistry";
import FrameRow from "./result/FrameRow.vue";
import EmptyState from "./result/EmptyState.vue";

const props = defineProps<{ tab: Tab }>();

const store = useAppStore();

const groups = computed(() => groupByRun(props.tab.frames));
const hasAny = computed(() => groups.value.length > 0);

function clearResults(): void {
  store.clearTabFrames(props.tab.id);
}

function loadSnippet(code: string): void {
  // Starter snippets ship with `<?php` openers; strip before insertion.
  insertSnippetIntoActiveEditor(code.replace(/^\s*<\?php[ \t]*\n?/, ""));
}

function groupByRun(frames: FramePayload[]): FramePayload[][] {
  const out: FramePayload[][] = [];
  let current: FramePayload[] = [];
  for (const f of frames) {
    current.push(f);
    if (f.type === "result" || f.type === "error" || f.type === "cancelled") {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}
</script>

<template>
  <div class="flex-1 min-w-0 flex flex-col h-full bg-bg">
    <div class="flex items-center h-9 px-3 border-b border-line bg-surface/80 backdrop-blur-xs">
      <Terminal :size="12" class="text-fg-muted mr-2" />
      <span class="text-[11px] font-medium uppercase tracking-wider text-fg-muted">Result</span>
      <span v-if="tab.lastDurationMs !== null" class="ml-3 chip">
        <CheckCircle2 :size="10" class="text-code-string" />
        <span class="tabular-nums">{{ tab.lastDurationMs }}ms</span>
      </span>
      <div class="flex-1" />
      <span v-if="tab.isStarting" class="chip">
        <Loader2 :size="10" class="animate-spin text-success" />
        Starting
      </span>
      <span v-else-if="tab.isRunning" class="chip">
        <Loader2 :size="10" class="animate-spin text-success" />
        Running
      </span>
      <button v-if="hasAny" class="icon-btn ml-1" title="Clear results" @click="clearResults">
        <Trash2 :size="12" />
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto select-text">
      <EmptyState v-if="!hasAny && !tab.isRunning" @pick-snippet="loadSnippet" />

      <div
        v-for="(group, i) in groups"
        :key="group[0]?.id ?? i"
        class="px-3 py-3 border-b border-line last:border-0 space-y-2"
      >
        <FrameRow v-for="(f, j) in group" :key="j" :frame="f" />
      </div>
    </div>
  </div>
</template>
