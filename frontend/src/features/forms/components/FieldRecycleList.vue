<script setup lang="ts">
import type { RecycledField } from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import { fieldRegistry } from "../../../domain/form";
defineProps<{ items: RecycledField[] }>();
defineEmits<{ restore: [index: number] }>();
</script>
<template>
  <div
    v-for="(item, index) in items"
    :key="item.field.id + '-' + index"
    class="recycled-field"
  >
    <AppIcon
      :name="
        fieldRegistry.find((field) => field.type === item.field.type)?.icon ||
        'form'
      "
    />
    <span>{{ item.field.label }}</span
    ><button class="text-button" @click="$emit('restore', index)">恢复</button>
  </div>
  <p v-if="!items.length" class="dialog-description">暂无已删除字段。</p>
</template>
