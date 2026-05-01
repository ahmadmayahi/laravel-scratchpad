<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, useTemplateRef, watch } from "vue";
import { storeToRefs } from "pinia";
import { useAppStore } from "../stores/app";
import type { Tab } from "../stores/app";
import { registerAiInlineProvider, type AiProviderHandle } from "../lib/aiCompletion";
import { bindEditorShortcuts } from "../lib/editorShortcuts";
import { useMonacoEditor } from "../composables/useMonacoEditor";
import { useDualLspBindings } from "../composables/useDualLspBindings";
import { useRunLineGlyph } from "../composables/useRunLineGlyph";
import { registerActiveEditor } from "../composables/useEditorRegistry";
import { documentUriFor } from "../lib/lspManager";

/**
 * Monaco-backed PHP editor. Mounts one editor instance per tab (the
 * outer `<EditorPane :key="tab.id">` forces remount on tab swap),
 * delegates the heavy lifting to four composables / helpers:
 *
 *   - `useMonacoEditor` — instance + display options + view state
 *   - `useDualLspBindings` — Intelephense + laravel-ls attach/detach
 *   - `useRunLineGlyph` — gutter "run statement" affordance
 *   - `bindEditorShortcuts` — ⌘R / ⌘. / ⌘K bridges
 *
 * What stays here: the AI inline-completion lifecycle (small, two
 * watchers), the snippet-insert command-bus watcher (subsumed by A3
 * later), and the boilerplate of wiring composables together.
 */

const props = defineProps<{ tab: Tab }>();
const emit = defineEmits<{ run: []; cancel: []; runLine: [code: string] }>();

const store = useAppStore();
const { settings, projects, lspReinitNonce } = storeToRefs(store);

const hostEl = useTemplateRef<HTMLDivElement>("host");
const tabRef = computed(() => props.tab);

function initialUri(): string {
  const proj = projects.value.find((p) => p.id === props.tab.projectId);
  const projectPathForUri = proj?.kind === "ssh" ? `/ssh:${proj.id}` : proj?.projectPath;
  return documentUriFor(projectPathForUri, props.tab.id);
}

const monacoHandle = useMonacoEditor({
  hostEl,
  settings,
  initialUri,
  initialCode: () => props.tab.code,
});
const { editor } = monacoHandle;

useDualLspBindings({
  editor: monacoHandle,
  tab: tabRef,
  projects,
  settings,
  lspReinitNonce,
  onUserType: (code) => store.updateTabCode(props.tab.id, code),
});

useRunLineGlyph(editor, (code) => emit("runLine", code));

watch(editor, (ed) => {
  if (!ed) return;
  bindEditorShortcuts(ed, {
    onRun: () => emit("run"),
    onCancel: () => emit("cancel"),
  });
  registerActiveEditor(ed);
  ed.focus();
});

// AI inline-completion lifecycle. Registered once when the editor
// mounts and re-registered whenever any AI tunable flips so a fresh
// provider sees the new endpoint / template / sampling parameters
// without an app restart.
const aiProvider = shallowRef<AiProviderHandle | null>(null);
watch(
  () =>
    [
      // Sentinel for "editor exists" — boolean keeps the dependency stable.
      editor.value !== null,
      settings.value?.ai.enabled,
      settings.value?.ai.endpoint,
      settings.value?.ai.model,
      settings.value?.ai.fimTemplate,
      settings.value?.ai.maxTokens,
      settings.value?.ai.temperature,
      settings.value?.ai.debounceMs,
      settings.value?.ai.maxContextChars,
    ] as const,
  ([editorReady]) => {
    if (!editorReady || !settings.value) return;
    aiProvider.value?.dispose();
    aiProvider.value = registerAiInlineProvider(settings.value.ai);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  aiProvider.value?.dispose();
  aiProvider.value = null;
});
</script>

<template>
  <div class="h-full w-full monaco-root overflow-hidden relative">
    <div ref="host" class="h-full w-full" />
  </div>
</template>
