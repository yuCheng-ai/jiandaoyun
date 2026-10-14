<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  maxSubformRows,
  subformFixedColumnIds,
  type FrontendFieldChange,
} from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  copy,
  type FormField,
  type FormSchema,
  type FormValues,
} from "../../../domain/form";
import { runtimeDefaults } from "../../../domain/relations";
import {
  blankSubformPlaceholder,
  parseSheetText,
  prepareSubformFill,
  sheetText,
  subformFillColumns,
  subformFillText,
  type SubformFillError,
  type SubformFillMode,
} from "../../../domain/subformQuickFill";

const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  values: FormValues;
  external?: boolean;
  mobile?: boolean;
  enabled: boolean;
  editable: (
    child: FormField,
    row: FormValues,
    index: number,
    mode: SubformFillMode,
  ) => boolean;
}>();
const emit = defineEmits<{
  close: [];
  apply: [
    rows: FormValues[],
    changes: FrontendFieldChange[],
    respond: (error?: string) => void,
  ];
}>();
const data = useRuntimeData();
const before = copy((props.values[props.field.id] || []) as FormValues[]);
const fieldBaseline = JSON.stringify(props.field);
const contexts = before.length
  ? before.map((row) => ({ ...props.values, ...row }))
  : [
      {
        ...props.values,
        ...runtimeDefaults(
          props.field.children,
          data.value,
          props.values,
          props.schema.fields,
        ),
      },
    ];
const addColumns = subformFillColumns(
  props.field,
  props.schema,
  contexts,
  "add",
  props.external,
);
const editColumns = subformFillColumns(
  props.field,
  props.schema,
  contexts,
  "edit",
  props.external,
);
const capacity =
  maxSubformRows -
  before.length +
  Number(blankSubformPlaceholder(props.field, before));
const mode = ref<SubformFillMode>(capacity > 0 ? "add" : "edit");
const columns = computed(() =>
  mode.value === "add" ? addColumns : editColumns,
);
const mappingField = computed<FormField>(() => ({
  ...props.field,
  type: "select",
  coloredOptions: false,
  allowCustomChoices: false,
  placeholder: "不粘贴",
  options: [
    { id: "", label: "不粘贴" },
    ...columns.value.map((column) => ({ id: column.key, label: column.label })),
  ],
}));
const grid = ref<string[][]>([]),
  mapping = ref<string[]>([]);
const step = ref<"input" | "mapping" | "errors">("input");
const errors = ref<SubformFillError[]>([]),
  message = ref("");
const panel = ref<HTMLElement>(),
  maximized = ref(false);
type Cell = { row: number; column: number };
const anchor = ref<Cell>({ row: 0, column: 0 }),
  end = ref<Cell>({ row: 0, column: 0 });
const selecting = ref(false),
  filling = ref(false);
let fillEnd = 0;
const history = ref<string[][][]>([]);
const range = computed(() => ({
  top: Math.min(anchor.value.row, end.value.row),
  bottom: Math.max(anchor.value.row, end.value.row),
  left: Math.min(anchor.value.column, end.value.column),
  right: Math.max(anchor.value.column, end.value.column),
}));
const width = computed(() =>
  Math.max(columns.value.length, ...grid.value.map((row) => row.length), 0),
);
const fixedColumnLayout = computed(() => {
  const ids = subformFixedColumnIds(props.field, props.mobile);
  const layout = new Map<number, { left: string }>();
  let left = 72;
  columns.value.forEach((column, index) => {
    // Readonly columns remain visible in edit mode but do not become fixed.
    if (
      ids.has(column.field.id) &&
      (mode.value === "add"
        ? props.editable(column.field, {}, 0, "add")
        : before.some((row, position) =>
            props.editable(column.field, row, position, "edit"),
          ))
    ) {
      layout.set(index, { left: `${left}px` });
      left += 180;
    }
  });
  return layout;
});
function selected(row: number, column: number) {
  const r = range.value;
  return (
    row >= r.top && row <= r.bottom && column >= r.left && column <= r.right
  );
}
function cellEditable(row: number, column: number) {
  const target = columns.value.find(
    (item) =>
      item.key ===
      (step.value === "input"
        ? columns.value[column]?.key
        : mapping.value[column]),
  );
  if (!props.enabled || !target)
    return (
      mode.value === "add" &&
      props.enabled &&
      column >= columns.value.length &&
      step.value === "input"
    );
  // A readonly source column never becomes a writable destination by remapping it.
  if (
    mode.value === "edit" &&
    !props.editable(columns.value[column]!.field, before[row]!, row, "edit")
  )
    return false;
  return props.editable(
    target.field,
    mode.value === "edit" ? before[row]! : {},
    row,
    mode.value,
  );
}
const mappedColumnCount = computed(
  () =>
    mapping.value.filter(
      (key, column) =>
        key &&
        (mode.value === "add"
          ? cellEditable(0, column)
          : before.some((_, row) => cellEditable(row, column))),
    ).length,
);
function checkpoint() {
  history.value.push(copy(grid.value));
  if (history.value.length > 100) history.value.shift();
  errors.value = [];
  message.value = "";
}
function reset(next: SubformFillMode) {
  mode.value = next;
  step.value = "input";
  errors.value = [];
  message.value = "";
  history.value = [];
  mapping.value = columns.value.map((column) => column.key);
  grid.value =
    next === "edit"
      ? before.map((row) =>
          columns.value.map((column) =>
            subformFillText(column, row, data.value),
          ),
        )
      : Array.from({ length: Math.min(8, capacity) }, () =>
          columns.value.map(() => ""),
        );
  anchor.value = { row: 0, column: 0 };
  end.value = { ...anchor.value };
  dismiss.markSaved();
}
const dismiss = useDraftDismiss(
  () => true,
  () => grid.value,
  () => emit("close"),
);
reset(mode.value);
function focusCell(row: number, column: number) {
  nextTick(() =>
    panel.value
      ?.querySelector<HTMLTextAreaElement>(`[data-cell="${row}:${column}"]`)
      ?.focus(),
  );
}
function selectCell(row: number, column: number, event: PointerEvent) {
  if (!event.shiftKey) anchor.value = { row, column };
  end.value = { row, column };
  selecting.value = true;
}
function selectLine(row?: number, column?: number) {
  anchor.value = { row: row ?? 0, column: column ?? 0 };
  end.value = {
    row: row ?? grid.value.length - 1,
    column: column ?? width.value - 1,
  };
  focusCell(anchor.value.row, anchor.value.column);
}
function enterCell(row: number, column: number) {
  if (filling.value) fillEnd = row;
  else if (selecting.value) end.value = { row, column };
}
function finishSelection() {
  if (filling.value && fillEnd > range.value.bottom) {
    checkpoint();
    const r = range.value;
    for (let row = r.bottom + 1; row <= fillEnd; row++)
      for (let column = r.left; column <= r.right; column++)
        if (cellEditable(row, column))
          grid.value[row]![column] =
            grid.value[
              r.top + ((row - r.bottom - 1) % (r.bottom - r.top + 1))
            ]![column] || "";
    end.value = { row: fillEnd, column: r.right };
  }
  selecting.value = false;
  filling.value = false;
}
onMounted(() => document.addEventListener("pointerup", finishSelection));
onBeforeUnmount(() =>
  document.removeEventListener("pointerup", finishSelection),
);
function changeCell(row: number, column: number, value: string) {
  if (!cellEditable(row, column)) return;
  checkpoint();
  const r = selected(row, column)
    ? range.value
    : { top: row, bottom: row, left: column, right: column };
  for (let y = r.top; y <= r.bottom; y++)
    for (let x = r.left; x <= r.right; x++)
      if (cellEditable(y, x)) grid.value[y]![x] = value;
  if (
    mode.value === "add" &&
    step.value === "input" &&
    row === grid.value.length - 1 &&
    grid.value.length < capacity
  )
    grid.value.push(Array.from({ length: width.value }, () => ""));
}
function paste(event: ClipboardEvent) {
  event.preventDefault();
  if (!props.enabled) return;
  const incoming = parseSheetText(
    event.clipboardData?.getData("text/plain") || "",
  );
  const r = range.value;
  if (mode.value === "add" && r.top + incoming.length > capacity) {
    message.value = `最多添加${maxSubformRows}行，请减少粘贴内容`;
    return;
  }
  const requiredWidth = r.left + Math.max(...incoming.map((row) => row.length));
  if (requiredWidth > 1200) {
    message.value = "粘贴列数过多，请核对复制范围";
    return;
  }
  checkpoint();
  if (mode.value === "add" && step.value === "input") {
    while (grid.value.length < r.top + incoming.length) grid.value.push([]);
    grid.value.forEach((row) => {
      while (row.length < requiredWidth) row.push("");
    });
    while (mapping.value.length < requiredWidth) mapping.value.push("");
  }
  const single = incoming.length === 1 && incoming[0]!.length === 1;
  const height = single ? r.bottom - r.top + 1 : incoming.length;
  const count = single
    ? r.right - r.left + 1
    : Math.max(...incoming.map((row) => row.length));
  for (let y = 0; y < height && r.top + y < grid.value.length; y++)
    for (let x = 0; x < count && r.left + x < width.value; x++)
      if (cellEditable(r.top + y, r.left + x))
        grid.value[r.top + y]![r.left + x] =
          incoming[single ? 0 : y]?.[single ? 0 : x] || "";
  end.value = {
    row: Math.min(r.top + height - 1, grid.value.length - 1),
    column: Math.min(r.left + count - 1, width.value - 1),
  };
}
function copySelection(event: ClipboardEvent) {
  event.preventDefault();
  const r = range.value;
  event.clipboardData?.setData(
    "text/plain",
    sheetText(
      grid.value
        .slice(r.top, r.bottom + 1)
        .map((row) => row.slice(r.left, r.right + 1)),
    ),
  );
}
function key(event: KeyboardEvent, row: number, column: number) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    const previous = history.value.pop();
    if (previous) {
      grid.value = previous;
      errors.value = [];
      message.value = "";
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectLine();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    changeCell(row, column, "");
    return;
  }
  const direction = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    Enter: [1, 0],
    Tab: [0, event.shiftKey ? -1 : 1],
  }[event.key];
  if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  const next = {
    row: Math.max(0, Math.min(grid.value.length - 1, row + direction[0]!)),
    column: Math.max(0, Math.min(width.value - 1, column + direction[1]!)),
  };
  if (!event.shiftKey || event.key === "Tab") anchor.value = next;
  end.value = next;
  focusCell(next.row, next.column);
}
function next() {
  message.value = "";
  if (mode.value === "add")
    grid.value = grid.value.filter((row) => row.some((value) => value.trim()));
  if (!grid.value.length) {
    message.value = "请先填写或粘贴数据";
    return;
  }
  while (mapping.value.length < width.value) mapping.value.push("");
  step.value = "mapping";
}
async function apply() {
  try {
    await nextTick();
    // 回填只校验当前表单上下文，旧浏览器工作空间与这次编辑无关。
    if (!props.enabled || fieldBaseline !== JSON.stringify(props.field))
      throw Error("明细权限或字段已变化，请关闭后重新打开快速填报");
    if (
      JSON.stringify(props.values[props.field.id] || []) !==
      JSON.stringify(before)
    )
      throw Error("原明细已变化，请关闭后重新打开快速填报");
    const result = prepareSubformFill({
      field: props.field,
      schema: props.schema,
      root: props.values,
      before,
      mode: mode.value,
      grid: grid.value,
      columns: columns.value,
      mapping: mapping.value,
      data: data.value,
      editable: props.editable,
    });
    if (result.errors.length && step.value !== "errors") {
      errors.value = result.errors;
      step.value = "errors";
      return;
    }
    emit("apply", result.rows, result.changes, (error) => {
      message.value = error || "";
    });
  } catch (error) {
    message.value = (error as Error).message;
  }
}
function cellError(row: number, column: number) {
  return errors.value.find(
    (error) => error.row === row && error.column === column,
  )?.message;
}
</script>
<template>
  <BaseDialog
    :open="true"
    title="快速填报"
    width="1080px"
    :class-name="`subform-quick-fill-dialog${maximized ? ' is-maximized' : ''}`"
    @close="dismiss.requestClose"
  >
    <template #header
      ><h2>快速填报</h2>
      <button
        type="button"
        class="icon-button"
        :aria-label="maximized ? '还原快速填报窗口' : '放大快速填报窗口'"
        @click="maximized = !maximized"
      >
        <AppIcon name="expand" /></button
    ></template>
    <div ref="panel" class="subform-fill-panel">
      <div v-if="step === 'input'" class="subform-fill-mode">
        <span>填报模式：</span>
        <label
          ><input
            type="radio"
            name="subform-fill-mode"
            :checked="mode === 'add'"
            :disabled="capacity <= 0 || !addColumns.length || !enabled"
            @change="reset('add')"
          />新增记录</label
        >
        <label
          ><input
            type="radio"
            name="subform-fill-mode"
            :checked="mode === 'edit'"
            :disabled="!before.length || !editColumns.length || !enabled"
            @change="reset('edit')"
          />编辑已有记录</label
        >
      </div>
      <p v-if="step === 'input'" class="muted subform-fill-hint">
        可将 Excel
        内容粘贴到表格中，也可直接编辑。支持复制、粘贴、撤销和方向键切换单元格。
      </p>
      <p v-else class="muted subform-fill-hint subform-fill-match">
        <span>调整对应字段，确认后数据将更新至「{{ field.label }}」中。</span>
        <span class="subform-fill-count" role="status"
          >粘贴 {{ mappedColumnCount }} 列 / 共 {{ width }} 列</span
        >
      </p>
      <p v-if="step === 'errors'" class="field-error" role="alert">
        {{ errors.length }}
        处内容不匹配，请修改后继续；未修改的无效内容将清空，多选字段保留匹配项。
      </p>
      <div class="subform-fill-grid-scroll">
        <table
          class="subform-fill-grid"
          :class="{ 'has-fixed-columns': !!fixedColumnLayout.size }"
          :style="{ minWidth: `${72 + width * 180}px` }"
          aria-label="快速填报表格"
        >
          <thead>
            <tr>
              <th
                :class="{ 'subform-fixed-column': !!fixedColumnLayout.size }"
                :style="fixedColumnLayout.size ? { left: '0px' } : undefined"
              >
                <button
                  type="button"
                  aria-label="选择所有单元格"
                  @click="selectLine()"
                >
                  {{ step === "input" ? "" : "表单字段" }}
                </button>
              </th>
              <th
                v-for="column in width"
                :key="column"
                :class="{
                  'subform-fixed-column': fixedColumnLayout.has(column - 1),
                }"
                :style="fixedColumnLayout.get(column - 1)"
              >
                <button
                  v-if="step === 'input'"
                  type="button"
                  :aria-label="`选择第${column}列`"
                  @click="selectLine(undefined, column - 1)"
                >
                  {{ columns[column - 1]?.label || `第${column}列` }}
                </button>
                <ChoiceFieldControl
                  v-else
                  :field="mappingField"
                  v-model="mapping[column - 1]"
                  :label="`第${column}列对应字段`"
                  :disabled-option-ids="
                    mapping.filter((key, index) => key && index !== column - 1)
                  "
                  :disabled="
                    !enabled ||
                    (mode === 'edit' &&
                      !before.some((row, index) =>
                        editable(
                          columns[column - 1]!.field,
                          row,
                          index,
                          'edit',
                        ),
                      ))
                  "
                  @update:model-value="
                    errors = [];
                    message = '';
                  "
                />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(cells, row) in grid" :key="row">
              <th
                :class="{ 'subform-fixed-column': !!fixedColumnLayout.size }"
                :style="fixedColumnLayout.size ? { left: '0px' } : undefined"
              >
                <button
                  type="button"
                  :aria-label="`选择第${row + 1}行`"
                  @click="selectLine(row)"
                >
                  {{ row + 1 }}
                </button>
              </th>
              <td
                v-for="column in width"
                :key="column"
                :class="{
                  selected: selected(row, column - 1),
                  readonly: !cellEditable(row, column - 1),
                  invalid: !!cellError(row, column - 1),
                  'subform-fixed-column': fixedColumnLayout.has(column - 1),
                }"
                :style="fixedColumnLayout.get(column - 1)"
                @pointerenter="enterCell(row, column - 1)"
              >
                <textarea
                  :data-cell="`${row}:${column - 1}`"
                  :aria-label="`第${row + 1}行 ${columns[column - 1]?.label || `第${column}列`}`"
                  :aria-invalid="!!cellError(row, column - 1)"
                  :title="cellError(row, column - 1)"
                  :readonly="!cellEditable(row, column - 1)"
                  :value="cells[column - 1] || ''"
                  rows="1"
                  @pointerdown="selectCell(row, column - 1, $event)"
                  @input="
                    changeCell(
                      row,
                      column - 1,
                      ($event.target as HTMLTextAreaElement).value,
                    )
                  "
                  @paste="paste"
                  @copy="copySelection"
                  @keydown="key($event, row, column - 1)"
                />
                <span
                  v-if="
                    selected(row, column - 1) &&
                    row === range.bottom &&
                    column - 1 === range.right &&
                    step === 'input'
                  "
                  class="subform-fill-handle"
                  title="向下拖动填充"
                  @pointerdown.prevent.stop="
                    filling = true;
                    fillEnd = row;
                  "
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="message" class="field-error" role="alert">{{ message }}</p>
      <div
        v-if="dismiss.confirmDiscard.value"
        class="config-discard"
        role="alertdialog"
        aria-label="放弃快速填报修改？"
        tabindex="-1"
      >
        <span>有尚未回填的修改。</span
        ><button
          type="button"
          class="text-button"
          @click="dismiss.confirmDiscard.value = false"
        >
          继续编辑</button
        ><button type="button" class="text-button" @click="dismiss.discard">
          放弃修改
        </button>
      </div>
    </div>
    <template #footer
      ><button
        v-if="step !== 'input'"
        type="button"
        class="button"
        @click="
          step = 'input';
          errors = [];
        "
      >
        上一步</button
      ><button
        type="button"
        class="button primary"
        :disabled="!enabled || !columns.length"
        @click="step === 'input' ? next() : apply()"
      >
        {{
          step === "input" ? "下一步" : step === "errors" ? "继续操作" : "确定"
        }}
      </button></template
    >
  </BaseDialog>
</template>
<style>
.subform-quick-fill-dialog {
  max-width: calc(100vw - 32px);
}
.subform-quick-fill-dialog.is-maximized {
  width: calc(100vw - 32px) !important;
}
.subform-quick-fill-dialog .dialog-header h2 {
  flex: 1;
}
.subform-quick-fill-dialog .dialog-body {
  padding: 16px 24px 0;
}
.subform-fill-panel {
  min-width: 0;
}
.subform-fill-mode {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
  margin-bottom: 16px;
}
.subform-fill-mode label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.subform-fill-hint {
  margin: 0 0 14px;
  line-height: 1.7;
}
.subform-fill-match {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.subform-fill-count {
  flex-shrink: 0;
  padding: 4px 8px;
  background: #edf8ed;
  color: #315b36;
  border-radius: 4px;
}
.subform-fill-grid-scroll {
  overflow: auto;
  height: min(440px, 55vh);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.is-maximized .subform-fill-grid-scroll {
  height: calc(100vh - 230px);
}
.subform-fill-grid {
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  width: 100%;
}
.subform-fill-grid th,
.subform-fill-grid td {
  min-width: 180px;
  position: relative;
  padding: 0;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.subform-fill-grid th:first-child {
  width: 72px;
  min-width: 72px;
  text-align: center;
  font-weight: 400;
}
.subform-fill-grid thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f1f3f6;
}
.subform-fill-grid .subform-fixed-column {
  position: sticky;
  z-index: 2;
  background: white;
}
.subform-fill-grid thead .subform-fixed-column {
  z-index: 3;
  background: #f1f3f6;
}
.subform-fill-grid th button {
  width: 100%;
  height: 42px;
  padding: 8px 12px;
  text-align: left;
  background: transparent;
  border: 0;
  color: inherit;
  border-radius: 0;
}
.subform-fill-grid th:first-child button {
  text-align: center;
}
.subform-fill-grid thead .choice-dropdown {
  margin: 4px 6px;
  width: calc(100% - 12px);
  max-width: none;
}
.subform-fill-grid td textarea {
  display: block;
  width: 100%;
  min-width: 0;
  height: 38px;
  min-height: 38px;
  padding: 9px 10px;
  resize: none;
  border: 0;
  border-radius: 0;
  background: transparent;
  font: inherit;
  box-shadow: none;
  outline: none;
}
.subform-fill-grid td.selected {
  background: #e9f7f6;
  box-shadow: inset 0 0 0 1px var(--teal);
}
.subform-fill-grid td:focus-within {
  box-shadow: inset 0 0 0 2px var(--teal);
}
.subform-fill-grid td.readonly {
  background: #f5f6f8;
  color: var(--muted);
}
.subform-fill-grid td.invalid {
  background: #fff0f0;
  box-shadow: inset 0 0 0 1px #e45454;
}
.subform-fill-handle {
  position: absolute;
  width: 8px;
  height: 8px;
  right: 0;
  bottom: 0;
  background: var(--teal);
  cursor: crosshair;
  z-index: 2;
}
@media (max-width: 650px) {
  .subform-quick-fill-dialog .dialog-body {
    padding: 12px 12px 0;
  }
  .subform-fill-grid-scroll {
    height: 50vh;
  }
}
</style>
