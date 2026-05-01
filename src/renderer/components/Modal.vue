<script setup lang="ts">
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  VisuallyHidden,
} from "reka-ui";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    align?: "center" | "top";
    contentClass?: string;
    /**
     * Stack this dialog above other modals. Default z-index for a modal is
     * 50; an `elevated` modal bumps to 60 so it paints above its parent.
     * Required for nested flows like "open SSH form from inside Settings"
     * — without this, the nested dialog can end up behind the modal it was
     * triggered from (Reka portals to body in component-tree order, not
     * activation order, so DOM ordering alone isn't a reliable tiebreaker).
     */
    elevated?: boolean;
  }>(),
  {
    align: "center",
    contentClass: "",
    description: "",
    elevated: false,
  },
);

const zClass = props.elevated ? "z-[60]" : "z-50";

const emit = defineEmits<{ close: [] }>();

function onOpenUpdate(value: boolean): void {
  if (!value) emit("close");
}
</script>

<template>
  <DialogRoot :open="open" @update:open="onOpenUpdate">
    <DialogPortal>
      <DialogOverlay :class="['fixed inset-0 bg-black/50 backdrop-blur-md', zClass]" />
      <DialogContent
        :class="[
          'fixed left-1/2 -translate-x-1/2 focus:outline-none',
          zClass,
          align === 'top' ? 'top-[14vh]' : 'top-1/2 -translate-y-1/2',
          contentClass,
        ]"
      >
        <VisuallyHidden>
          <DialogTitle>{{ title }}</DialogTitle>
          <!-- Always render the Description (even empty) so Reka stops warning
             "Missing `Description` or aria-describedby for DialogContent". An
             empty string is a valid description from the library's POV. -->
          <DialogDescription>{{ description }}</DialogDescription>
        </VisuallyHidden>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
