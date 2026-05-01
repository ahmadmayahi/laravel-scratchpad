<script setup lang="ts">
import { computed, type Component } from "vue";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  ShieldCheck,
} from "lucide-vue-next";
import appIconUrl from "../assets/app-icon.png";
import type { SplashStep } from "../../shared/ipc";

/**
 * Multi-step boot splash. Each step renders its own row with an icon,
 * label, optional progress bar, and optional sub-detail line (e.g. the
 * latest composer line during skeleton provisioning).
 *
 * Steps come from `useBootSequence` which composes them from
 * laravel-ls download status + the latest skeleton's provisioning
 * state. `skip` / `retry` events apply to the laravel-ls step
 * (the only step with user-actionable error UI today).
 */

const props = defineProps<{
  steps: SplashStep[];
}>();

const emit = defineEmits<{
  retry: [];
  skip: [];
}>();

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

function progressLabel(step: SplashStep): string {
  if (!step.progress) return "";
  const { received, total } = step.progress;
  if (total > 0) return `${mb(received)} / ${mb(total)} MB`;
  return `${mb(received)} MB`;
}

function progressPercent(step: SplashStep): number {
  if (!step.progress) return 0;
  const { received, total } = step.progress;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((received / total) * 100));
}

function iconFor(step: SplashStep): Component {
  switch (step.state) {
    case "downloading":
      return Download;
    case "verifying":
      return ShieldCheck;
    case "ready":
      return CheckCircle2;
    case "error":
      return AlertTriangle;
    default:
      return Loader2;
  }
}

function iconClass(step: SplashStep): string {
  switch (step.state) {
    case "active":
    case "pending":
      return "animate-spin";
    default:
      return "";
  }
}

function labelFor(step: SplashStep): string {
  switch (step.state) {
    case "pending":
      return `${step.label} — waiting`;
    case "active":
      return step.id === "laravelLs" ? "Checking Laravel language server…" : step.label;
    case "downloading":
      return `Downloading ${step.label.toLowerCase()}`;
    case "verifying":
      return `Verifying ${step.label.toLowerCase()}…`;
    case "ready":
      return `${step.label} ready`;
    case "skipped":
      return `Continuing without ${step.label.toLowerCase()}`;
    case "error":
      return step.id === "laravelLs"
        ? "Couldn't download language server"
        : `${step.label} failed`;
  }
}

// laravel-ls is the only step with a user-actionable error UI today;
// surface its error message + Retry/Skip buttons. The skeleton step
// errors are non-blocking (the user sees them in the Laravel
// settings tab afterwards), so they're rendered as a quiet failure
// row without buttons.
const laravelLsError = computed(() =>
  props.steps.find((s) => s.id === "laravelLs" && s.state === "error"),
);
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-bg">
    <div class="flex flex-col items-center gap-5 max-w-[460px] w-full px-8 text-center">
      <img
        :src="appIconUrl"
        alt="Laravel ScratchPad"
        class="h-20 w-20 rounded-2xl shadow-[0_8px_24px_-8px_rgba(255,45,32,0.4)]"
      />

      <div class="text-[14px] font-semibold text-fg tracking-tight">Laravel ScratchPad</div>

      <div v-if="steps.length === 0" class="inline-flex items-center gap-2 text-[12px] text-fg-muted">
        <Loader2 :size="12" class="animate-spin" />
        <span>Loading…</span>
      </div>

      <div v-else class="w-full flex flex-col gap-3">
        <div
          v-for="step in steps"
          :key="step.id"
          class="flex flex-col items-center gap-1.5"
        >
          <div
            class="inline-flex items-center gap-2 text-[12px]"
            :class="step.state === 'error' ? 'text-danger' : 'text-fg-muted'"
          >
            <component :is="iconFor(step)" :size="12" :class="iconClass(step)" />
            <span>{{ labelFor(step) }}</span>
          </div>

          <template v-if="step.state === 'downloading' || (step.state === 'active' && step.id === 'skeleton')">
            <div class="mt-1 w-64 h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div
                v-if="step.progress"
                class="h-full bg-accent transition-[width] duration-100 ease-out"
                :style="{ width: progressPercent(step) + '%' }"
              />
              <div v-else class="h-full bg-accent/60 indeterminate-bar" />
            </div>
            <div v-if="step.progress" class="text-[11px] text-fg-subtle tabular-nums mt-1">
              {{ progressLabel(step)
              }}<span v-if="progressPercent(step) > 0"> · {{ progressPercent(step) }}%</span>
            </div>
          </template>

          <p
            v-if="step.detail && step.state !== 'error'"
            class="text-[11px] text-fg-subtle font-mono leading-snug max-w-[420px] truncate w-full"
            :title="step.detail"
          >
            {{ step.detail }}
          </p>
        </div>
      </div>

      <template v-if="laravelLsError">
        <p class="text-[11px] text-fg-muted leading-relaxed">
          {{ laravelLsError.detail }}
        </p>
        <div class="flex items-center gap-2">
          <button class="btn-subtle" @click="emit('skip')">Continue without it</button>
          <button class="btn-primary" @click="emit('retry')">Retry</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.indeterminate-bar {
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--accent) 30%,
    var(--accent) 70%,
    transparent 100%
  );
  background-size: 50% 100%;
  background-repeat: no-repeat;
  animation: indeterminate 1.4s ease-in-out infinite;
}
@keyframes indeterminate {
  0% {
    background-position: -50% 0;
  }
  100% {
    background-position: 150% 0;
  }
}
</style>
