<script setup lang="ts">
import { nextTick, ref, useTemplateRef, watch } from "vue";
import { storeToRefs } from "pinia";
import { Bookmark, X, Trash2, Pencil, Check, FileCode } from "lucide-vue-next";
import { useAppStore } from "../stores/app";
import { cn } from "../lib/cn";
import { insertSnippetIntoActiveEditor } from "../composables/useEditorRegistry";
import type { Snippet } from "../../shared/ipc";
import Modal from "./Modal.vue";

const props = defineProps<{
  open: boolean;
  initialMode?: "manage" | "save";
}>();
const emit = defineEmits<{ close: [] }>();

const store = useAppStore();
const { snippets, selectedTab } = storeToRefs(store);

const mode = ref<"manage" | "save">(props.initialMode ?? "manage");
const saveName = ref("");
const editingId = ref<string | null>(null);
const editingName = ref("");
const saveInput = useTemplateRef<HTMLInputElement>("saveInput");

watch(
  () => [props.open, props.initialMode] as const,
  ([open, initialMode]) => {
    if (!open) return;
    mode.value = initialMode ?? "manage";
    saveName.value = "";
    editingId.value = null;
    if (initialMode === "save") {
      void nextTick(() => setTimeout(() => saveInput.value?.focus(), 10));
    }
  },
);

async function saveCurrent(name: string): Promise<void> {
  if (!selectedTab.value || !name.trim()) return;
  const s = await window.lsp.snippetsSave({ name: name.trim(), code: ensurePhpOpener(selectedTab.value.code) });
  store.upsertSnippet(s);
  saveName.value = "";
  mode.value = "manage";
}

async function rename(id: string, name: string): Promise<void> {
  if (!name.trim()) return;
  const existing = snippets.value.find((s) => s.id === id);
  if (!existing) return;
  const s = await window.lsp.snippetsSave({ id, name: name.trim(), code: existing.code });
  store.upsertSnippet(s);
  editingId.value = null;
}

async function del(id: string): Promise<void> {
  await window.lsp.snippetsDelete(id);
  store.removeSnippet(id);
}

function insert(s: Snippet): void {
  insertSnippetIntoActiveEditor(stripPhpOpener(s.code));
  emit("close");
}

function stripPhpOpener(code: string): string {
  return code.replace(/^\s*<\?php[ \t]*\n?/, "");
}

/**
 * Scratch tabs always begin with `<?php` — both because the runner strips
 * it before `eval`, and because Monaco's PHP tokenizer only kicks in when
 * the opener is on line 1. Snippets saved before that invariant existed
 * (or saved from a buffer that somehow lost it) would otherwise wipe the
 * opener when "Save current buffer" re-reads from the tab code.
 */
function ensurePhpOpener(code: string): string {
  return /^\s*<\?php\b/.test(code) ? code : `<?php\n\n${code}`;
}

function startEdit(s: Snippet): void {
  editingId.value = s.id;
  editingName.value = s.name;
}

function toggleMode(): void {
  mode.value = mode.value === "save" ? "manage" : "save";
}
</script>

<template>
  <Modal
    :open="open"
    title="Snippets"
    content-class="dialog-shell w-[640px] max-w-[92vw] h-[560px] max-h-[86vh]"
    @close="emit('close')"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
      <Bookmark :size="14" class="text-fg-muted" />
      <h2 class="text-[13px] font-semibold text-fg">Snippets</h2>
      <span class="text-[11px] text-fg-subtle tabular-nums">{{ snippets.length }}</span>
      <div class="flex-1" />
      <button
        :class="cn('btn-subtle', mode === 'save' && '!bg-accent/15 !border-accent/40 !text-accent')"
        :disabled="!selectedTab"
        :title="selectedTab ? `Save the active tab's code as a snippet` : 'No active tab'"
        @click="toggleMode"
      >
        <Check :size="11" />
        Save current buffer
      </button>
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <div v-if="mode === 'save'" class="px-4 py-3 border-b border-line bg-surface-2 flex items-center gap-2">
      <input
        ref="saveInput"
        v-model="saveName"
        class="field flex-1"
        placeholder="Snippet name — e.g. 'Seed test user'"
        @keydown.enter.prevent="saveCurrent(saveName)"
      />
      <button
        class="btn-primary disabled:opacity-40"
        :disabled="!saveName.trim() || !selectedTab"
        @click="saveCurrent(saveName)"
      >
        Save
      </button>
    </div>

    <div class="flex-1 overflow-y-auto">
      <div v-if="snippets.length === 0" class="h-full flex flex-col items-center justify-center text-center px-8">
        <div
          class="h-12 w-12 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30 flex items-center justify-center mb-3"
        >
          <FileCode :size="20" class="text-accent" />
        </div>
        <div class="text-[13px] text-fg font-medium mb-1">No snippets yet</div>
        <div class="text-[11px] text-fg-muted max-w-[340px]">
          Save reusable code like your favourite seed data or a factory setup. Hit
          <span class="kbd">⌘⇧S</span> anywhere in the app to save the current buffer.
        </div>
      </div>
      <ul v-else class="divide-y divide-line">
        <li v-for="s in snippets" :key="s.id" class="group px-4 py-2.5 hover:bg-surface-2 flex items-start gap-3">
          <FileCode :size="14" class="text-fg-muted mt-0.5 shrink-0" />
          <div class="flex-1 min-w-0">
            <input
              v-if="editingId === s.id"
              v-model="editingName"
              class="field w-full"
              autofocus
              @keydown.enter.prevent="rename(s.id, editingName)"
              @keydown.escape.prevent="editingId = null"
              @blur="rename(s.id, editingName)"
            />
            <button
              v-else
              class="text-[13px] text-fg font-medium truncate text-left w-full cursor-default"
              title="Click to insert into current tab"
              @click="insert(s)"
            >
              {{ s.name }}
            </button>
            <div class="text-[11px] text-fg-muted font-mono truncate">
              {{ s.code.trim().replace(/\n/g, " ").slice(0, 120) || "(empty)" }}
            </div>
          </div>
          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button class="icon-btn" title="Rename" @click="startEdit(s)"><Pencil :size="11" /></button>
            <button class="icon-btn hover:text-danger" title="Delete" @click="del(s.id)">
              <Trash2 :size="11" />
            </button>
          </div>
        </li>
      </ul>
    </div>
  </Modal>
</template>
