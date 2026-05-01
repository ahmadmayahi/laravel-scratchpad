<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";

/**
 * Collapsible JSON renderer. Takes a parsed JS value (from
 * `JSON.parse` — not a string) and walks it with the same
 * `<details>/<summary>` expand/collapse pattern as `ValueNode`,
 * so a `toJson()` / `json_encode` payload lines up visually with a
 * `dd($model)` tree next to it.
 *
 * Container previews ("3 items", "…") sit on the summary so the user
 * can eyeball the shape before expanding. First two levels auto-open
 * — below that, collapsed by default so a giant payload doesn't blow
 * up the result pane on first render.
 */

const props = withDefaults(
  defineProps<{
    value: unknown;
    /** JSON-pointer-ish label for object keys / array indices. Only
     *  rendered at depth > 0 — the root node doesn't get a label. */
    label?: string;
    depth?: number;
  }>(),
  { depth: 0, label: "" },
);

type JsonKind = "null" | "bool" | "number" | "string" | "array" | "object";

const kind = computed<JsonKind>(() => {
  const v = props.value;
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "boolean") return "bool";
  if (t === "number") return "number";
  if (t === "string") return "string";
  return "object";
});

const entries = computed<Array<[string, unknown]>>(() => {
  if (kind.value === "object") {
    return Object.entries(props.value as Record<string, unknown>);
  }
  if (kind.value === "array") {
    return (props.value as unknown[]).map((v, i) => [String(i), v] as [string, unknown]);
  }
  return [];
});

const count = computed(() => entries.value.length);

const openBracket = computed(() => (kind.value === "array" ? "[" : "{"));
const closeBracket = computed(() => (kind.value === "array" ? "]" : "}"));
</script>

<template>
  <span v-if="kind === 'null'" class="italic text-fg-muted">null</span>
  <span v-else-if="kind === 'bool'" class="text-code-bool">{{ String(value) }}</span>
  <span v-else-if="kind === 'number'" class="text-code-number">{{ String(value) }}</span>
  <span v-else-if="kind === 'string'" class="text-code-string">"{{ value }}"</span>

  <details v-else class="group" :open="depth < 2">
    <summary class="cursor-default list-none inline-flex items-center gap-1 hover:text-fg">
      <ChevronRight :size="10" class="text-fg-muted group-open:rotate-90 transition-transform" />
      <span class="text-fg-subtle">{{ openBracket }}</span>
      <span class="text-fg-subtle text-[10px]">
        {{ count }} {{ kind === "array" ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys" }}
      </span>
      <span class="text-fg-subtle">{{ closeBracket }}</span>
    </summary>
    <div class="ml-3 border-l border-line pl-3 mt-0.5 space-y-0.5">
      <div v-for="[k, v] in entries" :key="k" class="flex gap-2">
        <span v-if="kind === 'object'" class="text-code-prop shrink-0">"{{ k }}"</span>
        <span v-else class="text-fg-muted shrink-0">{{ k }}</span>
        <span class="text-fg-subtle">:</span>
        <span class="flex-1 min-w-0">
          <JsonTree :value="v" :depth="depth + 1" />
        </span>
      </div>
    </div>
  </details>
</template>
