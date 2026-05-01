<script setup lang="ts">
import {
  ToastProvider,
  ToastPortal,
  ToastRoot,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastViewport,
} from "reka-ui";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { useToastStore } from "../stores/toasts";
import type { ToastVariant } from "../stores/toasts";

const store = useToastStore();
const { items } = storeToRefs(store);

const VARIANT_ICON = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: "border-success/40 bg-success/10 text-fg",
  error: "border-danger/40 bg-danger/10 text-fg",
  info: "border-info/40 bg-info/10 text-fg",
};

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-info",
};
</script>

<template>
  <ToastProvider>
    <ToastRoot
      v-for="toast in items"
      :key="toast.id"
      :duration="toast.duration ?? 0"
      :class="[
        'reka-toast w-[360px] max-w-[90vw] rounded-lg border px-4 py-3 shadow-xl backdrop-blur-md',
        VARIANT_CLASS[toast.variant],
      ]"
      @update:open="
        (open) => {
          if (!open) store.dismiss(toast.id);
        }
      "
    >
      <div class="flex items-start gap-3">
        <component
          :is="VARIANT_ICON[toast.variant]"
          :size="16"
          :class="['mt-[2px] shrink-0', VARIANT_ICON_CLASS[toast.variant]]"
        />
        <div class="flex-1 min-w-0">
          <ToastTitle class="text-[13px] font-medium text-fg">
            {{ toast.title }}
          </ToastTitle>
          <ToastDescription v-if="toast.description" class="mt-0.5 text-[12px] text-fg-muted break-words">
            {{ toast.description }}
          </ToastDescription>
        </div>
        <ToastClose as-child @click="store.dismiss(toast.id)">
          <button class="icon-btn text-fg-muted hover:text-fg" aria-label="Dismiss">
            <X :size="12" />
          </button>
        </ToastClose>
      </div>
    </ToastRoot>
    <ToastPortal>
      <ToastViewport class="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 outline-none" />
    </ToastPortal>
  </ToastProvider>
</template>

<style>
.reka-toast[data-state="open"] {
  animation: reka-toast-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.reka-toast[data-state="closed"] {
  animation: reka-toast-out 140ms cubic-bezier(0.4, 0, 1, 1) forwards;
}
.reka-toast[data-swipe="move"] {
  transform: translateX(var(--reka-toast-swipe-move-x, 0));
}
.reka-toast[data-swipe="cancel"] {
  transform: translateX(0);
  transition: transform 180ms ease-out;
}
.reka-toast[data-swipe="end"] {
  animation: reka-toast-out 140ms ease-out forwards;
}

@keyframes reka-toast-in {
  from {
    transform: translateX(calc(100% + 16px));
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
@keyframes reka-toast-out {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(calc(100% + 16px));
    opacity: 0;
  }
}
</style>
