<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Sun, Moon, Monitor, Trash2, Loader2 } from "lucide-vue-next";
import { cn } from "../../lib/cn";
import type { Settings } from "../../../shared/ipc";
import { useToastStore } from "../../stores/toasts";
import SectionHeader from "./SectionHeader.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ change: [patch: Partial<Settings>] }>();

const toasts = useToastStore();
const clearing = ref(false);

/**
 * Nukes the Intelephense workspace index + global cache, then hard-
 * relaunches the app. In-memory LSP state doesn't survive the cache
 * wipe cleanly (Intelephense never re-reads storage after init), so a
 * process bounce is the only way the next boot sees a truly cold
 * index. Relaunch skips the usual confirm — clearing the cache is
 * deliberate, and waiting on a second click would leave the app in a
 * half-stale state.
 */
async function clearCache(): Promise<void> {
  if (clearing.value) return;
  clearing.value = true;
  try {
    await window.lsp.lspClearCache();
    // Fire and forget — `appRelaunch` terminates this process ~50 ms
    // after the IPC resolves, so nothing past this point runs.
    await window.lsp.appRelaunch();
  } catch (err) {
    toasts.push({
      variant: "error",
      title: "Couldn't clear cache",
      description: String((err as Error).message ?? err),
      duration: null,
    });
    clearing.value = false;
  }
}

// Resolved per-OS in main via app.getPath('userData') — fetched once on
// mount so the displayed location matches whichever directory the
// store classes actually wrote to (macOS Application Support, Windows
// AppData, Linux ~/.config).
const settingsFile = ref<string>("");
onMounted(async () => {
  const dir = await window.lsp.appDataDir();
  const sep = dir.includes("\\") ? "\\" : "/";
  settingsFile.value = `${dir}${sep}settings.json`;
});

const modes: Array<{
  value: Settings["ui"]["mode"];
  label: string;
  icon: "sun" | "moon" | "monitor";
}> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

function setMode(v: Settings["ui"]["mode"]): void {
  emit("change", { ui: { mode: v } });
}

function setRestore(v: boolean): void {
  emit("change", { general: { ...props.settings.general, restoreTabsOnLaunch: v } });
}
</script>

<template>
  <div class="space-y-6">
    <SectionHeader title="Appearance" subtitle="Interface colour mode" />
    <SettingsRow label="App theme">
      <div class="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
        <button
          v-for="m in modes"
          :key="m.value"
          :class="
            cn(
              'inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-[12px] transition-colors cursor-default',
              settings.ui.mode === m.value
                ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.15)]'
                : 'text-fg-muted hover:text-fg',
            )
          "
          @click="setMode(m.value)"
        >
          <Sun v-if="m.icon === 'sun'" :size="13" />
          <Moon v-else-if="m.icon === 'moon'" :size="13" />
          <Monitor v-else :size="13" />
          {{ m.label }}
        </button>
      </div>
    </SettingsRow>

    <SectionHeader title="Startup" />
    <SettingsToggle
      label="Restore tabs on launch"
      :model-value="settings.general.restoreTabsOnLaunch"
      @update:model-value="setRestore"
    />

    <SectionHeader title="Maintenance" />
    <button
      class="inline-flex items-center gap-2 h-7 px-3 rounded-md bg-surface-2 hover:bg-surface-3 border border-line text-[12px] text-fg transition-colors disabled:opacity-50"
      :disabled="clearing"
      @click="clearCache"
    >
      <Loader2 v-if="clearing" :size="13" class="animate-spin" />
      <Trash2 v-else :size="13" />
      {{ clearing ? "Clearing…" : "Clear cache & restart" }}
    </button>

    <div v-if="settingsFile" class="pt-4 text-[11px] text-fg-subtle border-t border-line">
      Settings are stored at
      <code class="font-mono bg-surface-2 px-1 py-0.5 rounded">{{ settingsFile }}</code
      >.
    </div>
  </div>
</template>
