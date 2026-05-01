<script setup lang="ts">
defineProps<{ label: string; hint?: string }>();
</script>

<template>
  <div class="flex items-start gap-4">
    <div class="w-40 shrink-0 pt-1">
      <div class="text-[12px] font-medium text-fg">{{ label }}</div>
      <div v-if="hint" class="text-[11px] text-fg-subtle mt-0.5">{{ hint }}</div>
    </div>
    <div class="flex-1 flex items-center">
      <slot />
    </div>
  </div>
</template>
