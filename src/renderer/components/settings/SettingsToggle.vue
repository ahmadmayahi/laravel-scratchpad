<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { cn } from "../../lib/cn";
import SettingsRow from "./SettingsRow.vue";

defineProps<{
  label: string;
  hint?: string;
  modelValue: boolean;
}>();

defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <SettingsRow :label="label" :hint="hint">
    <SwitchRoot
      :model-value="modelValue"
      :class="
        cn(
          'relative h-[22px] w-[38px] rounded-full transition-colors cursor-default',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          'data-[state=checked]:bg-accent',
          'data-[state=unchecked]:bg-surface-3 data-[state=unchecked]:ring-1 data-[state=unchecked]:ring-inset data-[state=unchecked]:ring-line',
        )
      "
      @update:model-value="(v) => $emit('update:modelValue', v)"
    >
      <SwitchThumb
        :class="
          cn(
            'block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform will-change-transform',
            'translate-x-[3px] data-[state=checked]:translate-x-[19px]',
          )
        "
      />
    </SwitchRoot>
  </SettingsRow>
</template>
