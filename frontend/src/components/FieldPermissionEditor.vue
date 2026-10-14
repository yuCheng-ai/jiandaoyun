<script setup lang="ts">
import { computed, ref } from "vue";
import type { FormField, ProcessTemplateTask } from "@platform/contracts";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  task: ProcessTemplateTask;
  fields: FormField[];
  readonly?: boolean;
}>();
const search = ref("");
const rows = computed(() =>
  props.fields
    .flatMap((field) => [
      { field, label: field.label, parent: undefined as FormField | undefined },
      ...field.children.map((child) => ({
        field: child,
        label: `${field.label} / ${child.label}`,
        parent: field,
      })),
    ])
    .filter(({ label }) => label.includes(search.value.trim())),
);
const columns = computed(() => {
  if (props.task.kind === "copy")
    return [{ id: "visible", label: "可见" }] as const;
  return [
    { id: "visible", label: "可见" },
    { id: "editable", label: "可编辑" },
    { id: "required", label: "必填" },
  ] as const;
});
type Column = "visible" | "editable" | "required";
type Row = (typeof rows.value)[number];
function visible(row: Row): boolean {
  return (
    row.field.visible &&
    props.task.fieldPermissions?.[row.field.id] !== "hidden" &&
    (!row.parent ||
      (row.parent.visible &&
        props.task.fieldPermissions?.[row.parent.id] !== "hidden"))
  );
}
function checked(row: Row, column: Column): boolean {
  if (column === "visible") return visible(row);
  if (column === "required")
    return props.task.requiredFields.includes(row.field.id);
  return (
    visible(row) &&
    row.field.editable &&
    props.task.fieldPermissions?.[row.field.id] !== "read" &&
    (!row.parent ||
      (row.parent.editable &&
        props.task.fieldPermissions?.[row.parent.id] !== "read"))
  );
}
function disabled(row: Row, column: Column): boolean {
  if (!row.field.visible || (row.parent && !row.parent.visible)) return true;
  if (row.parent && props.task.fieldPermissions?.[row.parent.id] === "hidden")
    return true;
  if (column === "visible") return false;
  if (!visible(row)) return true;
  if (column === "required")
    return (
      row.field.type === "subform" ||
      (!!props.task.subformId && row.parent?.id !== props.task.subformId)
    );
  return (
    !row.field.editable ||
    (!!row.parent &&
      (!row.parent.editable ||
        props.task.fieldPermissions?.[row.parent.id] === "read"))
  );
}
function change(row: Row, column: Column, enabled: boolean) {
  if (props.readonly || disabled(row, column)) return;
  const task = props.task;
  const id = row.field.id;
  if (column === "required") {
    task.requiredFields = task.requiredFields.filter((value) => value !== id);
    if (enabled) task.requiredFields.push(id);
    return;
  }
  task.fieldPermissions ||= {};
  if (column === "editable")
    task.fieldPermissions[id] = enabled ? "edit" : "read";
  else if (enabled) task.fieldPermissions[id] = "read";
  else {
    task.fieldPermissions[id] = "hidden";
    // 隐藏子表时一并取消子字段必填，避免生成无法完成的节点。
    const hidden = new Set([
      id,
      ...row.field.children.map((child) => child.id),
    ]);
    task.requiredFields = task.requiredFields.filter(
      (value) => !hidden.has(value),
    );
  }
}
function allChecked(column: Column) {
  const editableRows = rows.value.filter((row) => !disabled(row, column));
  return (
    editableRows.length > 0 && editableRows.every((row) => checked(row, column))
  );
}
function toggleAll(column: Column, enabled: boolean) {
  rows.value.forEach((row) => change(row, column, enabled));
}
</script>

<template>
  <div class="field-search">
    <AppIcon name="search" :size="15" />
    <input v-model="search" aria-label="搜索字段" placeholder="搜索字段" />
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
      <tr v-if="rows.length" class="permission-all">
        <td>全选</td>
        <td v-for="column in columns" :key="column.id">
          <input
            type="checkbox"
            :aria-label="`全部字段 ${column.label}`"
            :disabled="readonly"
            :checked="allChecked(column.id)"
            :indeterminate="
              !allChecked(column.id) &&
              rows.some((row) => checked(row, column.id))
            "
            @change="
              toggleAll(column.id, ($event.target as HTMLInputElement).checked)
            "
          />
        </td>
      </tr>
      <tr v-for="row in rows" :key="row.field.id">
        <td :title="row.label">{{ row.label }}</td>
        <td v-for="column in columns" :key="column.id">
          <input
            type="checkbox"
            :aria-label="`${row.label} ${column.label}`"
            :checked="checked(row, column.id)"
            :disabled="readonly || disabled(row, column.id)"
            @change="
              change(
                row,
                column.id,
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
        </td>
      </tr>
    </tbody>
  </table>
  <p v-if="!rows.length" class="no-fields">没有匹配的字段</p>
  <p class="field-hint">
    节点权限在表单权限范围内生效。{{
      task.kind === "copy" ? "抄送内容仅可查看。" : "子表可分别设置每列权限。"
    }}
  </p>
</template>
