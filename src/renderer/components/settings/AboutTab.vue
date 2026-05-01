<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ExternalLink } from "lucide-vue-next";
import GithubIcon from "../icons/GithubIcon.vue";
import SettingsRow from "./SettingsRow.vue";
import appIconUrl from "../../../../build/icon.png";

/**
 * About page — app metadata, author credit, license, and a link out to the
 * project's GitHub repo. Pulls live values from the main process via
 * `window.lsp.appInfo()` so the version stays in sync with `package.json`
 * without a rebuild needed here.
 */

interface AppInfo {
  name: string;
  version: string;
  author: string;
  license: string;
  homepage: string;
}

const info = ref<AppInfo | null>(null);

onMounted(async () => {
  info.value = await window.lsp.appInfo();
});

// Exposed to the template because bare `window` isn't part of Vue's
// template-context default globals. Wrapping the IPC call in a local
function openExternal(url: string): void {
  void window.lsp.openExternal(url);
}
</script>

<template>
  <div v-if="!info" class="text-fg-muted text-[12px]">Loading…</div>
  <div v-else class="space-y-6">
    <div class="flex items-start gap-4">
      <img
        :src="appIconUrl"
        :alt="`${info.name} icon`"
        class="h-14 w-14 rounded-2xl shrink-0 object-contain shadow-[0_4px_16px_-4px_rgba(0,0,0,0.4)]"
      />
      <div class="flex-1 min-w-0">
        <h2 class="text-[18px] font-semibold text-fg leading-tight">{{ info.name }}</h2>
        <div class="text-[12px] text-fg-muted mt-0.5">
          Version <span class="font-mono tabular-nums">{{ info.version }}</span>
        </div>
        <p class="text-[12px] text-fg-muted mt-2 max-w-md">
          A PHP / Laravel REPL scratchpad built with Electron, Vue, and Monaco.
        </p>
      </div>
    </div>

    <div class="space-y-2">
      <button
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-2 hover:bg-surface-3 border border-line transition-colors cursor-default text-left"
        :title="info.homepage"
        @click="openExternal(info.homepage)"
      >
        <GithubIcon :size="14" class="text-fg-muted shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="text-[12px] text-fg">GitHub repository</div>
          <div class="text-[11px] text-fg-muted font-mono truncate">{{ info.homepage }}</div>
        </div>
        <ExternalLink :size="11" class="text-fg-subtle shrink-0" />
      </button>
    </div>

    <div class="border-t border-line pt-4 space-y-2 text-[12px]">
      <SettingsRow label="Author"
        ><span class="text-fg">{{ info.author }}</span></SettingsRow
      >
      <SettingsRow label="License"
        ><span class="text-fg">{{ info.license }}</span></SettingsRow
      >
    </div>

    <div class="pt-2 text-[11px] text-fg-subtle border-t border-line">
      Built with
      <button
        type="button"
        class="underline hover:text-fg cursor-default"
        @click="openExternal('https://www.electronjs.org')"
      >
        Electron</button
      >,
      <button type="button" class="underline hover:text-fg cursor-default" @click="openExternal('https://vuejs.org')">
        Vue</button
      >,
      <button
        type="button"
        class="underline hover:text-fg cursor-default"
        @click="openExternal('https://microsoft.github.io/monaco-editor/')"
      >
        Monaco</button
      >,
      <button
        type="button"
        class="underline hover:text-fg cursor-default"
        @click="openExternal('https://intelephense.com')"
      >
        Intelephense</button
      >,
      <button
        type="button"
        class="underline hover:text-fg cursor-default"
        @click="openExternal('https://github.com/laravel-ls/laravel-ls')"
      >
        laravel-ls</button
      >, and
      <button type="button" class="underline hover:text-fg cursor-default" @click="openExternal('https://ollama.com')">
        Ollama</button
      >.
    </div>
  </div>
</template>
