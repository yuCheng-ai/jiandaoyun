<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "../AppIcon.vue";
import type { Department } from "../../domain/organization";
const props = withDefaults(
  defineProps<{
    departments: Department[];
    parentId?: string | null;
    selectedId?: string;
    query?: string;
    depth?: number;
    allowedIds?: string[];
  }>(),
  { parentId: null, query: "", depth: 0 },
);
const emit = defineEmits<{ select: [id: string] }>();
const collapsed = ref<string[]>([]);
function matches(id: string): boolean {
  const item = props.departments.find((d) => d.id === id);
  return (
    !!item &&
    (item.name.includes(props.query) ||
      props.departments.some((d) => d.parentId === id && matches(d.id)))
  );
}
const items = computed(() =>
  props.departments.filter(
    (d) =>
      !d.archived &&
      d.parentId === props.parentId &&
      (!props.query || matches(d.id)),
  ),
);
function hasChildren(id: string) {
  return props.departments.some((d) => d.parentId === id && !d.archived);
}
function toggle(id: string) {
  collapsed.value = collapsed.value.includes(id)
    ? collapsed.value.filter((i) => i !== id)
    : [...collapsed.value, id];
}
</script>
<template>
  <div class="organization-tree" role="group">
    <template v-for="item in items" :key="item.id">
      <div
        class="department-tree-row"
        :class="{ selected: selectedId === item.id }"
        :style="{ paddingLeft: 8 + depth * 18 + 'px' }"
      >
        <button
          v-if="hasChildren(item.id)"
          class="tree-expander"
          :aria-label="`${collapsed.includes(item.id) ? '展开' : '收起'}${item.name}`"
          @click="toggle(item.id)"
        >
          <AppIcon
            :name="collapsed.includes(item.id) ? 'right' : 'down'"
            :size="12"
          /></button
        ><span v-else class="tree-expander" />
        <button
          :disabled="allowedIds && !allowedIds.includes(item.id)"
          @click="emit('select', item.id)"
        >
          <AppIcon name="department" :size="16" /><span>{{ item.name }}</span>
        </button>
      </div>
      <DepartmentTree
        v-if="!collapsed.includes(item.id) || query"
        :departments="departments"
        :parent-id="item.id"
        :selected-id="selectedId"
        :query="query"
        :depth="depth + 1"
        :allowed-ids="allowedIds"
        @select="emit('select', $event)"
      />
    </template>
  </div>
</template>
