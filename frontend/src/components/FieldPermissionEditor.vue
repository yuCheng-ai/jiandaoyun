<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "./AppIcon.vue";
import {
  fields,
  changeFieldAccess,
  type NodeData,
  type PermissionColumn,
} from "../domain/workflow";
const props = defineProps<{
  data: NodeData;
  formFields?: { id: string; label: string }[];
}>();
const emit = defineEmits<{ update: [patch: Partial<NodeData>] }>();
const search = ref("");
const visibleFields = computed(() =>
  (props.formFields || fields.map((label) => ({ id: label, label }))).filter(
    (field) => field.label.includes(search.value.trim()),
  ),
);
const columns: { id: PermissionColumn; label: string }[] = [
  { id: "visible", label: "可见" },
  { id: "editable", label: "可编辑" },
  { id: "brief", label: "简报" },
];
function checked(field: string, column: PermissionColumn) {
  return column === "visible"
    ? props.data.permissions[field] !== "hidden"
    : column === "editable"
      ? props.data.permissions[field] === "edit"
      : props.data.briefFields.includes(field);
}
function allChecked(column: PermissionColumn) {
  return (
    visibleFields.value.length > 0 &&
    visibleFields.value.every((field) => checked(field.id, column))
  );
}
function mixed(column: PermissionColumn) {
  return (
    !allChecked(column) &&
    visibleFields.value.some((field) => checked(field.id, column))
  );
}
function change(selected: string[], column: PermissionColumn, event: Event) {
  emit(
    "update",
    changeFieldAccess(
      props.data,
      selected,
      column,
      (event.target as HTMLInputElement).checked,
    ),
  );
}
</script>

<template>
  <div class="field-search">
    <AppIcon name="search" :size="15" />
    <input v-model="search" aria-label="搜索字段" placeholder="搜索" />
    <button
      v-if="search"
      class="icon-button"
      aria-label="清空字段搜索"
      @click="search = ''"
    >
      <AppIcon name="close" :size="14" />
    </button>
  </div>
  <table class="permission-table">
    <thead>
      <tr>
        <th>字段</th>
        <th v-for="column in columns" :key="column.id">{{ column.label }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="visibleFields.length" class="permission-all">
        <td>全选</td>
        <td v-for="column in columns" :key="column.id">
          <input
            v-if="column.id !== 'brief'"
            type="checkbox"
            :aria-label="`全部字段 ${column.label}`"
            :checked="allChecked(column.id)"
            :indeterminate="mixed(column.id)"
            @change="
              change(
                visibleFields.map((f) => f.id),
                column.id,
                $event,
              )
            "
          />
        </td>
      </tr>
      <tr v-for="field in visibleFields" :key="field.id">
        <td>{{ field.label }}</td>
        <td v-for="column in columns" :key="column.id">
          <input
            type="checkbox"
            :aria-label="`${field.label} ${column.label}`"
            :checked="checked(field.id, column.id)"
            @change="change([field.id], column.id, $event)"
          />
        </td>
      </tr>
    </tbody>
  </table>
  <p v-if="!visibleFields.length" class="no-fields">没有匹配的字段</p>
</template>
