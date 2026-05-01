<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertTriangle, FolderSearch, RefreshCcw, Settings as SettingsIcon } from "lucide-vue-next";

/**
 * Replaces the editor pane when no PHP binary is reachable on the
 * host. Three actions: pick a PHP binary path manually, open the PHP
 * settings tab to inspect the discovery list, or rescan after a fresh
 * `apt install php-cli` / `brew install php` / Herd install.
 *
 * The rest of the app (toolbar, sidebar, settings dialog) stays
 * interactive — the user can fix the situation in-app.
 */

const emit = defineEmits<{
  openSettings: [];
}>();

const platform = window.platform;
const rescanning = ref(false);
const adding = ref(false);

const platformHint = computed(() => {
  if (platform === "darwin") {
    return "Install via Homebrew (brew install php), Laravel Herd, or asdf.";
  }
  if (platform === "win32") {
    return "Install via Laravel Herd, Scoop (scoop install php), XAMPP, or Laragon.";
  }
  return "Install via your package manager (apt install php-cli, dnf install php-cli) or Herd Lite.";
});

async function onAddCustomPath(): Promise<void> {
  if (adding.value) return;
  adding.value = true;
  try {
    const picked = await window.lsp.settingsPickPhpBinary();
    if (!picked) return;
    await window.lsp.settingsAddCustomPhp(picked);
  } finally {
    adding.value = false;
  }
}

async function onRescan(): Promise<void> {
  if (rescanning.value) return;
  rescanning.value = true;
  try {
    await window.lsp.phpRescan();
  } finally {
    rescanning.value = false;
  }
}
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-8">
    <div class="max-w-md w-full flex flex-col items-center gap-5 text-center">
      <div class="h-12 w-12 rounded-full bg-danger/10 text-danger flex items-center justify-center">
        <AlertTriangle :size="22" />
      </div>

      <div class="space-y-2">
        <h2 class="text-base font-semibold text-fg">No PHP found on this system</h2>
        <p class="text-[13px] text-fg-muted leading-relaxed">
          The editor is disabled until a PHP binary is reachable. {{ platformHint }}
        </p>
      </div>

      <div class="flex flex-wrap items-center justify-center gap-2 pt-1">
        <button class="btn-primary" :disabled="adding" @click="onAddCustomPath">
          <FolderSearch :size="12" />
          Add custom PHP path…
        </button>
        <button class="btn-subtle" @click="emit('openSettings')">
          <SettingsIcon :size="12" />
          Open Settings
        </button>
        <button class="btn-subtle" :disabled="rescanning" @click="onRescan">
          <RefreshCcw :size="12" :class="rescanning ? 'animate-spin' : ''" />
          {{ rescanning ? "Rescanning…" : "Rescan" }}
        </button>
      </div>

      <p class="text-[11px] text-fg-subtle leading-relaxed pt-2">
        Once a PHP binary is found, the editor will reload automatically — no app restart needed.
      </p>
    </div>
  </div>
</template>
