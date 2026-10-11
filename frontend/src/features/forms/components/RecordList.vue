<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import RecordPagination from "./RecordPagination.vue";
import InlineRecordEditor from "./InlineRecordEditor.vue";
import RecordBatchDialog from "./RecordBatchDialog.vue";
import RecordImportDialog from "./RecordImportDialog.vue";
import RecordExportDialog from "./RecordExportDialog.vue";
import { downloadExcel } from "../../../services/excel";
import { entryTitle, inlineEditField } from "../../../domain/collaboration";
import CustomButtonBar from "../../../components/shared/CustomButtonBar.vue";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import PresentationFields from "../../extensions/components/PresentationFields.vue";
import DataFilterEditor from "./DataFilterEditor.vue";
import {
  recordExcelExport,
  defaultRecordView,
  entrySchema,
  filterAndSortRecords,
  type RecordViewSettings,
} from "../../../domain/records";
import { presentationFields } from "../../../domain/presentation";
import { displayValue, relationCandidates } from "../../../domain/relations";
import { copy, type FormSchema, type FormField } from "../../../domain/form";
import type { FormEntry, FormRecord } from "../../../domain/workspace";
import type { DataFilter } from "../../../domain/fieldConfig";
import { useWorkspaceStore } from "../../../stores/workspace";
import { downloadCsv } from "../../../services/downloadCsv";
const props = defineProps<{ form: FormRecord; schema: FormSchema }>();
const emit = defineEmits<{
  view: [entry: FormEntry];
  edit: [entry: FormEntry];
}>();
const store = useWorkspaceStore(),
  router = useRouter();
const editingCell = ref<{ entryId: string; fieldId: string }>();
const savingView = ref(false);
const batch = ref<{ entries: FormEntry[]; schema: FormSchema }>();
const importing = ref(false),
  exporting = ref<FormEntry[]>(),
  exportSelected = ref(false),
  exportFormat = ref("xlsx"),
  exportIds = ref(false),
  exportingFile = ref(false);
const query = ref(""),
  statusFilter = ref("all"),
  recycled = ref(false),
  page = ref(1),
  filters = ref<DataFilter[]>([]),
  showFilters = ref(false),
  columnsOpen = ref(false),
  columnDraft = ref<string[]>([]),
  selected = ref<string[]>([]),
  exportError = ref("");
const fields = computed(() => presentationFields(props.schema));
const view = computed(
  () =>
    store.data.recordViews?.[props.form.id] || defaultRecordView(props.schema),
);
const entries = computed(() =>
  filterAndSortRecords(
    store.data.entries.filter(
      (e) =>
        e.formId === props.form.id &&
        !!e.deletedAt === recycled.value &&
        (statusFilter.value === "all" || e.status === statusFilter.value),
    ),
    props.schema,
    store.data,
    { query: query.value, filters: filters.value, view: view.value },
  ),
);
const pages = computed(() =>
  Math.max(1, Math.ceil(entries.value.length / view.value.pageSize)),
);
const rows = computed(() =>
  entries.value.slice(
    (page.value - 1) * view.value.pageSize,
    page.value * view.value.pageSize,
  ),
);
const allSelected = computed(
  () =>
    !!rows.value.length &&
    rows.value.every((e) => selected.value.includes(e.id)),
);
const columns = computed(() =>
  view.value.fieldIds
    .map((id) => fields.value.find((f) => f.id === id))
    .filter((f): f is FormField => !!f),
);
watch(
  [query, statusFilter, recycled, filters],
  () => {
    page.value = 1;
    selected.value = [];
  },
  { deep: true },
);
watch(pages, (count) => (page.value = Math.min(page.value, count)));
watch(
  () => !!batch.value || importing.value || !!editingCell.value,
  (active, previous) => {
    if (!active && previous) store.refreshForRead();
  },
);
watch(
  entries,
  (next) =>
    (selected.value = selected.value.filter((id) =>
      next.some((e) => e.id === id),
    )),
);
async function changeView(patch: Partial<RecordViewSettings>) {
  if (savingView.value) return;
  savingView.value = true;
  try {
    if (await store.saveRecordView(props.form.id, { ...view.value, ...patch }))
      page.value = 1;
  } finally {
    savingView.value = false;
  }
}
function openColumns() {
  columnDraft.value = [...view.value.fieldIds];
  columnsOpen.value = true;
}
async function saveColumns() {
  if (savingView.value) return;
  if (!columnDraft.value.length) {
    store.notify("请至少选择一列", "warning");
    return;
  }
  savingView.value = true;
  try {
    if (
      await store.saveRecordView(props.form.id, {
        ...view.value,
        fieldIds: columnDraft.value,
      })
    )
      columnsOpen.value = false;
  } finally {
    savingView.value = false;
  }
}
function togglePage() {
  const ids = new Set(selected.value),
    remove = allSelected.value;
  for (const e of rows.value) {
    if (remove) ids.delete(e.id);
    else ids.add(e.id);
  }
  selected.value = [...ids];
}
function openBatch() {
  const chosen = selected.value.length
    ? entries.value.filter((entry) => selected.value.includes(entry.id))
    : entries.value.filter((entry) => entry.status !== "draft");
  if (!chosen.length || chosen.some((entry) => entry.status === "draft")) {
    store.notify("请只选择已提交的记录", "warning");
    return;
  }
  batch.value = {
    entries: copy(chosen),
    schema: copy(entrySchema(chosen[0]!, store.data, props.schema)),
  };
}
async function recycle(ids: string[], remove: boolean) {
  const count = ids.length;
  if (await store.recycleEntries(ids, remove)) {
    selected.value = [];
    store.notify(
      remove ? `${count} 条记录已移入回收站` : `${count} 条记录已恢复`,
    );
  }
}
function fill(draftId = "") {
  router.push(
    `/apps/${props.form.appId}/forms/${props.form.id}/fill${draftId ? `?draft=${draftId}` : ""}`,
  );
}
function display(entry: FormEntry, id: string) {
  const field = presentationFields(
    entrySchema(entry, store.data, props.schema),
  ).find((f) => f.id === id);
  if (field?.type === "relationTable" && field.reference.mode === "reverse")
    return `${relationCandidates(field, store.data, entry.values, entry.id, entrySchema(entry, store.data, props.schema).fields).length} 条关联`;
  return displayValue(field, entry.values[id], store.data);
}
const statusName = (entry: FormEntry) =>
  ({
    draft: "草稿",
    submitted: props.form.kind === "workflow" ? "待处理" : "已提交",
    approved: "已通过",
    rejected: "已退回",
  })[entry.status];
function openExport(onlySelected = false) {
  exportError.value = "";
  exportSelected.value = onlySelected;
  exporting.value = copy(
    entries.value.filter(
      (entry) => !onlySelected || selected.value.includes(entry.id),
    ),
  );
}
async function exportRecords() {
  exportError.value = "";
  exportingFile.value = true;
  let prepared = false;
  try {
    const chosen = exporting.value || [];
    const exportedFields = copy(columns.value);
    const headers = [
      ...(exportIds.value ? ["data_id"] : []),
      "数据标题",
      "创建时间",
      "状态",
    ];
    const records = chosen.map((entry) => {
      const definition = props.form.versions.find(
        (v) => v.version === entry.definitionVersion,
      );
      if (!definition) throw Error("记录原表单版本不可用，请核对后导出");
      return {
        entry,
        schema: definition.schema,
        extra: [
          ...(exportIds.value ? [entry.id] : []),
          entryTitle(entry, store.data),
          new Date(entry.createdAt).toLocaleString("zh-CN"),
          statusName(entry),
        ],
      };
    });
    const excel =
      exportFormat.value === "csv"
        ? undefined
        : recordExcelExport(store.data, exportedFields, headers, records);
    const result = [
      [...headers, ...exportedFields.map((f) => f.label)],
      ...records.map(({ entry, extra }) => [
        ...extra,
        ...exportedFields.map((column) => display(entry, column.id)),
      ]),
    ];
    const name =
      props.form.title + (exportSelected.value ? "-所选记录" : "-筛选结果");
    prepared = true;
    if (exportFormat.value === "csv") downloadCsv(name + ".csv", result);
    else
      await downloadExcel(
        name + ".xlsx",
        excel!.rows,
        excel!.fieldIds,
        excel!.merges,
      );
    store.notify(
      `已请求导出 ${chosen.length} 条${exportSelected.value ? "所选记录" : "筛选结果"}`,
    );
    exporting.value = undefined;
  } catch (error) {
    exportError.value =
      !prepared && error instanceof Error
        ? error.message
        : "未能发起下载，当前筛选和选择已保留，请再次点击导出。";
  } finally {
    exportingFile.value = false;
  }
}
</script>
<template>
  <section class="data-record-list">
    <fieldset
      class="record-controls-lock"
      :disabled="!!editingCell || savingView"
    >
      <header class="data-toolbar">
        <h2>
          {{ recycled ? "数据回收站" : "记录管理" }}
          <span>{{ entries.length }}</span>
        </h2>
        <div class="toolbar-spacer" />
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="query"
            aria-label="搜索提交数据"
            placeholder="搜索记录内容"
          />
        </div>
        <select
          class="record-select"
          v-model="statusFilter"
          aria-label="筛选数据状态"
        >
          <option value="all">全部状态</option>
          <option value="draft">草稿</option>
          <option value="submitted">已提交 / 待处理</option>
          <option value="approved">已通过</option>
          <option value="rejected">已退回</option></select
        ><button class="button" @click="showFilters = !showFilters">
          <AppIcon name="filter" />筛选{{
            filters.length ? `（${filters.length}）` : ""
          }}</button
        ><button class="button" @click="openColumns">
          <AppIcon name="table" />列设置</button
        ><button class="button" @click="recycled = !recycled">
          <AppIcon :name="recycled ? 'back' : 'trash'" />{{
            recycled ? "返回数据" : "回收站"
          }}</button
        ><button
          v-if="!recycled && form.published"
          class="button"
          @click="importing = true"
        >
          <AppIcon name="import" />导入</button
        ><button class="button" @click="openExport()">
          <AppIcon name="download" />导出</button
        ><button v-if="!recycled" class="button primary" @click="fill()">
          <AppIcon name="add" />新增数据
        </button>
      </header>
      <p v-if="exportError" class="field-error" role="alert">
        {{ exportError }}
      </p>
      <section v-if="showFilters" class="record-filters">
        <DataFilterEditor
          v-model="filters"
          :source-fields="fields"
          :local-fields="[]"
          :allow-field-source="false"
          source-placeholder="选择筛选字段"
          hint="同时满足以下条件的数据会显示在列表中。"
        /><button
          v-if="filters.length"
          class="text-button"
          @click="filters = []"
        >
          清除筛选条件
        </button>
      </section>
      <div class="record-list-options">
        <span v-if="selected.length">已选 {{ selected.length }} 条</span
        ><span v-else>{{
          recycled
            ? "恢复后重新出现在列表，关联选择器不列出回收站记录。"
            : "选择记录可批量操作"
        }}</span
        ><template v-if="selected.length"
          ><button class="text-button" @click="openExport(true)">
            导出所选</button
          ><button class="text-button" @click="recycle(selected, !recycled)">
            {{ recycled ? "恢复所选" : "移入回收站" }}</button
          ><button class="text-button" @click="selected = []">
            取消选择
          </button></template
        >
        <button v-if="!recycled" class="text-button" @click="openBatch">
          {{ selected.length ? "批量修改" : "批量修改筛选结果" }}
        </button>
        <div class="toolbar-spacer" />
        <label
          >排序<select
            aria-label="数据排序字段"
            :value="view.sortField"
            @change="
              changeView({
                sortField: ($event.target as HTMLSelectElement).value,
              })
            "
          >
            <option value="$createdAt">创建时间</option>
            <option v-for="field in fields" :key="field.id" :value="field.id">
              {{ field.label }}
            </option>
          </select></label
        ><button
          class="text-button"
          @click="changeView({ descending: !view.descending })"
        >
          {{ view.descending ? "降序" : "升序" }}
        </button>
      </div>
    </fieldset>
    <p v-if="savingView" class="inline-session-hint" role="status">
      正在保存列表设置…
    </p>
    <p v-else-if="editingCell" class="inline-session-hint" role="status">
      正在编辑单元格，保存或取消后可继续筛选和其他操作。
    </p>
    <p
      v-else-if="
        rows.some((e) =>
          columns.some((f) => inlineEditField(e, f.id, store.data)),
        )
      "
      class="inline-session-hint"
    >
      点选带编辑图标的单元格，可直接修改。
    </p>
    <div class="data-table-scroll">
      <table
        class="forms-table data-table record-display-table"
        :data-row-height="view.rowHeight || 'low'"
      >
        <thead>
          <tr>
            <th class="record-check">
              <input
                type="checkbox"
                aria-label="选择本页全部记录"
                :disabled="!!editingCell"
                :checked="allSelected"
                @change="togglePage"
              />
            </th>
            <th>数据标题</th>
            <th>创建时间</th>
            <th>状态</th>
            <th v-for="field in columns" :key="field.id">{{ field.label }}</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in rows" :key="entry.id">
            <td class="record-check">
              <input
                type="checkbox"
                :disabled="!!editingCell"
                v-model="selected"
                :value="entry.id"
                :aria-label="`选择记录 ${entry.id}`"
              />
            </td>
            <td>
              <button
                type="button"
                class="record-title-button record-cell-value"
                :disabled="!!editingCell"
                :title="entryTitle(entry, store.data)"
                @click="emit('view', entry)"
              >
                {{ entryTitle(entry, store.data) }}
              </button>
            </td>
            <td>{{ new Date(entry.createdAt).toLocaleString("zh-CN") }}</td>
            <td>
              <span
                class="status-tag"
                :class="{ published: entry.status === 'approved' }"
                >{{ statusName(entry) }}</span
              >
            </td>
            <td
              v-for="field in columns"
              :key="field.id"
              :class="{
                'inline-edit-cell':
                  editingCell?.entryId === entry.id &&
                  editingCell.fieldId === field.id,
              }"
            >
              <InlineRecordEditor
                v-if="
                  editingCell?.entryId === entry.id &&
                  editingCell.fieldId === field.id
                "
                :key="entry.id + field.id"
                :entry="entry"
                :field-id="field.id"
                @close="editingCell = undefined"
              />
              <button
                v-else-if="inlineEditField(entry, field.id, store.data)"
                type="button"
                class="record-cell-edit"
                :disabled="!!editingCell"
                :aria-label="`快捷编辑${field.label}，${entryTitle(entry, store.data)}`"
                @click="editingCell = { entryId: entry.id, fieldId: field.id }"
              >
                <span class="record-cell-value">{{
                  display(entry, field.id)
                }}</span
                ><AppIcon name="edit" :size="13" />
              </button>
              <span v-else class="record-cell-value">{{
                display(entry, field.id)
              }}</span>
            </td>
            <td class="record-actions">
              <fieldset
                class="record-controls-lock record-actions-lock"
                :disabled="!!editingCell"
              >
                <button class="text-button" @click="emit('view', entry)">
                  查看</button
                ><button
                  v-if="!recycled && entry.status !== 'draft'"
                  class="text-button"
                  @click="emit('edit', entry)"
                >
                  编辑</button
                ><button
                  v-if="recycled"
                  class="text-button"
                  @click="recycle([entry.id], false)"
                >
                  恢复</button
                ><button
                  v-if="!recycled && entry.status === 'draft'"
                  class="text-button"
                  @click="fill(entry.id)"
                >
                  继续填写
                </button>
                <CustomButtonBar
                  v-if="!recycled && entry.status !== 'draft'"
                  :buttons="
                    form.versions.find(
                      (v) => v.version === entry.definitionVersion,
                    )?.extensions?.buttons || []
                  "
                  position="row"
                  :schema="entrySchema(entry, store.data, schema)"
                  :values="entry.values"
                  :form-id="form.id"
                  :entry-id="entry.id"
                />
              </fieldset>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!entries.length" class="workspace-empty list-empty">
        <AppIcon :name="recycled ? 'trash' : 'database'" :size="40" />
        <h3>{{ recycled ? "回收站为空" : "没有符合条件的数据" }}</h3>
        <p>
          {{
            recycled
              ? "移入回收站的记录可在这里恢复"
              : "可以调整筛选条件，或填写一条新记录"
          }}
        </p>
        <button v-if="!recycled" class="button" @click="fill()">
          填写表单
        </button>
      </div>
    </div>
    <fieldset
      class="record-controls-lock"
      :disabled="!!editingCell || savingView"
    >
      <RecordPagination
        :total="entries.length"
        :page="page"
        :settings="view"
        :busy="!!editingCell || savingView"
        @page="page = $event"
        @change="changeView"
      />
    </fieldset>
    <RecordBatchDialog
      v-if="batch"
      :form-id="form.id"
      :schema="batch.schema"
      :entries="batch.entries"
      @close="batch = undefined"
      @saved="
        batch = undefined;
        selected = [];
      "
    />
    <RecordImportDialog
      v-if="importing"
      :form="form"
      @close="importing = false"
      @saved="selected = []"
    />
    <RecordExportDialog
      :open="!!exporting"
      :count="exporting?.length || 0"
      :selected="exportSelected"
      :busy="exportingFile"
      :error="exportError"
      v-model:format="exportFormat"
      v-model:include-ids="exportIds"
      @close="exporting = undefined"
      @export="exportRecords"
    />
    <BaseDialog
      :open="columnsOpen"
      title="配置数据列"
      :busy="savingView"
      width="520px"
      @close="columnsOpen = false"
      ><fieldset class="record-controls-lock" :disabled="savingView">
        <PresentationFields v-model="columnDraft" :schema="schema" />
      </fieldset>
      <p class="field-hint">
        列设置影响当前表单的列表和导出；保存后刷新仍保留。
      </p>
      <template #footer
        ><button class="button" @click="columnsOpen = false">取消</button
        ><button class="button primary" @click="saveColumns">
          保存列设置
        </button></template
      ></BaseDialog
    >
  </section>
</template>
<style scoped>
.record-pagination select[aria-label="记录行高"] {
  width: 86px;
}
</style>
