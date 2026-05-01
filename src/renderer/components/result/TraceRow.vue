<script setup lang="ts">
import { computed } from "vue";
import type { TraceEntry } from "../../../shared/ipc";
import { compressHome } from "../../lib/pretty";

const props = defineProps<{ entry: TraceEntry }>();

const prettyFile = computed(() => (props.entry.file ? compressHome(props.entry.file) : "?"));
</script>

<template>
  <li>
    <span class="text-fg-subtle">{{ prettyFile }}:{{ entry.line ?? "?" }}</span>
    <span class="text-fg-muted ml-1">{{ entry.function }}</span>
  </li>
</template>
