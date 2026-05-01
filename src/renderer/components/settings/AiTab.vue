<script setup lang="ts">
import { computed, ref } from "vue";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-vue-next";
import type { FimTemplate, Settings } from "../../../shared/ipc";
import SectionHeader from "./SectionHeader.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";

/**
 * AI autocomplete settings. Keeps all knobs in one place; the editor reads
 * them live via `settings?.ai` and re-registers its provider on change.
 *
 * Ollama-only by design — talks to a local daemon over HTTP, no cloud,
 * no API keys, no data leaving the machine.
 */

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ change: [patch: Partial<Settings>] }>();

const ai = computed(() => props.settings.ai);

const testStatus = ref<"idle" | "testing" | "ok" | "error">("idle");
const testMessage = ref("");

function patchAi(partial: Partial<Settings["ai"]>): void {
  emit("change", { ai: { ...ai.value, ...partial } });
}

async function test(): Promise<void> {
  testStatus.value = "testing";
  testMessage.value = "";
  const { models, error } = await window.lsp.aiListModels(ai.value.endpoint);
  if (error) {
    testStatus.value = "error";
    testMessage.value = error;
    return;
  }
  const has = models.includes(ai.value.model);
  testStatus.value = has ? "ok" : "error";
  testMessage.value = has
    ? `Model "${ai.value.model}" is available`
    : `Reachable, but "${ai.value.model}" not pulled (${models.slice(0, 3).join(", ") || "no models"}${models.length > 3 ? "…" : ""})`;
}

function openExternal(url: string): void {
  void window.lsp.openExternal(url);
}
</script>

<template>
  <div class="space-y-5">
    <SectionHeader
      title="AI autocomplete (Ollama)"
      subtitle="Optional. Local model only — no cloud, no API keys, no data leaves your machine."
    />
    <SettingsToggle
      label="Enable AI completions"
      hint="Zero traffic leaves the app until this is on"
      :model-value="ai.enabled"
      @update:model-value="(v) => patchAi({ enabled: v })"
    />

    <SettingsRow label="Ollama endpoint">
      <input
        class="field w-80 font-mono"
        :value="ai.endpoint"
        placeholder="http://127.0.0.1:11434"
        @input="patchAi({ endpoint: ($event.target as HTMLInputElement).value })"
      />
    </SettingsRow>

    <SettingsRow label="Model">
      <input
        class="field w-64 font-mono"
        :value="ai.model"
        placeholder="qwen2.5-coder:3b"
        @input="patchAi({ model: ($event.target as HTMLInputElement).value })"
      />
    </SettingsRow>

    <SettingsRow label="FIM template" hint="'Auto' lets Ollama apply the model's native template">
      <select
        class="select w-64"
        :value="ai.fimTemplate"
        @change="patchAi({ fimTemplate: ($event.target as HTMLSelectElement).value as FimTemplate })"
      >
        <option value="auto">Auto (Ollama ≥ 0.3)</option>
        <option value="qwen">Qwen</option>
        <option value="codellama">CodeLlama</option>
        <option value="deepseek">DeepSeek Coder</option>
        <option value="starcoder">StarCoder</option>
        <option value="none">None (prefix only)</option>
      </select>
    </SettingsRow>

    <SectionHeader title="Tuning" subtitle="Request size and cadence" />
    <SettingsRow label="Max tokens">
      <input
        type="number"
        :min="16"
        :max="512"
        class="field w-24"
        :value="ai.maxTokens"
        @input="patchAi({ maxTokens: Number(($event.target as HTMLInputElement).value) || 128 })"
      />
    </SettingsRow>
    <SettingsRow label="Temperature">
      <div class="flex items-center gap-3 w-64">
        <input
          type="range"
          :min="0"
          :max="1"
          :step="0.05"
          class="flex-1 accent-[var(--accent)]"
          :value="ai.temperature"
          @input="patchAi({ temperature: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="text-fg-muted text-[11px] tabular-nums w-10">{{ ai.temperature.toFixed(2) }}</span>
      </div>
    </SettingsRow>
    <SettingsRow label="Debounce">
      <div class="flex items-center gap-2">
        <input
          type="number"
          :min="50"
          :max="2000"
          class="field w-24"
          :value="ai.debounceMs"
          @input="patchAi({ debounceMs: Number(($event.target as HTMLInputElement).value) || 400 })"
        />
        <span class="text-[11px] text-fg-muted">ms after last keystroke</span>
      </div>
    </SettingsRow>

    <SectionHeader title="Test connection" />
    <div class="flex items-center gap-3">
      <button class="btn-subtle" :disabled="testStatus === 'testing'" @click="test">
        <template v-if="testStatus === 'testing'"> <Loader2 :size="12" class="animate-spin" /> Testing… </template>
        <template v-else>Test</template>
      </button>
      <span v-if="testStatus === 'ok'" class="inline-flex items-center gap-1 text-success text-[12px]">
        <CheckCircle2 :size="12" />{{ testMessage }}
      </span>
      <span v-else-if="testStatus === 'error'" class="inline-flex items-center gap-1 text-danger text-[12px]">
        <AlertTriangle :size="12" />{{ testMessage }}
      </span>
    </div>

    <div class="pt-3 text-[11px] text-fg-subtle border-t border-line space-y-1.5">
      <div>
        Need to install or pull a model? See
        <button
          type="button"
          class="underline hover:text-fg cursor-default"
          @click="openExternal('https://ollama.com')"
        >
          ollama.com</button
        >.
      </div>
      <div class="text-fg-muted pt-1">
        Ghost-text suggestions show as you pause typing. Press <span class="kbd">Tab</span> to accept,
        <span class="kbd">Esc</span> to dismiss.
      </div>
    </div>
  </div>
</template>
