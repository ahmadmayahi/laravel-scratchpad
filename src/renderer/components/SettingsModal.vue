<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "reka-ui";
import { Link2, Code2, SlidersHorizontal, Sparkles, Info, Database } from "lucide-vue-next";
import type { DeepPartial, PhpVersionInfo, Settings } from "../../shared/ipc";
import { cn } from "../lib/cn";
import LaravelIcon from "./icons/LaravelIcon.vue";
import PhpIcon from "./icons/PhpIcon.vue";
import Modal from "./Modal.vue";
import EditorTab from "./settings/EditorTab.vue";
import PhpTab from "./settings/PhpTab.vue";
import LaravelTab from "./settings/LaravelTab.vue";
import DatabaseTab from "./settings/DatabaseTab.vue";
import AiTab from "./settings/AiTab.vue";
import ProjectsTab from "./settings/ProjectsTab.vue";
import GeneralTab from "./settings/GeneralTab.vue";
import AboutTab from "./settings/AboutTab.vue";

/**
 * Tabbed settings modal. Opens on ⌘, or gear icon. Reads + writes through
 * `window.lsp.settingsGet/Set`; live-updates the editor without a relaunch.
 *
 * Structure uses Reka's `Tabs` primitive in vertical orientation for the
 * left nav — which gives us keyboard navigation (↑/↓/Home/End) and proper
 * aria roles for free.
 */

type TabKey = "editor" | "php" | "laravel" | "database" | "ai" | "projects" | "general" | "about";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const activeTab = ref<TabKey>("editor");
const settings = ref<Settings | null>(null);
const phpVersions = ref<PhpVersionInfo[]>([]);
const rescanning = ref(false);

async function loadSettings(): Promise<void> {
  // Swallow-but-log IPC failures so a single bad call (e.g. a
  // `settings:set` handler that once errored and corrupted the file)
  // doesn't leave the modal permanently unopenable. Keeping `settings`
  // null gates the template on the stored shape, but falling back to
  // `null` is still fine — the modal just doesn't render content.
  try {
    settings.value = await window.lsp.settingsGet();
    phpVersions.value = await window.lsp.phpVersions();
  } catch (err) {
    console.error("[settings] load failed:", err);
  }
}

// Pre-load on mount so the first click on the Settings icon renders
// instantly — and so a transient IPC failure in the open-triggered reload
// doesn't leave the modal permanently blank (previously the `v-if` on
// `settings` never flipped back true after an error).
onMounted(() => {
  void loadSettings();
});

// Refresh on each open so the modal reflects any changes made via other
// paths (CLI, direct file edit) since the last view.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void loadSettings();
  },
);

async function patch(update: DeepPartial<Settings>): Promise<void> {
  settings.value = await window.lsp.settingsSet(update);
}

async function rescanPhp(): Promise<void> {
  rescanning.value = true;
  phpVersions.value = await window.lsp.phpVersions();
  rescanning.value = false;
}

async function addCustomPhp(p: string): Promise<void> {
  settings.value = await window.lsp.settingsAddCustomPhp(p);
}

async function removeCustomPhp(p: string): Promise<void> {
  settings.value = await window.lsp.settingsRemoveCustomPhp(p);
}

async function pickCustomPhp(): Promise<void> {
  const picked = await window.lsp.settingsPickPhpBinary();
  if (picked) settings.value = await window.lsp.settingsAddCustomPhp(picked);
  await rescanPhp();
}

const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: "editor", label: "Editor", icon: "code" },
  { key: "php", label: "PHP", icon: "php" },
  { key: "laravel", label: "Laravel", icon: "laravel" },
  { key: "database", label: "Database", icon: "database" },
  { key: "ai", label: "AI", icon: "sparkles" },
  { key: "projects", label: "Projects", icon: "link" },
  { key: "general", label: "General", icon: "sliders" },
  { key: "about", label: "About", icon: "info" },
];

// `TabsRoot` binds via `v-model` but the typings prefer a plain string; we
// proxy through this computed so TS is happy with the narrow TabKey union.
function onTabChange(value: string | number): void {
  activeTab.value = value as TabKey;
}
</script>

<template>
  <Modal
    v-if="settings"
    :open="open"
    title="Settings"
    content-class="dialog-shell w-[820px] h-[620px] max-h-[90vh]"
    @close="emit('close')"
  >
    <header class="flex items-center justify-between px-5 py-3 border-b border-line">
      <h2 class="text-[14px] font-semibold text-fg">Settings</h2>
      <button class="icon-btn" title="Close (Esc)" aria-label="Close" @click="emit('close')">✕</button>
    </header>

    <TabsRoot
      :model-value="activeTab"
      orientation="vertical"
      class="flex min-h-0 flex-1"
      @update:model-value="onTabChange"
    >
      <TabsList
        aria-label="Settings sections"
        class="w-44 shrink-0 p-2 border-r border-line bg-bg text-sm flex flex-col gap-0.5"
      >
        <TabsTrigger
          v-for="t in tabs"
          :key="t.key"
          :value="t.key"
          :class="
            cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-md text-[13px] transition-colors cursor-default outline-none',
              'focus-visible:ring-2 focus-visible:ring-accent/40',
              'data-[state=active]:bg-surface-3 data-[state=active]:text-fg',
              'data-[state=inactive]:text-fg-muted data-[state=inactive]:hover:bg-surface-2 data-[state=inactive]:hover:text-fg',
            )
          "
        >
          <span :class="activeTab === t.key ? 'text-accent' : 'text-fg-subtle'">
            <Code2 v-if="t.icon === 'code'" :size="13" />
            <PhpIcon v-else-if="t.icon === 'php'" :size="13" class="text-brand-php" />
            <LaravelIcon v-else-if="t.icon === 'laravel'" :size="13" class="text-brand-laravel" />
            <Database v-else-if="t.icon === 'database'" :size="13" />
            <Sparkles v-else-if="t.icon === 'sparkles'" :size="13" />
            <Link2 v-else-if="t.icon === 'link'" :size="13" />
            <SlidersHorizontal v-else-if="t.icon === 'sliders'" :size="13" />
            <Info v-else-if="t.icon === 'info'" :size="13" />
          </span>
          {{ t.label }}
        </TabsTrigger>
      </TabsList>

      <div class="flex-1 overflow-y-auto p-6 text-[13px]">
        <TabsContent value="editor" class="outline-none">
          <EditorTab :settings="settings" @change="patch" />
        </TabsContent>
        <TabsContent value="php" class="outline-none">
          <PhpTab
            :settings="settings"
            :php-versions="phpVersions"
            :rescanning="rescanning"
            @rescan="rescanPhp"
            @change="patch"
            @add-custom="addCustomPhp"
            @remove-custom="removeCustomPhp"
            @pick-custom="pickCustomPhp"
          />
        </TabsContent>
        <TabsContent value="laravel" class="outline-none"><LaravelTab /></TabsContent>
        <TabsContent value="database" class="outline-none">
          <DatabaseTab />
        </TabsContent>
        <TabsContent value="ai" class="outline-none">
          <AiTab :settings="settings" @change="patch" />
        </TabsContent>
        <TabsContent value="projects" class="outline-none"><ProjectsTab /></TabsContent>
        <TabsContent value="general" class="outline-none">
          <GeneralTab :settings="settings" @change="patch" />
        </TabsContent>
        <TabsContent value="about" class="outline-none"><AboutTab /></TabsContent>
      </div>
    </TabsRoot>
  </Modal>
</template>
