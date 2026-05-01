<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle } from "lucide-vue-next";
import type { FramePayload } from "../../../shared/ipc";
import { tryParseJsonContainer } from "../../lib/pretty";
import ValueNode from "./ValueNode.vue";
import FileLink from "./FileLink.vue";
import TraceRow from "./TraceRow.vue";
import JsonTree from "./JsonTree.vue";

const props = defineProps<{ frame: FramePayload }>();

/**
 * If the stdout chunk is pure JSON (what `echo $model->toJson()` or
 * `json_encode(...)` produces), parse it so the template can render a
 * collapsible tree instead of a dense one-liner. Bare strings and
 * numbers that happen to parse are ignored — see `tryParseJsonContainer`.
 *
 * Returns `undefined` for anything that isn't a JSON container, in
 * which case the template falls back to the preformatted-text path.
 */
const stdoutJson = computed<unknown | undefined>(() => {
  if (props.frame.type !== "stdout") return undefined;
  return tryParseJsonContainer(props.frame.chunk);
});
</script>

<template>
  <div
    v-if="frame.type === 'stdout' && stdoutJson !== undefined"
    class="font-mono text-[12px] leading-relaxed border-l-2 border-accent/60 bg-accent/5 pl-3 pr-2 py-2 rounded"
  >
    <JsonTree :value="stdoutJson" />
  </div>
  <div
    v-else-if="frame.type === 'stdout'"
    class="font-mono text-[12px] leading-relaxed whitespace-pre-wrap border-l-2 border-accent/60 bg-accent/5 pl-3 pr-2 py-2 rounded"
  >
    {{ frame.chunk }}
  </div>

  <div v-else-if="frame.type === 'dump'" class="font-mono text-[12px] leading-relaxed">
    <ValueNode :value="frame.value" />
  </div>

  <div
    v-else-if="frame.type === 'error'"
    class="rounded-lg border border-danger/40 bg-danger/10 p-3 dark:border-danger/30 dark:bg-danger/5"
  >
    <div class="flex items-center gap-2 text-danger">
      <AlertTriangle :size="13" />
      <span class="font-semibold font-mono text-[12px]">{{ frame.class }}</span>
    </div>
    <div class="mt-1 font-mono text-[12px] text-fg leading-relaxed">
      {{ frame.message }}
    </div>
    <FileLink
      v-if="frame.file && frame.line !== undefined"
      :file="frame.file"
      :line="frame.line"
      extra-class="mt-1.5 text-[11px]"
    />
    <details v-if="frame.trace && frame.trace.length > 0" class="mt-2 text-[11px] text-fg-muted font-mono">
      <summary class="cursor-default hover:text-fg">Stack trace ({{ frame.trace.length }})</summary>
      <ol class="mt-1 ml-4 list-decimal space-y-0.5">
        <TraceRow v-for="(t, i) in frame.trace" :key="i" :entry="t" />
      </ol>
    </details>
  </div>
</template>
