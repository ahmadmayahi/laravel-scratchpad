<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <div class="border-b border-line pb-2">
    <div class="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">{{ title }}</div>
    <div v-if="subtitle" class="text-[11px] text-fg-subtle mt-0.5">{{ subtitle }}</div>
  </div>
</template>
