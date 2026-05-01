<script setup lang="ts">
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "./stores/app";
import { useAppTheme } from "./composables/useAppTheme";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { useBootSequence } from "./composables/useBootSequence";
import { useTabPersistence } from "./composables/useTabPersistence";
import { useScratchModelGc } from "./composables/useScratchModelGc";
import { useIdeHelperPrompt } from "./composables/useIdeHelperPrompt";
import { useRunner } from "./composables/useRunner";

import Toolbar from "./components/Toolbar.vue";
import TabBar from "./components/TabBar.vue";
import EditorPane from "./components/EditorPane.vue";
import ResultPane from "./components/ResultPane.vue";
import StatusBar from "./components/StatusBar.vue";
import BootSplash from "./components/BootSplash.vue";
import NoPhpBanner from "./components/NoPhpBanner.vue";
import SettingsModal from "./components/SettingsModal.vue";
import CommandPalette from "./components/CommandPalette.vue";
import ShortcutCheatsheet from "./components/ShortcutCheatsheet.vue";
import ArtisanDialog from "./components/ArtisanDialog.vue";
import SnippetsDialog from "./components/SnippetsDialog.vue";
import IdeHelperPrompt from "./components/IdeHelperPrompt.vue";
import AddSshProjectDialog from "./components/AddSshProjectDialog.vue";
import SecretPromptDialog from "./components/SecretPromptDialog.vue";
import ToastContainer from "./components/ToastContainer.vue";

const store = useAppStore();
const { tabs, selectedTabId, selectedTab, projects, dialog } = storeToRefs(store);

const paletteOpen = ref(false);

useAppTheme();

const { bootComplete, phpAvailable, splashSteps, splashOpen, onLaravelLsRetry, onLaravelLsSkip } = useBootSequence();
const { runCode, runActive, cancelActive } = useRunner({ selectedTab, projects });
useTabPersistence({ tabs, selectedTabId, bootComplete });
useScratchModelGc({ tabs, projects });
const ideHelper = useIdeHelperPrompt({ selectedTab, bootComplete });

async function onSshProjectAdded(project: { id: string }): Promise<void> {
  store.setProjects(await window.lsp.projectsList());
  store.selectProject(project.id);
}

function newTab(): void {
  // Inherit project + per-tab PHP / DB from the active tab so the user
  // can fork-and-tweak rather than re-pick everything. Falls back to
  // the first known project when nothing is open (cold-start path).
  const current = selectedTab.value;
  if (current) {
    store.addTab(current.projectId, {
      phpBinary: current.phpBinary,
      databaseConnectionId: current.databaseConnectionId,
    });
    return;
  }
  const first = projects.value[0];
  if (first) store.addTab(first.id);
}

function closeCurrent(): void {
  if (selectedTabId.value) store.closeTab(selectedTabId.value);
}

useKeyboardShortcuts({
  onRun: runActive,
  onCancel: () => void cancelActive(),
  onOpenPalette: () => {
    paletteOpen.value = !paletteOpen.value;
  },
  onNewTab: newTab,
  onCloseTab: closeCurrent,
  onOpenCheatsheet: () => store.openDialog("cheatsheet"),
  onOpenArtisan: () => store.openDialog("artisan"),
  onOpenSaveSnippet: () => store.openDialog("snippetsSave"),
  onOpenSettings: () => store.openDialog("settings"),
});
</script>

<template>
  <div class="flex flex-col h-full">
    <BootSplash v-if="splashOpen" :steps="splashSteps" @retry="onLaravelLsRetry" @skip="onLaravelLsSkip" />

    <Toolbar
      @run="runActive"
      @cancel="cancelActive"
      @open-settings="store.openDialog('settings')"
      @open-palette="paletteOpen = true"
      @run-artisan="(code) => runCode(code)"
    />
    <main class="flex flex-col flex-1 min-h-0">
      <TabBar @new-tab="newTab" />

      <NoPhpBanner v-if="!phpAvailable" class="flex-1 min-h-0" @open-settings="store.openDialog('settings')" />
      <Splitpanes v-else-if="selectedTab" class="flex-1 min-h-0 app-splitpanes" :push-other-panes="false">
        <Pane :size="52" :min-size="30">
          <EditorPane
            :key="selectedTab.id"
            :tab="selectedTab"
            @run="runActive"
            @cancel="cancelActive"
            @run-line="(code) => runCode(code)"
          />
        </Pane>
        <Pane :size="48" :min-size="25">
          <ResultPane :tab="selectedTab" />
        </Pane>
      </Splitpanes>
      <div v-else class="flex-1 flex items-center justify-center text-fg-muted">
        No tab selected — ⌘T to create one.
      </div>

      <StatusBar :tab="selectedTab" />
    </main>

    <SettingsModal :open="dialog === 'settings'" @close="store.closeDialog" />
    <CommandPalette
      :open="paletteOpen"
      @close="paletteOpen = false"
      @run="runActive"
      @cancel="cancelActive"
      @open-settings="store.openDialog('settings')"
      @new-tab="newTab"
      @open-artisan="store.openDialog('artisan')"
      @open-cheatsheet="store.openDialog('cheatsheet')"
      @open-snippets="(mode) => store.openDialog(mode === 'save' ? 'snippetsSave' : 'snippetsManage')"
    />
    <ShortcutCheatsheet :open="dialog === 'cheatsheet'" @close="store.closeDialog" />
    <ArtisanDialog :open="dialog === 'artisan'" @close="store.closeDialog" @run="(code) => runCode(code)" />
    <SnippetsDialog
      :open="dialog === 'snippetsManage' || dialog === 'snippetsSave'"
      :initial-mode="dialog === 'snippetsSave' ? 'save' : 'manage'"
      @close="store.closeDialog"
    />
    <IdeHelperPrompt
      :project-id="ideHelper.promptFor.value"
      :project-name="ideHelper.promptName.value"
      @close="ideHelper.onClose"
      @declined="ideHelper.onDeclined"
      @installed="ideHelper.onInstalled"
    />
    <AddSshProjectDialog
      :open="dialog === 'addSsh'"
      @close="store.closeDialog"
      @added="onSshProjectAdded"
    />
    <SecretPromptDialog />
    <ToastContainer />
  </div>
</template>

<style>
/*
 * Splitpanes theming — ship a 1 px divider that grows to 3 px on hover
 * and picks up the accent colour, matching what `react-resizable-panels`
 * did with `[data-panel-resize-handle-enabled]`.
 */
.app-splitpanes > .splitpanes__splitter {
  background: transparent;
  width: 1px;
  transition:
    background-color 120ms ease,
    width 120ms ease;
  position: relative;
}
.app-splitpanes > .splitpanes__splitter:hover,
.app-splitpanes.splitpanes--dragging > .splitpanes__splitter {
  background: var(--accent);
  opacity: 0.55;
  width: 3px;
}
/* Reset splitpanes' default styling so it inherits our token colours. */
.app-splitpanes.splitpanes--vertical > .splitpanes__splitter {
  border-left: none;
}
</style>
