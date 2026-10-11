<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import RecordImportCorrection from "./RecordImportCorrection.vue";
import { runtimeDataKey } from "../../../composables/useRuntimeData";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useWorkspaceStore } from "../../../stores/workspace";
import { copy, type FormField } from "../../../domain/form";
import type { FormRecord } from "../../../domain/workspace";
import {
  importRelationFields,
  importExcelLayout,
  importHeaderRows,
  importHeaders,
  suggestImportMapping,
  prepareImportRows,
  type ImportMode,
  type RecordImportRequest,
  type ImportResult,
  type ImportMapping,
  recognizeImportTemplate,
  recordImportModes,
  memberImportColumns,
  importExcelValue,
  importFieldKey,
  type MemberImportScope,
} from "../../../domain/recordImport";
import { groupsForEntry, memberContext } from "../../../domain/access";
import {
  readExcel,
  downloadExcel,
  type ExcelSheet,
  type ExcelValue,
} from "../../../services/excel";

const props = defineProps<{ form: FormRecord; member?: MemberImportScope }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useWorkspaceStore(),
  form = copy(props.form);
const runtime = computed(() =>
  props.member ? memberContext(store.data, props.member.actorId) : store.data,
);
provide(runtimeDataKey, runtime);
const initialEntries = ref(
  copy(store.data.entries.filter((e) => e.formId === form.id)),
);
const targetIds = ref(new Set<string>());
const modes = ref(recordImportModes(form, store.data, props.member));
const catalogs = ref({
  create: memberImportColumns(form, "create", store.data, props.member),
  update: memberImportColumns(form, "update", store.data, props.member),
  both: memberImportColumns(form, "both", store.data, props.member),
});
function captureTargets() {
  targetIds.value = new Set(
    initialEntries.value
      .filter(
        (e) =>
          !props.member ||
          groupsForEntry(
            store.data,
            e,
            props.member.actorId,
            props.member.selection,
          ).some(
            (g) => g.actions.includes("import") && g.actions.includes("edit"),
          ),
      )
      .map((e) => e.id),
  );
}
captureTargets();
const mode = ref<ImportMode>("create"),
  validate = ref(!!props.member),
  triggerWorkflow = ref(!!props.member && form.kind === "workflow"),
  step = ref(1);
const fileInput = ref<HTMLInputElement>(),
  filename = ref(""),
  sheets = ref<ExcelSheet[]>([]),
  sheetIndex = ref(0),
  header = ref(0),
  mapping = ref<string[]>([]);
const relationMatches = ref<Record<string, string>>({});
const loading = ref(false),
  error = ref(""),
  result = ref<ImportResult>();
const needsReview = ref(false),
  reviewNotice = ref("");
const correcting = ref(false);
const onlyRows = ref<number[]>();
const corrections = ref<Record<number, Record<number, ExcelValue>>>({});
let savedCorrections: typeof corrections.value = {};
const sheet = computed(() => sheets.value[sheetIndex.value]);
const catalog = computed(() => catalogs.value[mode.value]);
const fields = computed(() =>
  catalog.value.filter((c) => mode.value !== "update" || !c.parent),
);
const mappedColumns = computed(() =>
  mapping.value.map((id) =>
    fields.value.find(
      (column) => importFieldKey(column.field.id, column.addressPart) === id,
    ),
  ),
);
function relationChoices(index: number) {
  const field = mappedColumns.value[index]?.field;
  if (field?.type !== "relation") return [];
  const name =
    store.data.forms.find((form) => form.id === field.referenceFormId)?.title ||
    "主表";
  return importRelationFields(field, store.data, props.member?.actorId).map(
    (field) => ({
      id: field.id,
      label: `${name}-${field.label}`,
    }),
  );
}
const headerCount = computed(() =>
  sheet.value ? importHeaderRows(sheet.value, header.value) : 1,
);
const dataStart = computed(() => header.value + headerCount.value);
const rows = computed(() =>
  (sheet.value?.rows.slice(dataStart.value) || []).map((row, index) => {
    if (!corrections.value[index]) return row;
    const edited = [...row];
    for (const [column, value] of Object.entries(corrections.value[index]!))
      edited[Number(column)] = value;
    return edited;
  }),
);
const headers = computed(() =>
  sheet.value ? importHeaders(sheet.value, header.value) : [],
);
const dismiss = useDraftDismiss(
  () => true,
  () => ({
    filename: filename.value,
    mode: mode.value,
    validate: validate.value,
    triggerWorkflow: triggerWorkflow.value,
    sheet: sheetIndex.value,
    header: header.value,
    mapping: mapping.value,
    relationMatches: relationMatches.value,
    corrections: corrections.value,
  }),
  () => {
    if (correcting.value) {
      corrections.value = copy(savedCorrections);
      correcting.value = false;
      onlyRows.value = undefined;
      error.value = "";
    } else emit("close");
  },
);
watch(sheet, (value) => {
  header.value = value?.headerRow || 0;
  match();
});
watch(header, match);
watch(mode, () => {
  if (mode.value === "update") triggerWorkflow.value = false;
  else if (props.member && form.kind === "workflow")
    triggerWorkflow.value = true;
  match();
});
function match() {
  mapping.value =
    sheet.value && form.published
      ? suggestImportMapping(sheet.value, header.value, form.published.schema)
      : [];
  mapping.value = mapping.value.map((id) =>
    id === "data_id" ||
    fields.value.some((c) => importFieldKey(c.field.id, c.addressPart) === id)
      ? id
      : "",
  );
  error.value = "";
  if (mode.value === "create")
    mapping.value = mapping.value.map((id) => (id === "data_id" ? "" : id));
}
const request = computed<RecordImportRequest>(() => {
  const idColumn = mapping.value.indexOf("data_id");
  const ids = new Set(
    mode.value === "create" || idColumn < 0
      ? []
      : (onlyRows.value
          ? onlyRows.value.map((index) => rows.value[index]!)
          : rows.value
        ).map((row) => String(row[idColumn] ?? "").trim()),
  );
  return {
    mode: mode.value,
    ...(props.member ? { member: props.member } : {}),
    validate: validate.value,
    triggerWorkflow: triggerWorkflow.value,
    definitionVersion: form.published?.version || 0,
    rows: rows.value,
    firstRow: dataStart.value + 1,
    onlyRows: onlyRows.value,
    merges: sheet.value?.merges
      ?.filter((m) => m.e.r >= dataStart.value)
      .map((m) => ({
        s: { ...m.s, r: m.s.r - dataStart.value },
        e: { ...m.e, r: m.e.r - dataStart.value },
      })),
    mapping: mapping.value.flatMap<ImportMapping>((id, column) => {
      if (id === "data_id") return [{ column, fieldId: id, type: "data_id" }];
      const matched = mappedColumns.value[column];
      return matched
        ? [
            {
              column,
              fieldId: matched.field.id,
              type: matched.field.type,
              ...(matched.addressPart
                ? { addressPart: matched.addressPart }
                : {}),
              ...(matched.parent ? { parentId: matched.parent.id } : {}),
              ...(matched.field.type === "relation"
                ? { matchFieldId: relationMatches.value[id] || "" }
                : {}),
            },
          ]
        : [];
    }),
    targets: initialEntries.value
      .filter((entry) => ids.has(entry.id) && targetIds.value.has(entry.id))
      .map(({ id, definitionVersion, values }) => ({
        id,
        definitionVersion,
        values,
      })),
  };
});
const previewRows = computed(
  () =>
    sheet.value?.rows
      .slice(sheet.value.fieldIds ? 1 : 0, 20)
      .map((row, index) => ({
        row,
        index: index + (sheet.value?.fieldIds ? 1 : 0),
      })) || [],
);
const preview = computed(() => {
  if (!sheet.value || step.value < 3 || (result.value && !correcting.value))
    return { rows: [], issue: "" };
  try {
    return {
      rows: prepareImportRows(form, request.value, importData.value),
      issue: "",
    };
  } catch (issue) {
    return { rows: [], issue: (issue as Error).message };
  }
});
const importData = computed(() =>
  correcting.value
    ? store.data
    : {
        ...store.data,
        entries: [
          ...initialEntries.value,
          ...store.data.entries.filter((e) => e.formId !== form.id),
        ],
      },
);
const failedRows = computed(
  () => result.value?.rows.filter((r) => r.kind === "error") || [],
);
const canCorrect = computed(
  () => failedRows.value.length > 0 && failedRows.value.length < 30,
);
function correct() {
  savedCorrections = copy(corrections.value);
  onlyRows.value = failedRows.value.map((r) => r.row - request.value.firstRow);
  correcting.value = true;
  error.value = "";
}
function changeCell(
  field: FormField,
  value: unknown,
  row: number,
  column: number,
  lastRow: number,
) {
  try {
    const binding = request.value.mapping.find((m) => m.column === column)!;
    const bindings =
      field.type === "address"
        ? request.value.mapping.filter(
            (m) =>
              m.fieldId === binding.fieldId && m.parentId === binding.parentId,
          )
        : [binding];
    for (const target of bindings) {
      const cell = importExcelValue(
        field,
        { values: { [field.id]: value } },
        runtime.value,
        target.matchFieldId,
        target.addressPart,
      );
      for (let index = row; index <= lastRow; index++)
        corrections.value[index] = {
          ...corrections.value[index],
          [target.column]: cell,
        };
    }
    error.value = "";
  } catch (issue) {
    error.value = (issue as Error).message;
  }
}
const counts = computed(() => ({
  create: preview.value.rows.filter((r) => r.kind === "create").length,
  update: preview.value.rows.filter((r) => r.kind === "update").length,
  other: preview.value.rows.filter((r) => ["skip", "error"].includes(r.kind))
    .length,
}));
const previewIssue = computed(() => preview.value.issue);
async function choose(file?: File) {
  if (!file || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const parsed = (await readExcel(await file.arrayBuffer(), file.name)).map(
      (s) => recognizeImportTemplate(s, form.published!.schema),
    );
    if (!parsed.some((s) => s.rows.length > s.headerRow + 1))
      throw Error("文件没有数据，请在标题行下方填写数据后重试");
    filename.value = file.name;
    corrections.value = {};
    sheets.value = parsed;
    sheetIndex.value = parsed.findIndex((s) => s.rows.length > s.headerRow + 1);
    header.value = parsed[sheetIndex.value]!.headerRow;
    step.value = 2;
    match();
  } catch (issue) {
    error.value = (issue as Error).message;
  } finally {
    loading.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}
function drop(event: DragEvent) {
  void choose(event.dataTransfer?.files[0]);
}
async function template() {
  error.value = "";
  const withId = mode.value !== "create";
  try {
    const layout = importExcelLayout(
      fields.value,
      withId ? ["data_id"] : [],
      withId ? ["data_id"] : [],
    );
    await downloadExcel(
      `${form.title}-导入模板.xlsx`,
      layout.headers,
      layout.fieldIds,
      layout.merges,
    );
  } catch (issue) {
    error.value = (issue as Error).message || "未能下载模板，请重试";
  }
}
function cells(index: number, last: number) {
  return headers.value.flatMap((_title, c) => {
    const merge = sheet.value?.merges?.find(
      (m) => index >= m.s.r && index <= m.e.r && c >= m.s.c && c <= m.e.c,
    );
    if (merge && (merge.s.r !== index || merge.s.c !== c)) return [];
    return [
      {
        column: c,
        rowspan: merge ? Math.min(last, merge.e.r) - index + 1 : 1,
        colspan: merge ? merge.e.c - c + 1 : 1,
      },
    ];
  });
}
function next() {
  if (!rows.value.some((r) => r.some((v) => v !== null && v !== ""))) {
    error.value = "标题行下方没有数据，请重新选择标题行";
    return;
  }
  step.value = 3;
  error.value = "";
}
async function save() {
  error.value = "";
  try {
    prepareImportRows(form, request.value, importData.value);
  } catch (issue) {
    error.value = (issue as Error).message;
    return;
  }
  const imported = await store.importEntries(form.id, request.value);
  if (imported) {
    // Our own successful updates become the baseline; unrelated targets retain
    // their original values so another editor's changes still require a recheck.
    const updated = new Set(
      imported.rows.filter((r) => r.kind === "update").map((r) => r.id),
    );
    initialEntries.value = initialEntries.value.map((entry) =>
      updated.has(entry.id)
        ? copy(store.data.entries.find((e) => e.id === entry.id)!)
        : entry,
    );
    result.value = imported;
    step.value = 4;
    correcting.value = false;
    onlyRows.value = undefined;
    dismiss.markSaved();
    emit("saved");
    store.notify(
      `导入完成：新增 ${imported.created} 条，更新 ${imported.updated} 条`,
    );
  } else {
    needsReview.value = store.storageConflict;
    error.value = needsReview.value
      ? `待更新记录或表单已变化，${correcting.value ? "本次修改" : "文件"}尚未导入。请重新核对最新数据后再试。`
      : store.notices.at(-1)?.message ||
        "导入未保存，文件和字段匹配已保留，请重试";
  }
}
function recheck() {
  if (!store.refreshForRead()) {
    error.value = "无法读取最新数据，文件和字段匹配已保留，请重试";
    return;
  }
  const latest = store.data.forms.find((f) => f.id === form.id);
  if (
    latest?.published?.version !== form.published?.version ||
    latest?.archived
  ) {
    error.value =
      "表单已重新发布或移入回收站，请重新打开导入后核对字段。文件尚未导入。";
    return;
  }
  initialEntries.value = copy(
    store.data.entries.filter((e) => e.formId === form.id),
  );
  captureTargets();
  modes.value = recordImportModes(form, store.data, props.member);
  catalogs.value = {
    create: memberImportColumns(form, "create", store.data, props.member),
    update: memberImportColumns(form, "update", store.data, props.member),
    both: memberImportColumns(form, "both", store.data, props.member),
  };
  if (!modes.value.includes(mode.value)) {
    error.value =
      "当前权限不支持此导入模式，文件已保留，请返回第一步选择模式。";
    needsReview.value = false;
    return;
  }
  error.value = "";
  needsReview.value = false;
  reviewNotice.value = "已读取最新数据，请核对下方 Excel 内容后再导入。";
}
async function report() {
  if (!result.value) return;
  const issues = (
    correcting.value && !previewIssue.value
      ? preview.value.rows
      : result.value.rows
  ).filter((r) => r.message || r.warnings.length);
  try {
    await downloadExcel(`${form.title}-导入结果.xlsx`, [
      ["Excel 行号", "处理结果", "说明", ...headers.value],
      ...issues.flatMap((r) =>
        Array.from(
          { length: (r.lastRow || r.row) - r.row + 1 },
          (_, offset) => [
            r.row + offset,
            r.kind === "error" ? "失败" : r.kind === "skip" ? "跳过" : "已导入",
            [...(r.issues?.map((i) => i.message) || [r.message]), ...r.warnings]
              .filter(Boolean)
              .join("；"),
            ...rows.value[r.row + offset - request.value.firstRow]!,
          ],
        ),
      ),
    ]);
  } catch {
    error.value = "未能下载结果，请重试";
  }
}
</script>
<template>
  <BaseDialog
    :open="true"
    :title="correcting ? '修改失败数据' : '导入 Excel 数据'"
    :width="correcting ? '100vw' : '800px'"
    :class-name="correcting ? 'import-correction-dialog' : undefined"
    :busy="store.writePending"
    pending-text="正在导入数据，请稍候…"
    @close="dismiss.requestClose"
  >
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      tabindex="-1"
    >
      <span>{{ correcting ? "修改尚未重新导入。" : "文件尚未导入。" }}</span
      ><button class="button" @click="dismiss.confirmDiscard.value = false">
        {{ correcting ? "继续修改" : "继续导入" }}</button
      ><button class="button" @click="dismiss.discard">
        {{ correcting ? "放弃修改" : "放弃导入" }}
      </button>
    </div>
    <ol v-if="!correcting" class="import-steps" aria-label="导入步骤">
      <li
        v-for="(label, index) in [
          '选择Excel',
          '预览数据',
          '配置表单',
          '导入数据',
        ]"
        :key="label"
        :class="{ active: step === index + 1, done: step > index + 1 }"
        :aria-current="step === index + 1 ? 'step' : undefined"
      >
        <span>{{ step > index + 1 ? "✓" : index + 1 }}</span
        >{{ label }}
      </li>
    </ol>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <button
      v-if="needsReview || (member && error)"
      class="button"
      @click="recheck"
    >
      重新核对最新数据
    </button>
    <p
      v-if="reviewNotice && (step === 3 || correcting)"
      class="field-hint"
      role="status"
    >
      {{ reviewNotice }}
    </p>
    <template v-if="correcting">
      <p
        v-if="previewIssue && previewIssue !== error"
        class="field-error"
        role="alert"
      >
        {{ previewIssue }}
      </p>
      <RecordImportCorrection
        :form="form"
        :request="request"
        :rows="previewIssue ? failedRows : preview.rows"
        :disabled="!!previewIssue || needsReview"
        @change="changeCell"
      />
    </template>
    <template v-else-if="step === 1">
      <label class="import-mode"
        >导入模式<select v-model="mode" aria-label="导入模式">
          <option v-for="value in modes" :key="value" :value="value">
            {{
              {
                create: "仅新增数据",
                update: "仅更新数据",
                both: "更新和新增数据",
              }[value]
            }}
          </option>
        </select></label
      >
      <div class="import-checks">
        <label v-if="!member"
          ><input v-model="validate" type="checkbox" />导入触发数据校验</label
        ><label v-if="form.kind === 'workflow' && mode !== 'update'"
          ><input
            v-model="triggerWorkflow"
            type="checkbox"
          />导入触发流程</label
        >
      </div>
      <div class="import-instructions">
        <p v-if="mode !== 'create'">
          更新数据前，请先导出需要更新的数据，并勾选「同时导出 data_id」。
        </p>
        <p>
          支持 2MB 的 xlsx 或 xls 文件，最多 {{ member ? "1" : "10" }} 万行、500
          列。推荐使用<button class="text-button" @click="template">
            标准模板</button
          >。
        </p>
        <p
          v-if="
            catalog.some((c) =>
              ['member', 'members', 'department', 'departments'].includes(
                c.field.type,
              ),
            )
          "
        >
          含成员、部门字段时最多 1 万行。
        </p>
        <p v-if="form.kind === 'workflow' && mode !== 'update'">
          触发流程时最多新增 300 条。
        </p>
        <p v-if="mode === 'update' && catalog.some((c) => c.parent)">
          仅更新主表字段，原子表明细保持不变。
        </p>
        <p v-else-if="catalog.some((c) => c.parent)">
          子表每条明细占一行，主表单元格须合并。
        </p>
        <p v-if="catalog.some((c) => c.field.type === 'relation')">
          关联数据按您选择的主表字段匹配，找不到或重名的记录不会导入。
        </p>
      </div>
      <input
        ref="fileInput"
        class="import-file-input"
        type="file"
        accept=".xlsx,.xls"
        aria-label="选择 Excel 文件"
        @change="choose(($event.target as HTMLInputElement).files?.[0])"
      />
      <button
        class="import-drop-zone"
        :disabled="loading"
        @click="fileInput?.click()"
        @dragover.prevent
        @drop.prevent="drop"
      >
        <AppIcon name="import" :size="46" /><span v-if="loading"
          >正在读取文件…</span
        ><span v-else-if="filename">已选择 {{ filename }}，点击更换</span
        ><span v-else>将文件拖拽到此区域，或 <b>点击添加</b></span>
      </button>
    </template>
    <template v-else-if="step === 2 || step === 3">
      <div class="import-preview-controls">
        <label
          >工作表<select v-model="sheetIndex" aria-label="工作表">
            <option v-for="(s, index) in sheets" :value="index" :key="s.name">
              {{ s.name }}
            </option>
          </select></label
        ><span v-if="step === 2"
          >点击任意一行可设为标题行，之前的数据不导入。</span
        ><span v-else
          >将导入 {{ mapping.filter(Boolean).length }} 列 / 共
          {{ headers.length }} 列</span
        >
      </div>
      <div class="import-table-scroll">
        <table class="import-table">
          <thead v-if="step === 3">
            <tr>
              <th>Excel 字段</th>
              <th v-for="(title, index) in headers" :key="index">
                {{ title || `第 ${index + 1} 列` }}
              </th>
            </tr>
            <tr>
              <th>表单字段</th>
              <th v-for="(_title, index) in headers" :key="index">
                <select
                  v-model="mapping[index]"
                  :aria-label="`第 ${index + 1} 列匹配字段`"
                >
                  <option value="">不导入</option>
                  <option
                    v-if="mode !== 'create'"
                    value="data_id"
                    :disabled="
                      mapping.some((id, i) => id === 'data_id' && i !== index)
                    "
                  >
                    data_id
                  </option>
                  <option
                    v-for="field in fields"
                    :key="importFieldKey(field.field.id, field.addressPart)"
                    :value="importFieldKey(field.field.id, field.addressPart)"
                    :disabled="
                      mapping.some(
                        (id, i) =>
                          id ===
                            importFieldKey(field.field.id, field.addressPart) &&
                          i !== index,
                      )
                    "
                  >
                    {{ field.label }}
                  </option>
                </select>
                <select
                  v-if="mappedColumns[index]?.field.type === 'relation'"
                  v-model="relationMatches[mapping[index]!]"
                  :aria-label="`第 ${index + 1} 列关联匹配字段`"
                  class="import-relation-match"
                >
                  <option :value="undefined">请选择匹配字段</option>
                  <option
                    v-for="field in relationChoices(index)"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.label }}
                  </option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-if="step === 2"
              ><tr
                v-for="{ row, index } in previewRows"
                :key="index"
                :class="{ 'is-header': index >= header && index < dataStart }"
              >
                <th>
                  <button class="text-button" @click="header = index">
                    {{ index === header ? "标题行" : index + 1 }}
                  </button>
                </th>
                <td
                  v-for="cell in cells(
                    index,
                    previewRows.at(-1)?.index || index,
                  )"
                  :key="cell.column"
                  :rowspan="cell.rowspan"
                  :colspan="cell.colspan"
                >
                  {{ row[cell.column] }}
                </td>
              </tr></template
            ><template v-else
              ><tr v-for="(row, index) in rows.slice(0, 10)" :key="index">
                <th>{{ dataStart + index + 1 }}</th>
                <td
                  v-for="cell in cells(
                    dataStart + index,
                    dataStart + Math.min(9, rows.length - 1),
                  )"
                  :key="cell.column"
                  :rowspan="cell.rowspan"
                  :colspan="cell.colspan"
                >
                  {{ row[cell.column] }}
                </td>
              </tr></template
            >
          </tbody>
        </table>
      </div>
      <p v-if="step === 2" class="field-hint">
        {{ filename }} · 共 {{ rows.length }} 行数据。预览仅显示前 20 行。
      </p>
      <template v-else
        ><p
          v-if="previewIssue && previewIssue !== error"
          class="field-error"
          role="alert"
        >
          {{ previewIssue }}
        </p>
        <p v-if="!previewIssue" class="import-counts">
          预计新增 <b>{{ counts.create }}</b> 条，更新
          <b>{{ counts.update }}</b> 条，跳过或失败
          <b>{{ counts.other }}</b> 条。
        </p>
        <p class="field-hint">
          <span v-if="mode !== 'create'">更新时空单元格保留原值；</span>
          <span
            v-if="
              mode !== 'update' && fields.some((c) => c.field.type === 'serial')
            "
          >
            新增流水号自动生成。
          </span>
          导入不触发默认值、公式重算或智能助手，保存后无法撤销。
        </p>
        <p v-if="mode === 'update'" class="field-hint">
          重复 data_id 仅更新第一行。
          <span v-if="catalog.some((c) => c.parent)">原子表明细保持不变。</span>
        </p>
        <p v-if="mode === 'both'" class="field-hint">
          data_id 为空时新增；重复 ID 按行顺序更新，最后一次成功的更新生效。
          <span v-if="catalog.some((c) => c.parent)"
            >已有记录的子表明细保持不变。</span
          >
        </p></template
      >
    </template>
    <section v-else-if="result" class="import-result" aria-live="polite">
      <AppIcon :name="failedRows.length ? 'warning' : 'check'" :size="38" />
      <h3>{{ failedRows.length ? "部分数据导入失败" : "数据导入完成" }}</h3>
      <p>
        新增 {{ result.created }} 条数据，更新 {{ result.updated }} 条数据。
      </p>
      <p v-if="result.rows.some((r) => r.message || r.warnings.length)">
        有 {{ result.rows.filter((r) => r.kind === "skip").length }} 条跳过、{{
          result.rows.filter((r) => r.kind === "error").length
        }}
        条失败，{{ result.rows.filter((r) => r.warnings.length).length }}
        条存在格式提醒。
      </p>
      <button
        v-if="result.rows.some((r) => r.message || r.warnings.length)"
        class="button"
        @click="report"
      >
        {{ failedRows.length ? "下载错误报告" : "下载导入结果" }}
      </button>
      <button v-if="canCorrect" class="button" @click="correct">
        修改失败数据
      </button>
      <ul
        v-if="result.rows.some((r) => r.message || r.warnings.length)"
        class="import-issues"
      >
        <li
          v-for="issue in result.rows
            .filter((r) => r.message || r.warnings.length)
            .slice(0, 10)"
          :key="issue.row"
        >
          第 {{ issue.row
          }}{{ issue.lastRow ? `—${issue.lastRow}` : "" }} 行：{{
            [
              ...(issue.issues?.map((i) => i.message) || [issue.message]),
              ...issue.warnings,
            ]
              .filter(Boolean)
              .join("；")
          }}
        </li>
      </ul>
    </section>
    <template #footer>
      <template v-if="correcting"
        ><button class="button" @click="report">下载错误报告</button
        ><button
          class="button primary"
          :disabled="!!previewIssue || needsReview"
          @click="save"
        >
          重新导入
        </button></template
      >
      <template v-else
        ><button
          v-if="step < 4"
          class="button"
          @click="step === 1 ? dismiss.requestClose() : (step--, (error = ''))"
        >
          {{ step === 1 ? "取消" : "上一步" }}</button
        ><button
          v-if="step === 1 && sheet"
          class="button primary"
          @click="step = 2"
        >
          下一步</button
        ><button v-if="step === 2" class="button primary" @click="next">
          下一步</button
        ><button
          v-if="step === 3"
          class="button primary"
          :disabled="!!previewIssue || needsReview"
          @click="save"
        >
          导入</button
        ><button
          v-if="step === 4"
          class="button primary"
          @click="dismiss.requestClose"
        >
          完成
        </button></template
      >
    </template>
  </BaseDialog>
</template>
<style scoped>
:global(.dialog-layer:has(> .import-correction-dialog)) {
  top: 48px;
  padding: 0;
  background: white;
}
:global(.import-correction-dialog) {
  max-width: none;
  max-height: none;
  height: 100%;
  border-radius: 0;
}
:global(.import-correction-dialog > .dialog-header) {
  justify-content: center;
  position: relative;
}
:global(.import-correction-dialog > .dialog-header > .icon-button) {
  position: absolute;
  right: 20px;
}
:global(.import-correction-dialog > .dialog-body) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}
:global(.import-correction-dialog > .dialog-footer) {
  justify-content: center;
  border-top: 0;
}
:global(.import-correction-dialog > .dialog-body > .field-error),
:global(.import-correction-dialog > .dialog-body > .field-hint),
:global(.import-correction-dialog > .dialog-body > .config-discard) {
  margin: 12px 16px;
}
:global(.import-correction-dialog > .dialog-body > .button) {
  align-self: flex-start;
  margin: 0 16px 12px;
}
.import-steps {
  display: flex;
  list-style: none;
  padding: 4px 0 24px;
  margin: 0;
  justify-content: space-around;
  gap: 12px;
}
.import-steps li {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #8b92a0;
  position: relative;
}
.import-steps li:before {
  content: "";
  position: absolute;
  left: -50%;
  right: 50%;
  top: 16px;
  height: 2px;
  background: #edf0f3;
}
.import-steps li:first-child:before {
  display: none;
}
.import-steps span {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #e8eaee;
  z-index: 1;
}
.import-steps .active,
.import-steps .done {
  color: #253347;
}
.import-steps .active span,
.import-steps .done span {
  background: var(--teal);
  color: white;
}
.import-steps .done:before {
  background: var(--teal);
}
.import-mode,
.import-preview-controls,
.import-preview-controls label {
  display: flex;
  align-items: center;
  gap: 12px;
}
.import-mode select {
  width: 200px;
  height: 32px;
}
.import-checks {
  display: flex;
  gap: 22px;
  margin: 18px 0;
  flex-wrap: wrap;
}
.import-checks label {
  display: flex;
  gap: 7px;
  align-items: center;
}
.import-instructions {
  background: #f7f8fa;
  padding: 12px 16px;
  color: #717b8c;
  font-size: 12px;
  line-height: 1.8;
}
.import-instructions p {
  margin: 2px 0;
}
.import-instructions .text-button {
  font-size: inherit;
  margin: 0 3px;
}
.import-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
}
.import-drop-zone {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 20px;
  width: 100%;
  height: 186px;
  border: 1px dashed #d7dde5;
  background: white;
  color: #7b8799;
  margin-top: 18px;
  cursor: pointer;
  font: inherit;
}
.import-drop-zone .app-icon,
.import-drop-zone b {
  color: var(--teal);
  font-weight: normal;
}
.import-preview-controls {
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #8690a0;
}
.import-preview-controls label {
  color: #354154;
}
.import-preview-controls select {
  width: 180px;
  height: 32px;
}
.import-table-scroll {
  overflow: auto;
  max-height: 300px;
  border: 1px solid #e1e6ec;
}
.import-table {
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
  white-space: nowrap;
}
.import-table th,
.import-table td {
  border: 1px solid #e6e9ee;
  max-width: 200px;
  min-width: 110px;
  padding: 7px 10px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: normal;
}
.import-table th:first-child {
  min-width: 70px;
}
.import-table thead {
  position: sticky;
  top: 0;
  background: #eff8f7;
  z-index: 1;
}
.import-table th select {
  height: 30px;
  width: 160px;
  font: inherit;
}
.import-table th .import-relation-match {
  display: block;
  width: 240px;
  margin: 6px auto 0;
  border-color: var(--teal);
}
.import-table th:has(.import-relation-match) {
  min-width: 260px;
}
.import-table .is-header {
  background: #e3f5f1;
}
.import-counts {
  font-size: 12px;
  color: #717b8c;
}
.import-counts b {
  color: var(--teal);
  font-weight: normal;
}
.import-result {
  text-align: center;
  padding: 18px 0;
  color: #526078;
}
.import-result .app-icon {
  color: var(--teal);
}
.import-result h3 {
  color: #253347;
  font-size: 16px;
}
.import-issues {
  text-align: left;
  background: #f7f8fa;
  padding: 14px 30px;
  font-size: 12px;
  line-height: 1.8;
  max-height: 170px;
  overflow: auto;
}
@media (max-width: 600px) {
  .import-steps {
    gap: 2px;
  }
  .import-steps li {
    font-size: 11px;
  }
  .import-preview-controls span {
    line-height: 1.6;
  }
  .import-drop-zone {
    height: 160px;
  }
  .import-checks {
    gap: 10px;
  }
}
</style>
