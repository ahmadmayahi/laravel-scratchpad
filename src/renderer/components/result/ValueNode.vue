<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import type { DumpedValue } from "../../../shared/ipc";
import { tryParseJsonContainer } from "../../lib/pretty";
import JsonTree from "./JsonTree.vue";

const props = withDefaults(
  defineProps<{
    value: DumpedValue;
    depth?: number;
  }>(),
  { depth: 0 },
);

/**
 * Display string for an Eloquent model's primary key. Extracted here so the
 * template doesn't have to embed a type-assertion expression containing
 * `{ ... }` — Vue's template parser collides with the curly braces.
 */
const eloquentKey = computed<string>(() => {
  if (props.value.kind !== "eloquent" || !props.value.key) return "";
  const k = props.value.key as { value?: unknown };
  return String(k.value ?? "");
});

/**
 * If a dumped string is actually a JSON container (common result of
 * `dd($model->toJson())` or `dump(Http::get(...)->body())`), parse it
 * so the template can swap to the collapsible tree view. Skipped when
 * the dumper flagged the string as `truncated` — a JSON parse would
 * fail on a cut-off payload and we'd rather show the raw prefix than
 * silently drop the hint that data was elided.
 */
const stringAsJson = computed<unknown | undefined>(() => {
  if (props.value.kind !== "string" || props.value.truncated) return undefined;
  return tryParseJsonContainer(props.value.value);
});
</script>

<template>
  <span v-if="value.kind === 'null'" class="italic text-fg-muted">null</span>
  <span v-else-if="value.kind === 'bool'" class="text-code-bool">{{ String(value.value) }}</span>
  <span v-else-if="value.kind === 'int' || value.kind === 'float'" class="text-code-number">{{
    String(value.value)
  }}</span>
  <span v-else-if="value.kind === 'string' && stringAsJson !== undefined" class="inline-flex items-start gap-1">
    <JsonTree :value="stringAsJson" :depth="depth" />
    <span class="text-fg-subtle text-[10px] ml-1">(json, {{ value.length }}b)</span>
  </span>
  <span v-else-if="value.kind === 'string'" class="text-code-string">
    "{{ value.value }}{{ value.truncated ? "…" : "" }}"
    <span class="text-fg-subtle text-[10px] ml-1">({{ value.length }})</span>
  </span>
  <span v-else-if="value.kind === 'resource'" class="text-code-number">
    resource({{ value.type }})#{{ value.id }}
  </span>
  <span v-else-if="value.kind === 'uninitialized'" class="italic text-fg-muted">uninitialized</span>
  <span v-else-if="value.kind === 'truncated'" class="italic text-fg-muted">…</span>

  <details v-else-if="value.kind === 'array' || value.kind === 'iterable'" class="group" :open="depth < 2">
    <summary class="cursor-default list-none inline-flex items-center gap-1 hover:text-fg">
      <ChevronRight :size="10" class="text-fg-muted group-open:rotate-90 transition-transform" />
      <span class="text-code-class">{{ value.kind === "array" ? "array" : value.class }}</span>
      <span class="text-fg-subtle text-[10px] ml-1">({{ value.count }})</span>
    </summary>
    <div class="ml-3 border-l border-line pl-3 mt-0.5 space-y-0.5">
      <div v-for="(item, i) in value.items" :key="i" class="flex gap-2">
        <span class="text-fg-muted shrink-0">{{ String(item.key) }}</span>
        <span class="text-fg-subtle">=</span>
        <span class="flex-1 min-w-0">
          <ValueNode :value="item.value" :depth="depth + 1" />
        </span>
      </div>
    </div>
  </details>

  <details v-else-if="value.kind === 'object' || value.kind === 'eloquent'" class="group" :open="depth < 2">
    <summary class="cursor-default list-none inline-flex items-center gap-1 hover:text-fg">
      <ChevronRight :size="10" class="text-fg-muted group-open:rotate-90 transition-transform" />
      <span class="text-code-class font-medium">{{ value.class }}</span>
      <span v-if="eloquentKey" class="text-fg-muted ml-1">#{{ eloquentKey }}</span>
    </summary>
    <div class="ml-3 border-l border-line pl-3 mt-0.5 space-y-0.5">
      <div v-for="(p, i) in value.props" :key="i" class="flex gap-2">
        <span class="text-fg-muted shrink-0">{{ p.name }}</span>
        <span class="text-fg-subtle text-[10px] self-center">[{{ p.visibility }}]</span>
        <span class="text-fg-subtle">=</span>
        <span class="flex-1 min-w-0">
          <ValueNode :value="p.value" :depth="depth + 1" />
        </span>
      </div>
    </div>
  </details>

  <span v-else-if="value.kind === 'datetime'">
    <span class="text-code-class">{{ value.class }}</span>
    <span class="text-code-string ml-1">{{ value.iso }}</span>
    <span class="text-fg-subtle text-[10px] ml-1">{{ value.tz }}</span>
  </span>

  <span v-else class="text-fg-muted">?</span>
</template>
