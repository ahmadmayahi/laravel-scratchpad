<script setup lang="ts">
import type { Settings } from "../../../shared/ipc";
import { themes } from "../../lib/themes";
import SectionHeader from "./SectionHeader.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ change: [patch: Partial<Settings>] }>();

function patchEditor(partial: Partial<Settings["editor"]>): void {
  emit("change", { editor: { ...props.settings.editor, ...partial } });
}
</script>

<template>
  <div class="space-y-6">
    <SectionHeader title="Appearance" subtitle="Syntax highlighting and fonts" />
    <SettingsRow label="Color theme">
      <select
        class="select w-64"
        :value="settings.editor.theme"
        @change="patchEditor({ theme: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="t in themes" :key="t.id" :value="t.id">{{ t.label }}</option>
      </select>
    </SettingsRow>
    <SettingsRow label="Font size">
      <div class="flex items-center gap-3 w-64">
        <input
          type="range"
          :min="10"
          :max="22"
          :step="1"
          :value="settings.editor.fontSize"
          class="flex-1 accent-[var(--accent)]"
          @input="patchEditor({ fontSize: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="text-fg-muted text-[11px] tabular-nums w-8">{{ settings.editor.fontSize }}pt</span>
      </div>
    </SettingsRow>

    <SectionHeader title="Formatting" subtitle="Indentation and line behaviour" />
    <SettingsRow label="Tab size">
      <select
        class="select w-24"
        :value="settings.editor.tabSize"
        @change="patchEditor({ tabSize: Number(($event.target as HTMLSelectElement).value) })"
      >
        <option :value="2">2</option>
        <option :value="4">4</option>
        <option :value="8">8</option>
      </select>
    </SettingsRow>
    <SettingsToggle
      label="Line numbers"
      :model-value="settings.editor.lineNumbers"
      @update:model-value="(v) => patchEditor({ lineNumbers: v })"
    />
    <SettingsToggle
      label="Word wrap"
      :model-value="settings.editor.wordWrap"
      @update:model-value="(v) => patchEditor({ wordWrap: v })"
    />
  </div>
</template>
