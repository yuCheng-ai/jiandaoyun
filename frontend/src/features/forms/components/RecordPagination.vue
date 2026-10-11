<script setup lang="ts">
import { computed } from "vue";
import {
  recordRowHeights,
  type RecordViewSettings,
  type RecordRowHeight,
} from "@platform/contracts";
const props = withDefaults(
  defineProps<{
    total: number;
    page: number;
    settings: RecordViewSettings;
    busy?: boolean;
    editable?: boolean;
  }>(),
  { editable: true },
);
const emit = defineEmits<{
  page: [value: number];
  change: [patch: Partial<RecordViewSettings>];
}>();
const pages = computed(() =>
  Math.max(1, Math.ceil(props.total / props.settings.pageSize)),
);
</script>
<template>
  <footer class="record-pagination">
    <span>共 {{ total }} 条</span>
    <template v-if="editable !== false">
      <label
        >行高<select
          aria-label="记录行高"
          :disabled="busy"
          :value="settings.rowHeight || 'low'"
          @change="
            emit('change', {
              rowHeight: ($event.target as HTMLSelectElement)
                .value as RecordRowHeight,
            })
          "
        >
          <option
            v-for="item in recordRowHeights"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </option>
        </select></label
      >
      <label
        >每页<select
          aria-label="每页记录数"
          :disabled="busy"
          :value="settings.pageSize"
          @change="
            emit('change', {
              pageSize: Number(($event.target as HTMLSelectElement).value) as
                10 | 20 | 50,
            })
          "
        >
          <option :value="10">10 条</option>
          <option :value="20">20 条</option>
          <option :value="50">50 条</option>
        </select></label
      >
    </template>
    <button
      class="button"
      :disabled="busy || page <= 1"
      @click="emit('page', page - 1)"
    >
      上一页
    </button>
    <span>{{ page }} / {{ pages }}</span>
    <button
      class="button"
      :disabled="busy || page >= pages"
      @click="emit('page', page + 1)"
    >
      下一页
    </button>
  </footer>
</template>
