<script setup lang="ts">
import { computed } from "vue";
import { compressHome } from "../../lib/pretty";

const props = defineProps<{
  file: string;
  line: number;
  extraClass?: string;
}>();

const pretty = computed(() => compressHome(props.file));
</script>

<template>
  <div :class="`font-mono text-fg-muted ${extraClass ?? ''}`">{{ pretty }}:{{ line }}</div>
</template>
