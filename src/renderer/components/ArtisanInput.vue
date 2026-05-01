<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { Terminal } from "lucide-vue-next";
import { useAppStore } from "../stores/app";
import { loadArtisanHistory, recordArtisanCommand, synthesizeArtisanCode } from "../lib/artisan";

/**
 * Always-visible artisan command bar that lives in the toolbar next to the
 * search-actions button. Visually mirrors that button's pill shell so the
 * two read as a pair.
 *
 * Disabled when the active tab points at a non-Laravel project — the
 * synthesized wrapper calls `app(\Illuminate\Contracts\Console\Kernel::class)`
 * which would error in a worker without the framework bootstrapped.
 *
 * Behaviour (when enabled):
 *  - Enter        → wrap and emit `run` with the synthesized PHP
 *  - ↑ / ↓        → cycle through localStorage history (last 20)
 */

const emit = defineEmits<{
    run: [code: string];
}>();

const store = useAppStore();
const { selectedTab, projects } = storeToRefs(store);

const enabled = computed(() => {
    const tab = selectedTab.value;
    if (!tab) return false;
    const proj = projects.value.find((p) => p.id === tab.projectId);
    return proj?.kind === "laravel";
});

const cmd = ref("");
const history = ref<string[]>(loadArtisanHistory());
const historyIdx = ref<number | null>(null);

function submit(): void {
    if (!enabled.value) return;
    const trimmed = cmd.value.trim();
    if (!trimmed) return;
    history.value = recordArtisanCommand(history.value, trimmed);
    emit("run", synthesizeArtisanCode(trimmed));
    cmd.value = "";
    historyIdx.value = null;
}

function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
        e.preventDefault();
        submit();
        return;
    }
    if (e.key === "ArrowUp") {
        if (history.value.length === 0) return;
        e.preventDefault();
        const next = historyIdx.value === null ? 0 : Math.min(historyIdx.value + 1, history.value.length - 1);
        historyIdx.value = next;
        cmd.value = history.value[next] ?? "";
        return;
    }
    if (e.key === "ArrowDown") {
        if (historyIdx.value === null) return;
        e.preventDefault();
        const next = historyIdx.value - 1;
        if (next < 0) {
            historyIdx.value = null;
            cmd.value = "";
        } else {
            historyIdx.value = next;
            cmd.value = history.value[next] ?? "";
        }
    }
}

function onInput(e: Event): void {
    cmd.value = (e.target as HTMLInputElement).value;
    // Any free-form edit detaches us from the history cursor so the next
    // ArrowUp starts from the most recent entry again.
    historyIdx.value = null;
}
</script>

<template>
    <!-- <label> instead of <div> so clicking anywhere in the pill (icon, prefix
       text, padding) focuses the nested input — no manual click handler needed.
       width: prefer 300px but allow shrinking down to 180px so the toolbar
       still fits on a narrow window before the OS chrome controls. -->
    <label
        :class="[
            'inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md bg-surface-2 border border-line text-[11px] transition-colors w-[300px] min-w-[180px] focus-within:border-accent/60',
            enabled ? 'hover:bg-surface-3 cursor-text' : 'opacity-50 cursor-not-allowed',
        ]"
        :title="enabled ? 'Run artisan command — Enter to run, ↑/↓ for history' : 'Switch to a Laravel project to run artisan commands'"
    >
        <Terminal :size="12" class="text-fg-muted shrink-0" />
        <span class="text-fg-subtle font-mono select-none shrink-0">php&nbsp;artisan</span>
        <input
            class="flex-1 min-w-0 bg-transparent font-mono text-fg placeholder:text-fg-subtle outline-none disabled:cursor-not-allowed"
            :value="cmd"
            :disabled="!enabled"
            placeholder="route:list"
            autocomplete="off"
            spellcheck="false"
            @input="onInput"
            @keydown="onKey"
        />
    </label>
</template>
