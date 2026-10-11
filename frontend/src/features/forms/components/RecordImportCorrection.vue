<script setup lang="ts">
import { computed } from "vue";
import {
  emptyFieldValue,
  addressParts,
  isAddressValue,
} from "@platform/contracts";
import FieldControl from "./FieldControl.vue";
import {
  createField,
  type FormField,
  type FormValues,
} from "../../../domain/form";
import type { FormRecord } from "../../../domain/workspace";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  memberImportColumns,
  type ImportRow,
  type RecordImportRequest,
} from "../../../domain/recordImport";

const props = defineProps<{
  form: FormRecord;
  request: RecordImportRequest;
  rows: ImportRow[];
  disabled?: boolean;
}>();
const emit = defineEmits<{
  change: [
    field: FormField,
    value: unknown,
    row: number,
    column: number,
    lastRow: number,
  ];
}>();
const data = useRuntimeData();
function completeAddress(
  binding: RecordImportRequest["mapping"][number],
  field: FormField,
) {
  return (
    field.type === "address" &&
    addressParts(field).every((part) =>
      props.request.mapping.some(
        (m) =>
          m.fieldId === binding.fieldId &&
          m.parentId === binding.parentId &&
          m.addressPart === part,
      ),
    )
  );
}
const columns = computed(() => {
  const allowed = memberImportColumns(
    props.form,
    props.request.mode,
    data.value,
    props.request.member,
  );
  return props.request.mapping.flatMap((binding) => {
    if (binding.fieldId === "data_id") return [{ binding, label: "data_id" }];
    const column = allowed.find(
      (c) =>
        c.field.id === binding.fieldId &&
        c.parent?.id === binding.parentId &&
        c.addressPart === binding.addressPart,
    );
    // The correction uses one existing address picker, not four repeated controls.
    if (
      binding.addressPart &&
      column &&
      completeAddress(binding, column.field) &&
      props.request.mapping.find((m) => m.fieldId === binding.fieldId)
        ?.column !== binding.column
    )
      return [];
    return column
      ? [
          {
            binding,
            label:
              column.addressPart && completeAddress(binding, column.field)
                ? `${column.parent ? `${column.parent.label} · ` : ""}${column.field.label}`
                : column.label,
          },
        ]
      : [];
  });
});
const groups = computed(() =>
  props.rows.map((row) => {
    const entry = data.value.entries.find((e) => e.id === row.id);
    const definition = entry
      ? props.form.versions.find((v) => v.version === entry.definitionVersion)
      : props.form.published;
    const original =
      definition &&
      memberImportColumns(
        props.form,
        props.request.mode,
        data.value,
        props.request.member,
        definition.schema,
      );
    return {
      ...row,
      fields: definition?.schema.fields || [],
      physicalRows: Array.from(
        { length: (row.lastRow || row.row) - row.row + 1 },
        (_, i) => row.row + i,
      ),
      columns: columns.value.map(({ binding, label }) => {
        const field =
          binding.fieldId === "data_id"
            ? createField("text", { id: "data_id", label: "data_id" })
            : original?.find(
                (c) =>
                  c.field.id === binding.fieldId &&
                  c.parent?.id === binding.parentId &&
                  c.field.type === binding.type,
              )?.field;
        return { binding, label, field };
      }),
    };
  }),
);
type Group = (typeof groups.value)[number];
type Column = Group["columns"][number];
function values(group: Group, column: Column, row: number): FormValues {
  if (!column.binding.parentId) return group.values || {};
  const bindings = props.request.mapping.filter(
    (m) => m.parentId === column.binding.parentId,
  );
  if (
    bindings.every((m) =>
      emptyFieldValue(
        props.request.rows[row - props.request.firstRow]?.[m.column],
      ),
    )
  )
    return group.values || {};
  const children = (group.values?.[column.binding.parentId] ||
    []) as FormValues[];
  let index = -1;
  for (let physical = group.row; physical <= row; physical++) {
    const cells = props.request.rows[physical - props.request.firstRow]!;
    if (bindings.some((m) => !emptyFieldValue(cells[m.column]))) index++;
  }
  return { ...group.values, ...(children[index] || {}) };
}
function raw(column: Column, row: number) {
  return (
    props.request.rows[row - props.request.firstRow]?.[column.binding.column] ??
    null
  );
}
function controlField(column: Column, row: number) {
  const field = column.field!;
  return {
    ...field,
    // Table cells keep the same value/options while using compact field controls.
    type:
      column.binding.addressPart && !completeAddress(column.binding, field)
        ? "text"
        : (
            {
              radio: "select",
              checkbox: "multiselect",
              textarea: "text",
            } as Partial<Record<FormField["type"], FormField["type"]>>
          )[field.type] || field.type,
    editable: true,
    placeholder:
      field.type === "address"
        ? field.placeholder
        : String(raw(column, row) ?? ""),
  };
}
function cellValue(group: Group, column: Column, row: number) {
  if (column.binding.fieldId === "data_id") return raw(column, row);
  const value = values(group, column, row)[column.binding.fieldId];
  return column.binding.addressPart &&
    column.field &&
    !completeAddress(column.binding, column.field)
    ? isAddressValue(value)
      ? value[column.binding.addressPart]
      : raw(column, row)
    : value;
}
function change(group: Group, column: Column, row: number, value: unknown) {
  if (
    column.binding.addressPart &&
    column.field &&
    !completeAddress(column.binding, column.field)
  ) {
    const original = values(group, column, row)[column.binding.fieldId];
    value = {
      ...(isAddressValue(original) ? original : {}),
      [column.binding.addressPart]: String(value ?? ""),
    };
  }
  emit(
    "change",
    column.field!,
    value,
    row - props.request.firstRow,
    column.binding.column,
    column.binding.parentId
      ? row - props.request.firstRow
      : (group.lastRow || group.row) - props.request.firstRow,
  );
}
function cellIssues(group: Group, column: Column, row: number) {
  return (
    group.issues?.filter(
      (issue) => issue.fieldId === column.binding.fieldId && issue.row === row,
    ) || []
  );
}
</script>
<template>
  <div class="import-correction-scroll">
    <table class="import-correction-table" aria-label="修改失败数据">
      <thead>
        <tr>
          <th>错误详情</th>
          <th v-for="column in columns" :key="column.binding.column">
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="group in groups" :key="group.row">
          <tr v-for="row in group.physicalRows" :key="row">
            <th
              v-if="row === group.row"
              :rowspan="group.physicalRows.length"
              class="import-correction-errors"
            >
              <small
                >Excel 第 {{ group.row
                }}{{ group.lastRow ? `—${group.lastRow}` : "" }} 行</small
              >
              <ul v-if="group.issues?.length">
                <li v-for="(issue, index) in group.issues" :key="index">
                  {{ issue.message }}
                </li>
              </ul>
              <p v-else-if="group.kind === 'error'">{{ group.message }}</p>
            </th>
            <template
              v-for="column in group.columns"
              :key="column.binding.column"
            >
              <td
                v-if="column.binding.parentId || row === group.row"
                :rowspan="
                  column.binding.parentId ? 1 : group.physicalRows.length
                "
                :class="{ 'has-error': cellIssues(group, column, row).length }"
                :title="
                  cellIssues(group, column, row)
                    .map((i) => i.message)
                    .join('；')
                "
              >
                <FieldControl
                  :fields="group.fields"
                  v-if="column.field"
                  :field="controlField(column, row)"
                  :model-value="cellValue(group, column, row)"
                  :values="values(group, column, row)"
                  :entry-id="group.id"
                  :label="`Excel 第 ${row} 行 ${column.label}`"
                  :edit-serial="true"
                  :disabled="
                    disabled || (column.field.type === 'serial' && !group.id)
                  "
                  @update:model-value="change(group, column, row, $event)"
                />
                <span v-else>{{ raw(column, row) }}</span>
              </td>
            </template>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.import-correction-scroll {
  overflow: auto;
  min-height: 0;
  flex: 1;
  margin: 18px 18px 0;
  border: 1px solid #e3e7ed;
  border-radius: 3px;
}
.import-correction-table {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
  min-width: 100%;
}
th,
td {
  border-right: 1px solid #e3e7ed;
  border-bottom: 1px solid #e3e7ed;
  padding: 0;
  text-align: left;
  min-width: 200px;
  height: 42px;
  vertical-align: top;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 0 12px;
  background: #f3f5f8;
  color: #526176;
  font-weight: 500;
}
th:first-child {
  position: sticky;
  left: 0;
  min-width: 224px;
  width: 224px;
  max-width: 280px;
  z-index: 1;
  background: white;
}
thead th:first-child {
  z-index: 3;
  background: #f3f5f8;
}
.import-correction-errors {
  padding: 10px 12px;
  vertical-align: top;
  color: #263345;
  font-weight: 400;
}
.import-correction-errors small {
  color: #8490a1;
  font-size: 11px;
}
.import-correction-errors ul {
  margin: 5px 0 0;
  padding: 0;
  list-style: none;
  line-height: 1.6;
}
.import-correction-errors p {
  margin: 5px 0 0;
}
td.has-error {
  background: #fff2f1;
  box-shadow: inset 0 0 0 1px #ed8580;
}
.import-correction-table
  td
  :deep(
    :is(
      input,
      select,
      textarea,
      .identity-input,
      .relation-control,
      .number-control
    )
  ) {
  border: 1px solid transparent;
  background: transparent;
  border-radius: 0;
  width: 100%;
  min-height: 40px;
}
.import-correction-table td :deep(:is(input, select, textarea)) {
  padding: 8px 12px;
}
td :deep(.identity-open) {
  padding: 8px 12px;
  color: var(--teal);
}
.import-correction-table
  td
  :deep(
    :is(
      input:focus,
      select:focus,
      textarea:focus,
      .identity-input:focus-within,
      .relation-control:focus-within
    )
  ) {
  border-color: var(--teal);
  outline: none;
  background: white;
}
td :deep(.number-control input) {
  border: 0;
}
td :deep(.muted) {
  color: inherit;
}
</style>
