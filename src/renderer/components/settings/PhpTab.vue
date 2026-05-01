<script setup lang="ts">
import { computed, ref } from "vue";
import { cn } from "../../lib/cn";
import type { DeepPartial, PhpVersionInfo, Settings } from "../../../shared/ipc";

const props = defineProps<{
  settings: Settings;
  phpVersions: PhpVersionInfo[];
  rescanning: boolean;
}>();

const emit = defineEmits<{
  rescan: [];
  change: [patch: DeepPartial<Settings>];
  addCustom: [path: string];
  removeCustom: [path: string];
  pickCustom: [];
}>();

const customPath = ref("");

const enabledSet = computed(() => new Set(props.settings.php.enabledPaths));

function isEnabled(path: string): boolean {
  return enabledSet.value.has(path);
}

// Block unticking the last enabled binary — the toolbar picker has no
// "Automatic" fallback anymore, so an empty list would leave nothing
// runnable. Boot-time auto-population in main.ts seeds the initial set;
// after that this guard keeps it non-empty.
function isLastEnabled(path: string): boolean {
  return props.settings.php.enabledPaths.length === 1 && enabledSet.value.has(path);
}

function toggle(path: string, checked: boolean): void {
  if (!checked && isLastEnabled(path)) return;

  const next = checked
    ? [...new Set([...props.settings.php.enabledPaths, path])]
    : props.settings.php.enabledPaths.filter((p) => p !== path);

  // If the user just unchecked their currently-selected default, clear
  // it so the toolbar dropdown's active-row indicator doesn't keep
  // pointing at a now-hidden binary. Send both fields in one patch so
  // they apply atomically.
  const patch: DeepPartial<Settings> = { php: { enabledPaths: next } };
  if (!checked && props.settings.php.defaultBinary === path) {
    patch.php = { ...patch.php, defaultBinary: null };
  }
  emit("change", patch);
}

function addCustom(): void {
  if (customPath.value) {
    emit("addCustom", customPath.value);
    customPath.value = "";
    emit("rescan");
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-fg">Discovered PHP versions</h3>
      <button
        class="px-2 py-0.5 text-xs rounded bg-surface-2 hover:bg-surface-3 disabled:opacity-50"
        :disabled="rescanning"
        @click="emit('rescan')"
      >
        {{ rescanning ? "Scanning…" : "Rescan" }}
      </button>
    </div>

    <p class="text-[12px] text-fg-muted -mt-2">Tick the versions you want available in the toolbar's PHP picker.</p>

    <div class="border border-line rounded-lg divide-y divide-line overflow-hidden">
      <div v-if="phpVersions.length === 0" class="p-3 text-fg-muted text-xs">
        No PHP CLI binaries found. Install via <code>brew install php</code> or Laravel Herd.
      </div>
      <label
        v-for="v in phpVersions"
        :key="v.path"
        :class="
          cn(
            'w-full px-3 py-2 text-xs flex items-center gap-3 outline-none transition-colors',
            isEnabled(v.path) ? 'bg-accent/5' : 'hover:bg-surface-2',
            isLastEnabled(v.path) ? 'cursor-not-allowed' : 'cursor-pointer',
          )
        "
        :title="isLastEnabled(v.path) ? 'At least one PHP version must stay enabled' : ''"
      >
        <input
          type="checkbox"
          class="accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed"
          :checked="isEnabled(v.path)"
          :disabled="isLastEnabled(v.path)"
          @change="toggle(v.path, ($event.target as HTMLInputElement).checked)"
        />
        <div class="flex-1 min-w-0">
          <div class="text-fg font-medium">PHP {{ v.version }}</div>
          <div class="text-fg-muted font-mono text-[11px] truncate">{{ v.path }}</div>
        </div>
      </label>
    </div>

    <div>
      <h3 class="font-medium text-fg mb-2">Custom PHP paths</h3>
      <div class="flex gap-2 mb-2">
        <input v-model="customPath" class="field flex-1 font-mono" placeholder="/opt/php84/bin/php" />
        <button
          class="btn-subtle disabled:opacity-40 disabled:pointer-events-none"
          :disabled="!customPath"
          @click="addCustom"
        >
          Add
        </button>
        <button class="btn-subtle" @click="emit('pickCustom')">Browse…</button>
      </div>
      <div v-if="settings.php.customPaths.length > 0" class="space-y-1">
        <div v-for="p in settings.php.customPaths" :key="p" class="flex items-center gap-2 text-xs">
          <span class="font-mono text-fg-muted flex-1 truncate">{{ p }}</span>
          <button
            class="text-red-400 hover:text-red-300"
            @click="
              emit('removeCustom', p);
              emit('rescan');
            "
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
