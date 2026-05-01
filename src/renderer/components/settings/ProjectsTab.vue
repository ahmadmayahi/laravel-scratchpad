<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Network, Trash2, FolderOpen } from "lucide-vue-next";
import type { Project } from "../../../shared/ipc";
import { useAppStore } from "../../stores/app";
import LaravelIcon from "../icons/LaravelIcon.vue";

/**
 * Settings → Projects tab. Covers local Laravel + SSH only. Skeletons
 * are managed from the Laravel tab (checkbox-driven provisioning) and
 * are filtered out here even though `projectsList()` unions them in for
 * the toolbar picker.
 */

const store = useAppStore();
const allProjects = ref<Project[]>([]);

// Filter skeletons out — they're surfaced via the Laravel tab and the
// toolbar picker, never for manual editing in the Projects tab.
const projects = computed(() => allProjects.value.filter((p) => !p.isBundled));

onMounted(async () => {
  allProjects.value = await window.lsp.projectsList();
});

async function addLaravel(): Promise<void> {
  const p = await window.lsp.projectsPickLaravel();
  if (p) {
    allProjects.value = await window.lsp.projectsList();
    store.setProjects(allProjects.value);
    // Adopt into the active tab so the user doesn't have to also
    // switch project via the toolbar after adding from Settings.
    store.selectProject(p.id);
  }
}

function addSsh(): void {
  // Open the top-level SSH dialog. It emits back to App.vue, which
  // refreshes the store; we pick up the new entry on next re-open.
  store.openDialog("addSsh");
}

async function remove(id: string): Promise<void> {
  await window.lsp.projectsRemove(id);
  allProjects.value = await window.lsp.projectsList();
  store.setProjects(allProjects.value);
}

function prettyPath(p: string): string {
  return p.replace(/^(?:\/Users|\/home)\/[^/]+/, "~");
}

function sshSubtitle(p: Project): string {
  if (!p.ssh) return "ssh";
  const userPart = p.ssh.user ? `${p.ssh.user}@` : "";
  const portPart = p.ssh.port && p.ssh.port !== 22 ? `:${p.ssh.port}` : "";
  return `${userPart}${p.ssh.host}${portPart}:${p.projectPath}`;
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-fg">Projects</h3>
      <div class="flex items-center gap-2">
        <button class="btn-subtle" @click="addLaravel">
          <FolderOpen :size="12" />
          Local Laravel
        </button>
        <button class="btn-subtle" @click="addSsh">
          <Network :size="12" />
          SSH project
        </button>
      </div>
    </div>
    <div class="border border-line rounded-lg divide-y divide-line overflow-hidden">
      <div v-for="p in projects" :key="p.id" class="px-3 py-2 flex items-center gap-3">
        <span class="shrink-0" :title="p.kind">
          <LaravelIcon v-if="p.kind === 'laravel'" :size="14" class="text-brand-laravel" />
          <Network v-else-if="p.kind === 'ssh'" :size="14" class="text-fg-muted" />
        </span>
        <div class="flex-1 min-w-0">
          <div class="text-fg text-xs truncate flex items-center gap-2">
            <span>{{ p.name }}</span>
            <span v-if="p.kind === 'ssh'" class="text-[9px] text-accent uppercase tracking-wider">ssh</span>
          </div>
          <div
            class="text-fg-muted font-mono text-[11px] truncate"
            :title="p.kind === 'ssh' ? sshSubtitle(p) : p.projectPath"
          >
            {{ p.kind === "ssh" ? sshSubtitle(p) : prettyPath(p.projectPath) }}
          </div>
        </div>
        <button class="icon-btn h-7 w-7 shrink-0 hover:text-danger" title="Remove project" @click="remove(p.id)">
          <Trash2 :size="12" />
        </button>
      </div>
    </div>
    <p class="text-[11px] text-fg-muted">
      SSH projects authenticate through your ssh-agent or
      <code class="font-mono">~/.ssh/config</code>. No passwords or passphrases are stored by the app.
    </p>
  </div>
</template>
