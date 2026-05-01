<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Network, Clock, CheckCircle2, AlertTriangle, Loader2, Sparkles } from "lucide-vue-next";
import type { PhpVersionInfo } from "../../shared/ipc";
import { useAppStore } from "../stores/app";
import LaravelIcon from "./icons/LaravelIcon.vue";
import PhpIcon from "./icons/PhpIcon.vue";
import type { Tab } from "../stores/app";

const props = defineProps<{ tab: Tab | null }>();

const store = useAppStore();
const { projects, settings, indexingTasks } = storeToRefs(store);

const proj = computed(() => (props.tab ? (projects.value.find((p) => p.id === props.tab!.projectId) ?? null) : null));

const lineCount = computed(() => props.tab?.code.split("\n").length ?? 0);
const charCount = computed(() => props.tab?.code.length ?? 0);

/**
 * Read the real PHP versions so we can show an actual version number
 * instead of the binary filename. Re-fetch whenever the user adds or
 * removes a custom path, or switches the default binary, so the chip
 * tracks the selection in real time.
 */
const phpVersions = ref<PhpVersionInfo[]>([]);

onMounted(async () => {
  phpVersions.value = await window.lsp.phpVersions();
});

watch(
  () => [settings.value?.php.defaultBinary, settings.value?.php.customPaths] as const,
  async () => {
    phpVersions.value = await window.lsp.phpVersions();
  },
);

const phpLabel = computed(() => {
  const active = settings.value?.php.defaultBinary ?? null;
  const first = phpVersions.value[0];
  if (!first) return "PHP …";
  if (!active) return `PHP ${first.version}`;
  const v = phpVersions.value.find((x) => x.path === active);
  return v ? `PHP ${v.version}` : "PHP custom";
});

/**
 * Reduce the active-tasks map into a short label + a tooltip-worthy full
 * string. Multiple concurrent tasks collapse to a generic count; a single
 * task shows its title/message.
 */
const indexing = computed(() => {
  const entries = Object.values(indexingTasks.value);
  const first = entries[0];
  if (!first) return null;
  if (entries.length === 1) {
    const parts = [first.title, first.message].filter(Boolean).join(" — ");
    const pct = first.percentage != null ? ` ${Math.round(first.percentage)}%` : "";
    return { label: `${first.title ?? "Indexing"}${pct}`, full: parts + pct };
  }
  return { label: `Indexing (${entries.length})`, full: entries.map((t) => t.title ?? "?").join(", ") };
});
</script>

<template>
  <div class="flex items-center h-6 px-3 border-t border-line bg-surface text-[10px] text-fg-muted gap-3">
    <span
      v-if="proj"
      class="inline-flex items-center gap-1"
      :title="
        proj.kind === 'ssh' && proj.ssh
          ? `${proj.ssh.user ? proj.ssh.user + '@' : ''}${proj.ssh.host}:${proj.projectPath}`
          : (proj.projectPath ?? proj.name)
      "
    >
      <LaravelIcon v-if="proj.kind === 'laravel'" :size="10" class="text-brand-laravel" />
      <Network v-else-if="proj.kind === 'ssh'" :size="10" />
      <span>{{ proj.name }}</span>
      <span v-if="proj.kind === 'ssh'" class="text-fg-subtle uppercase tracking-wider">· ssh</span>
      <span v-if="proj.laravelVersion" class="text-fg-subtle" :title="`Laravel framework ${proj.laravelVersion}`"
        >· v{{ proj.laravelVersion }}</span
      >
    </span>
    <span class="inline-flex items-center gap-1" :title="settings?.php.defaultBinary ?? 'auto (first discovered)'">
      <PhpIcon :size="10" class="text-brand-php" />
      <span>{{ phpLabel }}</span>
    </span>
    <span v-if="tab?.lastDurationMs != null" class="inline-flex items-center gap-1 text-fg-muted">
      <Clock :size="10" />
      <span class="tabular-nums">{{ tab.lastDurationMs }}ms</span>
    </span>
    <span v-if="tab?.lastError" class="inline-flex items-center gap-1 text-danger" :title="tab.lastError">
      <AlertTriangle :size="10" />
      <span>Error</span>
    </span>
    <span class="flex-1" />
    <span v-if="indexing" class="inline-flex items-center gap-1 text-accent" :title="indexing.full">
      <Loader2 :size="10" class="animate-spin" />
      <span class="truncate max-w-[180px]">{{ indexing.label }}</span>
    </span>
    <span
      v-if="settings?.ai.enabled"
      class="inline-flex items-center gap-1 text-accent"
      :title="`AI completions active — model: ${settings.ai.model} @ ${settings.ai.endpoint}`"
    >
      <Sparkles :size="10" />
      <span>AI</span>
    </span>
    <template v-if="tab">
      <span class="tabular-nums">{{ lineCount }} lines</span>
      <span class="tabular-nums">{{ charCount }} chars</span>
    </template>
    <span class="inline-flex items-center gap-1">
      <CheckCircle2 :size="10" class="text-success" />
      <span>Ready</span>
    </span>
  </div>
</template>
