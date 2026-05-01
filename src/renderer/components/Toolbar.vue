<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "reka-ui";
import {
  Play,
  Square,
  Settings,
  Search,
  ChevronDown,
  Network,
  FolderOpen,
  Check,
  Loader2,
  Sun,
  Moon,
  Monitor,
  Database,
} from "lucide-vue-next";
import { useAppStore } from "../stores/app";
import { cn } from "../lib/cn";
import { displayKeys } from "../lib/shortcuts";
import LaravelIcon from "./icons/LaravelIcon.vue";
import PhpIcon from "./icons/PhpIcon.vue";
import DatabaseDriverIcon from "./icons/DatabaseDriverIcon.vue";
import ArtisanInput from "./ArtisanInput.vue";
import type { DatabaseConnection, PhpVersionInfo, Project } from "../../shared/ipc";

defineEmits<{
  run: [];
  cancel: [];
  openSettings: [];
  openPalette: [];
  runArtisan: [code: string];
}>();

const store = useAppStore();
const { selectedTab, projects, settings } = storeToRefs(store);

const proj = computed(() =>
  selectedTab.value ? (projects.value.find((p) => p.id === selectedTab.value!.projectId) ?? null) : null,
);
const isRunning = computed(() => !!selectedTab.value?.isRunning);
const isStarting = computed(() => !!selectedTab.value?.isStarting);

const skeletonProjects = computed(() => projects.value.filter((p) => p.isBundled));
const localProjects = computed(() => projects.value.filter((p) => !p.isBundled && p.kind === "laravel"));
const sshProjects = computed(() => projects.value.filter((p) => !p.isBundled && p.kind === "ssh"));

const platform = window.platform;

async function selectExistingProject(p: Project): Promise<void> {
  if (!selectedTab.value) return;
  store.setTabProject(selectedTab.value.id, p.id);
}

async function refreshProjects(): Promise<void> {
  store.setProjects(await window.lsp.projectsList());
}

async function pickLaravel(): Promise<void> {
  const p = await window.lsp.projectsPickLaravel();
  if (p) {
    await refreshProjects();
    store.selectProject(p.id);
  }
}

function openAddSsh(): void {
  store.openDialog("addSsh");
}

const currentMode = computed(() => settings.value?.ui.mode ?? "system");

async function setMode(next: "light" | "dark" | "system"): Promise<void> {
  if (!settings.value) return;
  const updated = await window.lsp.settingsSet({ ui: { ...settings.value.ui, mode: next } });
  store.setSettings(updated);
}

const phpVersions = ref<PhpVersionInfo[]>([]);
const dbConnections = ref<DatabaseConnection[]>([]);

let offSettingsForDb: (() => void) | null = null;

onMounted(async () => {
  phpVersions.value = await window.lsp.phpVersions();
  dbConnections.value = await window.lsp.databaseList();
  // Settings changes (add/edit/remove a connection from the modal) need
  // to flow back into the dropdown without a remount. Listen via the
  // existing settings-changed channel — same pattern as the rest of
  // the toolbar's reactive bits.
  offSettingsForDb = window.lsp.onSettingsChanged(async () => {
    dbConnections.value = await window.lsp.databaseList();
  });
});

onBeforeUnmount(() => offSettingsForDb?.());

async function pickPhp(path: string | null): Promise<void> {
  if (!selectedTab.value) return;
  // Per-tab pick. The tab's session is dropped inside the store so the
  // next Run boots a fresh worker against the new binary; without that
  // the running worker would silently keep using the old PHP.
  store.setTabPhp(selectedTab.value.id, path);
}

// PhpTab's allow-list. Main seeds it on first boot with every discovered
// binary, and PhpTab blocks unticking the last one — so an empty list
// here only ever means "no PHP installed at all", which the dropdown
// renders as the empty-state message below.
const enabledPhpVersions = computed(() => {
  const set = new Set(settings.value?.php.enabledPaths ?? []);
  return phpVersions.value.filter((v) => set.has(v.path));
});

// Resolve to the binary that's actually about to run, in priority order:
//   1. The current tab's per-tab pin (when it points at a still-enabled binary).
//   2. The settings default (back-compat: Settings → PHP can still
//      seed a global default; honoured for tabs that haven't picked).
//   3. First enabled binary (the always-something fallback so the
//      dropdown's active-row indicator never floats).
//
// Letting (1) win means picking PHP 8.4 in tab A and PHP 8.2 in tab B
// keeps both pins independent across tab switches.
const phpActivePath = computed<string | null>(() => {
  const enabled = enabledPhpVersions.value;
  const tabPin = selectedTab.value?.phpBinary ?? null;
  if (tabPin && enabled.some((v) => v.path === tabPin)) return tabPin;
  const settingsDefault = settings.value?.php.defaultBinary ?? null;
  if (settingsDefault && enabled.some((v) => v.path === settingsDefault)) return settingsDefault;
  return enabled[0]?.path ?? null;
});

const phpActiveLabel = computed(() => {
  const path = phpActivePath.value;
  if (!path) return "PHP";
  const v = phpVersions.value.find((x) => x.path === path);
  return v ? `PHP ${v.version}` : "PHP custom";
});

// The Database picker is meaningful only for bundled skeletons. Local
// + SSH projects keep their own .env, so the chip renders disabled
// with an explanatory tooltip — visible-but-inert is friendlier than
// hiding it entirely (otherwise users wonder if the feature exists).
const isSkeletonProject = computed(() => proj.value?.isBundled === true);

// Per-tab pick, read straight from the active tab — no global
// "active connection" anywhere. New tabs (and any tab the user hasn't
// touched) sit at `null`, which means "use the project's .env".
const dbActiveId = computed<string | null>(() => selectedTab.value?.databaseConnectionId ?? null);

const dbActiveConnection = computed<DatabaseConnection | null>(() => {
  const id = dbActiveId.value;
  if (!id) return null;
  return dbConnections.value.find((c) => c.id === id) ?? null;
});

const dbActiveLabel = computed(() => {
  if (!isSkeletonProject.value) return "Project .env";
  return dbActiveConnection.value?.name ?? "Project .env";
});

function pickDatabase(id: string | null): void {
  if (!selectedTab.value) return;
  store.setTabDatabase(selectedTab.value.id, id);
}

const ITEM_CLASS = cn(
  "w-full flex items-center gap-2.5 px-3 py-2 text-left cursor-default transition-colors",
  "outline-none text-fg text-[13px]",
  "data-[highlighted]:bg-accent/15 data-[highlighted]:text-fg",
);

const MENU_CONTENT_CLASS = cn(
  "title-bar-nodrag z-40 w-64 rounded-lg overflow-hidden",
  "bg-gradient-to-b from-surface to-bg border border-line",
  "shadow-2xl shadow-black/60",
  "focus:outline-none",
);

const MENU_LABEL_CLASS = "px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-fg-muted";
</script>

<template>
  <div
    :class="
      cn(
        'title-bar-drag flex items-center h-11 gap-2 bg-surface border-b border-line',
        platform === 'darwin' ? 'pl-[84px] pr-3' : platform === 'win32' ? 'pl-3 pr-[140px]' : 'pl-3 pr-3',
      )
    "
  >
    <div class="title-bar-nodrag flex items-center gap-1.5">
      <button v-if="isRunning" class="btn-danger" :title="`Cancel (${displayKeys('⌘.')})`" @click="$emit('cancel')">
        <Square :size="12" fill="currentColor" />
        Cancel
      </button>
      <button
        v-else-if="isStarting"
        class="btn-primary opacity-80"
        disabled
        title="Booting session — waiting for the worker to come online"
      >
        <Loader2 :size="12" class="animate-spin" />
        Starting…
      </button>
      <button
        v-else
        :class="cn('btn-primary')"
        :disabled="!selectedTab"
        :title="`Run (${displayKeys('⌘R')})`"
        @click="$emit('run')"
      >
        <Play :size="12" fill="currentColor" />
        Run
        <span
          class="ml-1 inline-flex items-center justify-center px-1.5 h-[18px] min-w-[18px] rounded bg-black/25 border border-white/20 text-[10px] text-white font-mono tracking-tight"
          >{{ displayKeys("⌘R") }}</span
        >
      </button>
    </div>

    <div class="mx-2 h-5 w-px bg-line title-bar-nodrag" />

    <div class="title-bar-nodrag flex items-center gap-1.5">
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          class="chip hover:bg-surface-3 hover:border-line-strong title-bar-nodrag"
          title="Switch project for this tab"
        >
          <LaravelIcon v-if="!proj || proj.kind === 'laravel'" :size="12" class="text-brand-laravel" />
          <Network v-else-if="proj.kind === 'ssh'" :size="12" />
          <span class="text-fg max-w-[180px] truncate">{{ proj?.name ?? "No project" }}</span>
          <span
            v-if="proj?.kind === 'ssh'"
            class="text-fg-muted text-[9px] uppercase tracking-wider"
            title="Remote via SSH"
            >ssh</span
          >
          <span v-if="proj?.laravelVersion" class="text-fg-muted text-[9px] tabular-nums">
            v{{ proj.laravelVersion }}
          </span>
          <ChevronDown :size="10" class="text-fg-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent :class="MENU_CONTENT_CLASS" align="start" :side-offset="4">
            <DropdownMenuLabel :class="MENU_LABEL_CLASS">Laravel skeletons</DropdownMenuLabel>
            <div v-if="skeletonProjects.length === 0" class="px-3 py-2 text-[11px] text-fg-muted italic">
              None provisioned — pick versions in Settings → Laravel
            </div>
            <DropdownMenuItem
              v-for="p in skeletonProjects"
              :key="p.id"
              :class="[ITEM_CLASS, proj?.id === p.id && 'bg-accent/15']"
              @select="selectExistingProject(p)"
            >
              <span class="text-fg-muted shrink-0">
                <LaravelIcon :size="12" class="text-brand-laravel" />
              </span>
              <span class="flex-1 truncate">{{ p.name }}</span>
              <span v-if="proj?.id === p.id" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator class="hairline" />
            <DropdownMenuLabel :class="MENU_LABEL_CLASS">Local projects</DropdownMenuLabel>
            <div v-if="localProjects.length === 0" class="px-3 py-2 text-[11px] text-fg-muted italic">
              No local projects configured
            </div>
            <DropdownMenuItem
              v-for="p in localProjects"
              :key="p.id"
              :class="[ITEM_CLASS, proj?.id === p.id && 'bg-accent/15']"
              @select="selectExistingProject(p)"
            >
              <span class="text-fg-muted shrink-0">
                <LaravelIcon :size="12" class="text-brand-laravel" />
              </span>
              <span class="flex-1 truncate">{{ p.name }}</span>
              <span class="text-[10px] text-fg-muted uppercase tracking-wider shrink-0">
                {{ p.laravelVersion ? `Laravel ${p.laravelVersion}` : "local" }}
              </span>
              <span v-if="proj?.id === p.id" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator class="hairline" />
            <DropdownMenuLabel :class="MENU_LABEL_CLASS">SSH projects</DropdownMenuLabel>
            <div v-if="sshProjects.length === 0" class="px-3 py-2 text-[11px] text-fg-muted italic">
              No SSH projects configured
            </div>
            <DropdownMenuItem
              v-for="p in sshProjects"
              :key="p.id"
              :class="[ITEM_CLASS, proj?.id === p.id && 'bg-accent/15']"
              @select="selectExistingProject(p)"
            >
              <span class="text-fg-muted shrink-0">
                <Network :size="12" />
              </span>
              <span class="flex-1 truncate">{{ p.name }}</span>
              <span class="text-[10px] text-fg-muted uppercase tracking-wider shrink-0">
                {{ p.ssh ? `${p.ssh.user ? p.ssh.user + "@" : ""}${p.ssh.host}` : "ssh" }}
              </span>
              <span v-if="proj?.id === p.id" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator class="hairline" />
            <DropdownMenuItem :class="ITEM_CLASS" @select="pickLaravel()">
              <span class="text-fg-muted shrink-0">
                <FolderOpen :size="12" />
              </span>
              <span class="flex-1 truncate">Open Laravel project…</span>
            </DropdownMenuItem>
            <DropdownMenuItem :class="ITEM_CLASS" @select="openAddSsh()">
              <span class="text-fg-muted shrink-0">
                <Network :size="12" />
              </span>
              <span class="flex-1 truncate">Add SSH project…</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <DropdownMenuRoot>
        <DropdownMenuTrigger
          class="chip hover:bg-surface-3 hover:border-line-strong title-bar-nodrag"
          title="Change PHP version"
        >
          <PhpIcon :size="12" class="text-brand-php" />
          <span>{{ phpActiveLabel }}</span>
          <ChevronDown :size="10" class="text-fg-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent :class="MENU_CONTENT_CLASS" align="start" :side-offset="4">
            <div v-if="enabledPhpVersions.length === 0" class="px-3 py-3 text-[11px] text-fg-muted italic">
              {{
                phpVersions.length === 0
                  ? "No CLI binaries found — install via brew / asdf / Herd."
                  : "No PHP versions enabled — pick at least one in Settings → PHP."
              }}
            </div>
            <DropdownMenuItem
              v-for="v in enabledPhpVersions"
              :key="v.path"
              :class="[ITEM_CLASS, phpActivePath === v.path && 'bg-accent/15']"
              @select="pickPhp(v.path)"
            >
              <span class="text-fg-muted shrink-0">
                <Check v-if="phpActivePath === v.path" :size="12" />
                <PhpIcon v-else :size="12" class="text-brand-php" />
              </span>
              <span class="flex-1 truncate">PHP {{ v.version }}</span>
              <span v-if="phpActivePath === v.path" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <DropdownMenuRoot v-if="isSkeletonProject">
        <DropdownMenuTrigger
          class="chip hover:bg-surface-3 hover:border-line-strong title-bar-nodrag"
          title="Override the database connection for this skeleton"
        >
          <DatabaseDriverIcon v-if="dbActiveConnection" :driver="dbActiveConnection.driver" :size="12" />
          <Database v-else :size="12" class="text-fg-muted" />
          <span>{{ dbActiveLabel }}</span>
          <ChevronDown :size="10" class="text-fg-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent :class="MENU_CONTENT_CLASS" align="start" :side-offset="4">
            <DropdownMenuItem
              :class="[ITEM_CLASS, dbActiveId === null && 'bg-accent/15']"
              @select="pickDatabase(null)"
            >
              <span class="text-fg-muted shrink-0">
                <Check v-if="dbActiveId === null" :size="12" />
                <Database v-else :size="12" />
              </span>
              <span class="flex-1 truncate">Use the project's .env</span>
              <span v-if="dbActiveId === null" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="dbConnections.length > 0" class="hairline" />
            <DropdownMenuItem
              v-for="c in dbConnections"
              :key="c.id"
              :class="[ITEM_CLASS, dbActiveId === c.id && 'bg-accent/15']"
              @select="pickDatabase(c.id)"
            >
              <span class="text-fg-muted shrink-0">
                <Check v-if="dbActiveId === c.id" :size="12" />
                <DatabaseDriverIcon v-else :driver="c.driver" :size="12" />
              </span>
              <span class="flex-1 truncate">{{ c.name }}</span>
              <span class="text-[10px] text-fg-muted uppercase tracking-wider shrink-0">{{ c.driver }}</span>
              <span v-if="dbActiveId === c.id" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <button
        v-else
        class="chip opacity-50 cursor-not-allowed title-bar-nodrag"
        disabled
        title="Database overrides apply to bundled skeletons only — local + SSH projects use their own .env"
      >
        <Database :size="12" class="text-fg-muted" />
        <span>Project .env</span>
      </button>
    </div>

    <div class="flex-1 title-bar-drag" />

    <div class="title-bar-nodrag flex items-center gap-1">
      <ArtisanInput @run="(code) => $emit('runArtisan', code)" />

      <button
        class="inline-flex items-center gap-2 h-7 pl-2 pr-1.5 rounded-md bg-surface-2 hover:bg-surface-3 border border-line text-[11px] text-fg-muted transition-colors cursor-default"
        :title="`Command Palette (${displayKeys('⌘K')})`"
        @click="$emit('openPalette')"
      >
        <Search :size="12" />
        <span>Search actions, snippets…</span>
        <span class="kbd">{{ displayKeys("⌘K") }}</span>
      </button>

      <DropdownMenuRoot>
        <DropdownMenuTrigger class="icon-btn title-bar-nodrag" :title="`Appearance: ${currentMode}`">
          <Moon v-if="currentMode === 'dark'" :size="14" />
          <Sun v-else-if="currentMode === 'light'" :size="14" />
          <Monitor v-else :size="14" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent :class="[MENU_CONTENT_CLASS, '!w-40']" align="end" :side-offset="4">
            <DropdownMenuItem
              :class="[ITEM_CLASS, currentMode === 'light' && 'bg-accent/15']"
              @select="setMode('light')"
            >
              <span class="text-fg-muted shrink-0"><Sun :size="12" /></span>
              <span class="flex-1 truncate">Light</span>
              <span v-if="currentMode === 'light'" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              :class="[ITEM_CLASS, currentMode === 'dark' && 'bg-accent/15']"
              @select="setMode('dark')"
            >
              <span class="text-fg-muted shrink-0"><Moon :size="12" /></span>
              <span class="flex-1 truncate">Dark</span>
              <span v-if="currentMode === 'dark'" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              :class="[ITEM_CLASS, currentMode === 'system' && 'bg-accent/15']"
              @select="setMode('system')"
            >
              <span class="text-fg-muted shrink-0"><Monitor :size="12" /></span>
              <span class="flex-1 truncate">System</span>
              <span v-if="currentMode === 'system'" class="text-accent text-[10px]">●</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <button class="icon-btn" :title="`Settings (${displayKeys('⌘,')})`" @click="$emit('openSettings')">
        <Settings :size="14" />
      </button>
    </div>
  </div>
</template>
