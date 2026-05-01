<script setup lang="ts">
import { Lightbulb, Sparkles } from "lucide-vue-next";
import { displayKeys } from "../../lib/shortcuts";

defineEmits<{ pickSnippet: [code: string] }>();

const starterSnippets = [
  {
    title: "Collection helpers",
    preview: "collect([1,2,3])->sum();",
    code: "collect([1, 2, 3, 4, 5])->map(fn ($n) => $n * 2)->sum();\n",
  },
  {
    title: "Count users",
    preview: "App\\Models\\User::count();",
    code: "App\\Models\\User::count();\n",
  },
  {
    title: "Recent users",
    preview: "User::latest()->take(3)->get();",
    code: "App\\Models\\User::latest()->take(3)->get();\n",
  },
  {
    title: "Carbon date math",
    preview: "now()->addDays(7)->diffForHumans();",
    code: "now()->addDays(7)->diffForHumans();\n",
  },
];
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center px-6 py-8 text-center">
    <div
      class="mb-4 h-12 w-12 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30 flex items-center justify-center"
    >
      <Sparkles :size="20" class="text-accent" />
    </div>
    <h3 class="text-[15px] font-semibold text-fg mb-1">Run your code</h3>
    <p class="text-[12px] text-fg-muted mb-5">
      Press <span class="kbd">{{ displayKeys("⌘R") }}</span> to execute against the selected connection.
    </p>

    <div class="w-full max-w-sm space-y-1.5">
      <div class="text-[10px] font-medium uppercase tracking-wider text-fg-subtle text-left mb-1">
        <Lightbulb :size="10" class="inline mr-1" />
        Starter snippets
      </div>
      <button
        v-for="s in starterSnippets"
        :key="s.title"
        class="w-full text-left px-3 py-2 rounded-md bg-surface-2 border border-line hover:bg-surface-3 hover:border-line transition-colors cursor-default"
        @click="$emit('pickSnippet', s.code)"
      >
        <div class="text-[12px] text-fg">{{ s.title }}</div>
        <code class="text-[11px] text-fg-muted font-mono">{{ s.preview }}</code>
      </button>
    </div>
  </div>
</template>
