<script setup lang="ts">
import type { DatabaseDriver } from "../../../shared/ipc";
import SqliteIcon from "./SqliteIcon.vue";
import MysqlIcon from "./MysqlIcon.vue";
import PgsqlIcon from "./PgsqlIcon.vue";

/**
 * Per-driver brand icon dispatcher. Lets the database UI use one
 * `<DatabaseDriverIcon :driver="..." />` tag instead of a v-if chain
 * at every call site (the connection list and the toolbar dropdown).
 * Falls through to PgsqlIcon for the union-exhaustive branch since
 * `DatabaseDriver` is a closed union of three.
 */
withDefaults(defineProps<{ driver: DatabaseDriver; size?: number }>(), { size: 14 });
</script>

<template>
  <SqliteIcon v-if="driver === 'sqlite'" :size="size" />
  <MysqlIcon v-else-if="driver === 'mysql'" :size="size" />
  <PgsqlIcon v-else :size="size" />
</template>
