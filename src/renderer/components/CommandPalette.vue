<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  Play,
  Plus,
  X,
  Trash2,
  Settings,
  Network,
  FileCode,
  FolderOpen,
  Paintbrush,
  Terminal,
  Bookmark,
  Keyboard,
  Save,
  RefreshCw,
} from "lucide-vue-next";
import { useAppStore } from "../stores/app";
import { themes } from "../lib/themes";
import { resetIntelephense } from "../lib/lspManager";
import { displayKeys } from "../lib/shortcuts";
import { insertSnippetIntoActiveEditor } from "../composables/useEditorRegistry";

/**
 * Snippets and starters are stored verbatim with their `<?php` opener;
 * the runner needs it but inserting it again at an arbitrary caret
 * position would produce nested PHP tags. Strip exactly one leading
 * opener (with surrounding whitespace) before insertion.
 */
function stripPhpOpener(code: string): string {
  return code.replace(/^\s*<\?php[ \t]*\n?/, "");
}
import Modal from "./Modal.vue";
import LaravelIcon from "./icons/LaravelIcon.vue";
import PhpIcon from "./icons/PhpIcon.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  close: [];
  run: [];
  cancel: [];
  openSettings: [];
  newTab: [];
  openArtisan: [];
  openCheatsheet: [];
  openSnippets: [mode: "manage" | "save"];
}>();

const store = useAppStore();
const { tabs, selectedTabId, projects, snippets, settings } = storeToRefs(store);

const query = ref("");
const activeIndex = ref(0);
const inputEl = useTemplateRef<HTMLInputElement>("inputEl");
const listEl = useTemplateRef<HTMLDivElement>("listEl");

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  shortcut?: string;
  iconComponent?:
    | "Play"
    | "X"
    | "Plus"
    | "Trash2"
    | "Settings"
    | "Keyboard"
    | "FolderOpen"
    | "Terminal"
    | "Save"
    | "Bookmark"
    | "RefreshCw"
    | "Paintbrush"
    | "FileCode"
    | "LaravelIcon"
    | "Network"
    | "PhpIcon";
  onSelect: () => void;
}

function exec(fn: () => void): void {
  emit("close");
  fn();
}

async function pickLaravel(): Promise<void> {
  const p = await window.lsp.projectsPickLaravel();
  if (p) {
    store.setProjects(await window.lsp.projectsList());
    store.selectProject(p.id);
  }
}

function switchTheme(id: string): void {
  if (!settings.value) return;
  void window.lsp.settingsSet({ editor: { ...settings.value.editor, theme: id } }).then(store.setSettings);
}

const starters = [
  {
    title: "Collection: map + sum",
    preview: "collect([1,2,3])->map(...)",
    code: "collect([1, 2, 3, 4, 5])->map(fn ($n) => $n * 2)->sum();\n",
  },
  { title: "Users: count + latest", preview: "User::count(); User::latest()…", code: "App\\Models\\User::count();\n" },
  {
    title: "Carbon: now + diff",
    preview: "now()->addDays(7)->diffForHumans()",
    code: "now()->addDays(7)->diffForHumans();\n",
  },
  { title: "DB: raw query", preview: "DB::select('select 1')", code: "DB::select('select sqlite_version() as v');\n" },
  { title: "Cache: remember", preview: "Cache::remember(...)", code: "Cache::remember('k', 60, fn () => 'hi');\n" },
  { title: "Str: random", preview: "Str::random(16)", code: "Str::random(16);\n" },
];

const items = computed<PaletteItem[]>(() => {
  const out: PaletteItem[] = [];

  out.push(
    {
      id: "act:run",
      group: "Actions",
      iconComponent: "Play",
      label: "Run current tab",
      shortcut: "⌘R",
      onSelect: () => exec(() => emit("run")),
    },
    {
      id: "act:cancel",
      group: "Actions",
      iconComponent: "X",
      label: "Cancel running code",
      shortcut: "⌘.",
      onSelect: () => exec(() => emit("cancel")),
    },
    {
      id: "act:new",
      group: "Actions",
      iconComponent: "Plus",
      label: "New tab",
      shortcut: "⌘T",
      onSelect: () => exec(() => emit("newTab")),
    },
    {
      id: "act:close",
      group: "Actions",
      iconComponent: "Trash2",
      label: "Close current tab",
      shortcut: "⌘W",
      onSelect: () =>
        exec(() => {
          if (selectedTabId.value) store.closeTab(selectedTabId.value);
        }),
    },
    {
      id: "act:settings",
      group: "Actions",
      iconComponent: "Settings",
      label: "Open settings",
      shortcut: "⌘,",
      onSelect: () => exec(() => emit("openSettings")),
    },
    {
      id: "act:cheatsheet",
      group: "Actions",
      iconComponent: "Keyboard",
      label: "Keyboard shortcuts",
      shortcut: "⌘?",
      onSelect: () => exec(() => emit("openCheatsheet")),
    },
    {
      id: "act:pickLaravel",
      group: "Actions",
      iconComponent: "FolderOpen",
      label: "Open Laravel project…",
      onSelect: () => exec(() => void pickLaravel()),
    },
    {
      id: "act:addSsh",
      group: "Actions",
      iconComponent: "Network",
      label: "Add SSH project…",
      onSelect: () => exec(() => store.openDialog("addSsh")),
    },
  );

  out.push(
    {
      id: "tool:artisan",
      group: "Tools",
      iconComponent: "Terminal",
      label: "Run Artisan command…",
      shortcut: "⌘⇧A",
      onSelect: () => exec(() => emit("openArtisan")),
    },
    {
      id: "tool:save-snip",
      group: "Tools",
      iconComponent: "Save",
      label: "Save current buffer as snippet",
      shortcut: "⌘⇧S",
      onSelect: () => exec(() => emit("openSnippets", "save")),
    },
    {
      id: "tool:manage-snip",
      group: "Tools",
      iconComponent: "Bookmark",
      label: "Manage snippets…",
      onSelect: () => exec(() => emit("openSnippets", "manage")),
    },
    {
      id: "tool:lsp-reset",
      group: "Tools",
      iconComponent: "RefreshCw",
      label: "Rebuild workspace index",
      hint: "nukes Intelephense cache",
      onSelect: () =>
        exec(() => {
          void resetIntelephense();
        }),
    },
  );

  for (const t of themes) {
    out.push({
      id: `theme:${t.id}`,
      group: "Themes",
      iconComponent: "Paintbrush",
      label: `Theme: ${t.label}`,
      hint: settings.value?.editor.theme === t.id ? "active" : undefined,
      onSelect: () => exec(() => switchTheme(t.id)),
    });
  }

  if (snippets.value.length > 0) {
    for (const s of snippets.value.slice(0, 50)) {
      const preview = s.code.trim().replace(/\n/g, " ").slice(0, 80);
      out.push({
        id: `snip:${s.id}`,
        group: "Your snippets",
        iconComponent: "Bookmark",
        label: s.name,
        hint: preview,
        onSelect: () => exec(() => insertSnippetIntoActiveEditor(stripPhpOpener(s.code))),
      });
    }
  }

  for (const s of starters) {
    out.push({
      id: `start:${s.title}`,
      group: "Starter snippets",
      iconComponent: "FileCode",
      label: s.title,
      hint: s.preview,
      onSelect: () => exec(() => insertSnippetIntoActiveEditor(stripPhpOpener(s.code))),
    });
  }

  if (projects.value.length > 0) {
    for (const p of projects.value) {
      const tab = tabs.value.find((t) => t.id === selectedTabId.value);
      const current = tab && tab.projectId === p.id;
      const iconComponent: PaletteItem["iconComponent"] = p.kind === "ssh" ? "Network" : "LaravelIcon";
      const hint = current
        ? "active"
        : p.kind === "ssh" && p.ssh
          ? `${p.ssh.user ? p.ssh.user + "@" : ""}${p.ssh.host}`
          : "local";
      out.push({
        id: `proj:${p.id}`,
        group: "Switch project",
        iconComponent,
        label: p.name,
        hint,
        onSelect: () =>
          exec(() => {
            if (selectedTabId.value) store.setTabProject(selectedTabId.value, p.id);
          }),
      });
    }
  }

  return out;
});

const filteredItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value;
  const tokens = q.split(/\s+/);
  return items.value.filter((item) => {
    const hay = `${item.label} ${item.hint ?? ""} ${item.shortcut ?? ""}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
});

const groupedItems = computed(() => {
  const map = new Map<string, PaletteItem[]>();
  for (const item of filteredItems.value) {
    const bucket = map.get(item.group) ?? [];
    bucket.push(item);
    map.set(item.group, bucket);
  }
  return Array.from(map.entries()).map(([group, list]) => ({ group, list }));
});

watch(filteredItems, () => {
  activeIndex.value = 0;
});

// Reset state + focus input when opened. Reka's Dialog also auto-focuses
// the first focusable element in the content, but we defer here to handle
// the "reopen with stale query" case cleanly.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    query.value = "";
    activeIndex.value = 0;
    void nextTick(() => setTimeout(() => inputEl.value?.focus(), 10));
  },
);

function scrollActiveIntoView(): void {
  const el = listEl.value?.querySelector<HTMLElement>(`[data-idx="${activeIndex.value}"]`);
  el?.scrollIntoView({ block: "nearest" });
}

function onInputKey(e: KeyboardEvent): void {
  const max = filteredItems.value.length - 1;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex.value = activeIndex.value >= max ? 0 : activeIndex.value + 1;
    void nextTick(scrollActiveIntoView);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex.value = activeIndex.value <= 0 ? max : activeIndex.value - 1;
    void nextTick(scrollActiveIntoView);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const item = filteredItems.value[activeIndex.value];
    item?.onSelect();
  }
}

function indexOf(item: PaletteItem): number {
  return filteredItems.value.findIndex((i) => i.id === item.id);
}
</script>

<template>
  <Modal
    :open="open"
    title="Command palette"
    align="top"
    content-class="w-[620px] max-w-[90vw] rounded-xl overflow-hidden bg-gradient-to-b from-surface to-bg border border-line shadow-2xl shadow-black/60"
    @close="emit('close')"
  >
    <div class="flex items-center gap-2 px-3 py-3 border-b border-line">
      <input
        ref="inputEl"
        v-model="query"
        placeholder="Type a command, snippet, history entry, or theme…"
        class="flex-1 bg-transparent text-[14px] text-fg placeholder:text-fg-muted outline-none"
        @keydown="onInputKey"
      />
      <kbd class="kbd">ESC</kbd>
    </div>

    <div ref="listEl" class="max-h-[60vh] overflow-y-auto p-1">
      <div v-if="filteredItems.length === 0" class="px-4 py-6 text-center text-[12px] text-fg-muted">
        Nothing matched "<span class="text-fg">{{ query }}</span
        >"
      </div>

      <template v-for="{ group, list } in groupedItems" :key="group">
        <div class="px-3.5 pt-[14px] pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          {{ group }}
        </div>
        <div
          v-for="item in list"
          :key="item.id"
          :data-idx="indexOf(item)"
          :aria-selected="indexOf(item) === activeIndex"
          class="flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] text-fg cursor-default transition-colors"
          :class="indexOf(item) === activeIndex ? 'bg-accent/15' : ''"
          @mouseenter="activeIndex = indexOf(item)"
          @click="item.onSelect()"
        >
          <span class="shrink-0" :class="indexOf(item) === activeIndex ? 'text-accent' : 'text-fg-muted'">
            <Play v-if="item.iconComponent === 'Play'" :size="13" />
            <X v-else-if="item.iconComponent === 'X'" :size="13" />
            <Plus v-else-if="item.iconComponent === 'Plus'" :size="13" />
            <Trash2 v-else-if="item.iconComponent === 'Trash2'" :size="13" />
            <Settings v-else-if="item.iconComponent === 'Settings'" :size="13" />
            <Keyboard v-else-if="item.iconComponent === 'Keyboard'" :size="13" />
            <FolderOpen v-else-if="item.iconComponent === 'FolderOpen'" :size="13" />
            <Terminal v-else-if="item.iconComponent === 'Terminal'" :size="13" />
            <Save v-else-if="item.iconComponent === 'Save'" :size="13" />
            <Bookmark v-else-if="item.iconComponent === 'Bookmark'" :size="13" />
            <RefreshCw v-else-if="item.iconComponent === 'RefreshCw'" :size="13" />
            <Paintbrush v-else-if="item.iconComponent === 'Paintbrush'" :size="13" />
            <FileCode v-else-if="item.iconComponent === 'FileCode'" :size="13" />
            <LaravelIcon v-else-if="item.iconComponent === 'LaravelIcon'" :size="13" class="text-brand-laravel" />
            <Network v-else-if="item.iconComponent === 'Network'" :size="13" />
            <PhpIcon v-else-if="item.iconComponent === 'PhpIcon'" :size="13" class="text-brand-php" />
          </span>
          <span class="flex-1 truncate">{{ item.label }}</span>
          <span v-if="item.hint" class="text-[11px] text-fg-muted truncate max-w-[200px]">{{ item.hint }}</span>
          <span v-if="item.shortcut" class="kbd">{{ displayKeys(item.shortcut) }}</span>
        </div>
      </template>
    </div>

    <div class="flex items-center gap-2 px-3 py-2 border-t border-line text-[10px] text-fg-muted">
      <PhpIcon :size="10" class="text-brand-php" />
      <span>Tip: type to filter. Use arrows to navigate. Enter to select.</span>
    </div>
  </Modal>
</template>
