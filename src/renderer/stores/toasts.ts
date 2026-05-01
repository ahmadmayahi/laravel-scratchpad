import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastVariant = "success" | "error" | "info";

interface Toast {
    id: string;
    variant: ToastVariant;
    title: string;
    /** Optional secondary line, rendered below the title. */
    description?: string;
    /** Auto-dismiss delay in ms. Null keeps the toast up until the user closes it. */
    duration: number | null;
}

function uuid(): string {
    return (crypto as { randomUUID?: () => string }).randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/**
 * Tiny toast queue, rendered by `ToastContainer.vue` via reka-ui's Toast
 * primitives. Anywhere in the app can push a toast with
 * `useToastStore().push({ ... })` — the viewport is mounted once at the
 * root of App.vue.
 */
export const useToastStore = defineStore("toasts", () => {
    const items = ref<Toast[]>([]);

    function push(input: {
        variant?: ToastVariant;
        title: string;
        description?: string;
        /** Set to `null` for manual-dismiss only. Default 4000 ms. */
        duration?: number | null;
    }): string {
        const toast: Toast = {
            id: uuid(),
            variant: input.variant ?? "info",
            title: input.title,
            description: input.description,
            duration: input.duration === undefined ? 4000 : input.duration,
        };
        items.value = [...items.value, toast];
        return toast.id;
    }

    function dismiss(id: string): void {
        items.value = items.value.filter((t) => t.id !== id);
    }

    return { items, push, dismiss };
});
