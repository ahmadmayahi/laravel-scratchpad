<script setup lang="ts">
import { storeToRefs } from "pinia";
import { X, Plus, Circle } from "lucide-vue-next";
import { useAppStore } from "../stores/app";
import { cn } from "../lib/cn";
import { displayKeys } from "../lib/shortcuts";

defineEmits<{ newTab: [] }>();

const store = useAppStore();
const { tabs, selectedTabId } = storeToRefs(store);
</script>

<template>
  <div class="flex items-center h-9 px-2 gap-1 border-b border-line bg-surface overflow-x-auto">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      :class="
        cn(
          'group inline-flex items-center gap-2 h-7 px-2.5 rounded-md text-[12px] transition-colors cursor-default',
          tab.id === selectedTabId
            ? 'bg-surface-3 text-fg border border-line shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]'
            : 'text-fg-muted border border-transparent hover:bg-surface-2 hover:text-fg',
        )
      "
      @click="store.selectTab(tab.id)"
    >
      <span v-if="tab.isStarting" class="relative flex h-2 w-2" title="Starting session">
        <span class="absolute inline-flex h-full w-full rounded-full bg-warning opacity-75 animate-ping" />
        <span class="relative inline-flex rounded-full h-2 w-2 bg-warning" />
      </span>
      <span v-else-if="tab.isRunning" class="relative flex h-2 w-2" title="Running">
        <span class="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
        <span class="relative inline-flex rounded-full h-2 w-2 bg-success" />
      </span>
      <Circle
        v-else
        :size="6"
        :class="tab.id === selectedTabId ? 'text-accent fill-accent' : 'text-fg-subtle fill-current'"
      />
      <span>{{ tab.title }}</span>
      <span
        v-if="tabs.length > 1"
        role="button"
        aria-label="Close tab"
        class="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:text-danger"
        @click.stop="store.closeTab(tab.id)"
      >
        <X :size="12" />
      </span>
    </button>
    <button class="icon-btn ml-1" :title="`New tab (${displayKeys('⌘T')})`" @click="$emit('newTab')">
      <Plus :size="14" />
    </button>
  </div>
</template>
