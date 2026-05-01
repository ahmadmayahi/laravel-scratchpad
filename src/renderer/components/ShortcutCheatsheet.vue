<script setup lang="ts">
import { computed } from "vue";
import { Keyboard, X } from "lucide-vue-next";
import { SHORTCUTS, displayKeys, type ShortcutGroup, type Shortcut } from "../lib/shortcuts";
import Modal from "./Modal.vue";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const grouped = computed<Record<ShortcutGroup, Shortcut[]>>(() => {
  const acc: Record<string, Shortcut[]> = {};
  for (const s of SHORTCUTS) {
    (acc[s.group] ??= []).push(s);
  }
  return acc as Record<ShortcutGroup, Shortcut[]>;
});
</script>

<template>
  <Modal
    :open="open"
    title="Keyboard shortcuts"
    content-class="dialog-shell w-[640px] max-w-[92vw] max-h-[82vh]"
    @close="emit('close')"
  >
    <header class="flex items-center gap-2 px-5 py-3 border-b border-line">
      <Keyboard :size="14" class="text-fg-muted" />
      <h2 class="text-[14px] font-semibold text-fg">Keyboard shortcuts</h2>
      <div class="flex-1" />
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <div class="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-x-8 gap-y-5">
      <section v-for="(items, group) in grouped" :key="group">
        <h3 class="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">
          {{ group }}
        </h3>
        <ul class="space-y-1">
          <li v-for="s in items" :key="s.keys + s.label" class="flex items-center gap-3 text-[12px]">
            <span class="flex-1 text-fg">{{ s.label }}</span>
            <kbd class="kbd font-mono">{{ displayKeys(s.keys) }}</kbd>
          </li>
        </ul>
      </section>
    </div>

    <footer class="px-4 py-2 border-t border-line text-[11px] text-fg-subtle">
      Shortcuts in the <span class="text-fg">Editor</span> section are handled by Monaco while the editor has focus.
    </footer>
  </Modal>
</template>
