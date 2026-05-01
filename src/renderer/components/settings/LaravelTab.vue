<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RotateCw, Trash2, CheckCircle2, AlertTriangle, Loader2, Lock } from "lucide-vue-next";
import type { Skeleton, SkeletonSlug, SkeletonStatusEvent } from "../../../shared/ipc";
import { SKELETON_SLUGS } from "../../../shared/ipc";

/**
 * Laravel-version checkbox list. Ticking a row kicks off
 * `composer create-project` in the main process; unticking deletes
 * the skeleton row AND its folder on disk in one shot — no confirm.
 * `latest` is always present and can't be removed; its row shows a
 * lock icon where the delete button otherwise sits, and the ↻ button
 * re-provisions to pull in the newest stable release.
 */

const skeletons = ref<Map<SkeletonSlug, Skeleton>>(new Map());

const LABEL: Record<SkeletonSlug, string> = {
  latest: "Latest stable",
  "13.x": "Laravel 13.x",
  "12.x": "Laravel 12.x",
  "11.x": "Laravel 11.x",
  "10.x": "Laravel 10.x",
  "9.x": "Laravel 9.x",
};

function refresh(): Promise<void> {
  return window.lsp.skeletonsList().then((rows) => {
    const next = new Map<SkeletonSlug, Skeleton>();
    for (const r of rows) next.set(r.slug, r);
    skeletons.value = next;
  });
}

let offStatus: (() => void) | null = null;

onMounted(async () => {
  await refresh();
  offStatus = window.lsp.onSkeletonStatus((event: SkeletonStatusEvent) => {
    // The provisioner's events tell us *what* changed; easier to
    // re-list the whole table than to reconcile an in-place patch
    // (six rows, not worth the extra code).
    void refresh();
    void event;
  });
});

onBeforeUnmount(() => offStatus?.());

function rowFor(slug: SkeletonSlug): Skeleton | undefined {
  return skeletons.value.get(slug);
}

// Hide the explicit `<major>.x` row when `latest` already resolves to that
// major — the two would point at the same release and just confuse the user.
const visibleSlugs = computed<readonly SkeletonSlug[]>(() => {
  const latestVersion = skeletons.value.get("latest")?.installedVersion;
  const latestMajor = latestVersion?.split(".")[0];
  if (!latestMajor) return SKELETON_SLUGS;
  return SKELETON_SLUGS.filter((s) => s !== `${latestMajor}.x`);
});

function busy(slug: SkeletonSlug): boolean {
  return rowFor(slug)?.status === "provisioning";
}

async function onTick(slug: SkeletonSlug, checked: boolean): Promise<void> {
  if (slug === "latest") return;
  if (checked) {
    await window.lsp.skeletonsSelect(slug);
  } else {
    // No confirm — unticking always removes the row AND wipes the
    // folder. Storage hygiene wins over the "keep the folder for
    // manual inspection" fallback path we used to expose.
    await window.lsp.skeletonsRemove(slug, true);
  }
  await refresh();
}

async function reprovision(slug: SkeletonSlug): Promise<void> {
  await window.lsp.skeletonsReprovision(slug);
  await refresh();
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h3 class="font-medium text-fg mb-1">Laravel skeletons</h3>
      <p class="text-[12px] text-fg-muted">
        Pick the versions you want to tinker with. <span class="text-fg">Latest</span> is always kept available.
      </p>
    </div>

    <div class="border border-line rounded-lg divide-y divide-line overflow-hidden">
      <div v-for="slug in visibleSlugs" :key="slug" class="px-3 py-2.5 flex items-center gap-3 text-xs">
        <input
          type="checkbox"
          class="accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed"
          :checked="rowFor(slug) !== undefined"
          :disabled="slug === 'latest' || busy(slug)"
          @change="onTick(slug, ($event.target as HTMLInputElement).checked)"
        />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-fg font-medium">{{ LABEL[slug] }}</span>
            <span v-if="rowFor(slug)?.installedVersion" class="text-[10px] text-fg-muted font-mono">{{
              rowFor(slug)?.installedVersion
            }}</span>
          </div>
          <div class="text-[11px] mt-0.5">
            <template v-if="!rowFor(slug)">
              <span class="text-fg-muted">Not provisioned</span>
            </template>
            <template v-else-if="rowFor(slug)?.status === 'provisioning'">
              <span class="inline-flex items-center gap-1.5 text-accent">
                <Loader2 :size="10" class="animate-spin" />
                Provisioning…
              </span>
            </template>
            <template v-else-if="rowFor(slug)?.status === 'ready'">
              <span class="inline-flex items-center gap-1.5 text-success">
                <CheckCircle2 :size="10" />
                Ready
              </span>
            </template>
            <template v-else>
              <span class="inline-flex items-center gap-1.5 text-danger" :title="rowFor(slug)?.error ?? ''">
                <AlertTriangle :size="10" />
                Failed — {{ rowFor(slug)?.error ?? "unknown error" }}
              </span>
            </template>
          </div>
        </div>

        <button
          v-if="rowFor(slug)"
          class="icon-btn disabled:opacity-40"
          :disabled="busy(slug)"
          :title="rowFor(slug)?.status === 'failed' ? 'Retry provisioning' : 'Reprovision (pull newest release)'"
          @click="reprovision(slug)"
        >
          <RotateCw :size="12" />
        </button>
        <button
          v-if="rowFor(slug) && slug !== 'latest'"
          class="icon-btn disabled:opacity-40 text-danger hover:opacity-80"
          :disabled="busy(slug)"
          title="Remove skeleton"
          @click="onTick(slug, false)"
        >
          <Trash2 :size="12" />
        </button>
        <span
          v-else-if="slug === 'latest'"
          class="icon-btn opacity-50 cursor-default"
          title="The latest skeleton can't be removed"
        >
          <Lock :size="12" />
        </span>
      </div>
    </div>

    <p class="text-[11px] text-fg-muted">
      Requires <code class="font-mono">composer</code> on your PATH. Provisioning typically takes 1–3 minutes per
      version.
    </p>
  </div>
</template>
