<script setup lang="ts">
import { computed, ref } from "vue";
import type { FrontendDataSelection } from "@platform/contracts";
import { copy, type FormField, type FormValues } from "../../../domain/form";
import {
  selectionSourceFields,
  selectionIssues,
  newFrontendSelection,
  selectionTypesMatch,
  selectionSortFields,
  type SelectionProfile,
} from "../../../domain/frontendSelections";
import { useWorkspaceStore } from "../../../stores/workspace";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import DataFilterEditor from "./DataFilterEditor.vue";
import SelectionRecords from "./SelectionRecords.vue";
import SelectionColumns from "./SelectionColumns.vue";
const props = withDefaults(
  defineProps<{
    modelValue: FrontendDataSelection;
    inputs: FormField[];
    outputs: (FormField & { parentId?: string; pathLabel?: string })[];
    rowScoped?: boolean;
    profile?: SelectionProfile;
    buttonText?: string;
    createFields?: (sourceIds: string[]) => void;
  }>(),
  { profile: "event" },
);
const emit = defineEmits<{
  "update:modelValue": [value: FrontendDataSelection];
  "update:buttonText": [value: string];
}>();
const store = useWorkspaceStore(),
  processOpen = ref(false),
  mappingOpen = ref(false),
  filtersOpen = ref(false),
  error = ref("");
const draft = ref(newFrontendSelection()),
  draftButtonText = ref("");
const mappingMode = ref<"new" | "existing">("existing"),
  mappingQuery = ref("");
const source = computed(() =>
  selectionSourceFields(store.data, draft.value.formId, props.profile),
);
const currentSource = computed(() =>
  selectionSourceFields(store.data, props.modelValue.formId, props.profile),
);
const sample = computed<FormValues>(() =>
  Object.fromEntries(
    props.inputs.map((field) => [field.id, field.defaultValue]),
  ),
);
const processDismiss = useDraftDismiss(
  () => processOpen.value,
  () => ({ selection: draft.value, buttonText: draftButtonText.value }),
  () => (processOpen.value = false),
);
const mappingDismiss = useDraftDismiss(
  () => mappingOpen.value,
  () => ({ selection: draft.value, mode: mappingMode.value }),
  () => (mappingOpen.value = false),
);
function start(kind: "process" | "mapping") {
  draft.value = copy(props.modelValue);
  draftButtonText.value = props.buttonText || "选择数据";
  mappingMode.value =
    props.createFields && !draft.value.mappings.length ? "new" : "existing";
  mappingQuery.value = "";
  error.value = "";
  if (kind === "process") processOpen.value = true;
  else mappingOpen.value = true;
}
function sourceChange(event: Event) {
  const formId = (event.target as HTMLSelectElement).value;
  emit("update:modelValue", {
    ...newFrontendSelection(),
    formId,
    columns: selectionSourceFields(store.data, formId, props.profile)
      .slice(0, 3)
      .map((field) => field.id),
  });
}
function apply(kind: "process" | "mapping") {
  if (kind === "mapping" && mappingMode.value === "new" && props.createFields) {
    try {
      props.createFields(
        draft.value.mappings.map((mapping) => mapping.sourceFieldId),
      );
      mappingDismiss.markSaved();
      mappingOpen.value = false;
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "创建字段失败，请重试";
    }
    return;
  }
  const targets =
    kind === "process"
      ? [
          "selection-source",
          "selection-columns",
          "selection-filters",
          "selection-sort",
        ]
      : ["selection-mappings"];
  error.value =
    selectionIssues(
      draft.value,
      props.inputs,
      props.outputs,
      store.data,
      props.profile,
    ).find((issue) => targets.includes(issue.target))?.message || "";
  if (error.value) return;
  emit(
    "update:modelValue",
    kind === "process"
      ? {
          ...copy(props.modelValue),
          columns: copy(draft.value.columns),
          columnLabels: draft.value.columnLabels
            ? copy(draft.value.columnLabels)
            : undefined,
          filters: copy(draft.value.filters),
          match: draft.value.match,
          sort: copy(draft.value.sort),
        }
      : {
          ...copy(props.modelValue),
          mappings: copy(draft.value.mappings),
          subformFill: draft.value.subformFill,
        },
  );
  if (kind === "process" && props.profile === "lookup")
    emit("update:buttonText", draftButtonText.value);
  (kind === "process" ? processDismiss : mappingDismiss).markSaved();
  if (kind === "process") processOpen.value = false;
  else mappingOpen.value = false;
}
const name = (id: string) =>
  source.value.find((field) => field.id === id)?.pathLabel || "来源字段已移除";
const mappingFields = computed(() =>
  source.value.filter((field) => !props.rowScoped || !field.parentId),
);
const filteredMappingFields = computed(() => {
  const query = mappingQuery.value.trim().toLocaleLowerCase();
  return mappingFields.value.filter(
    (field) => !query || field.pathLabel.toLocaleLowerCase().includes(query),
  );
});
const allMappingsChecked = computed(
  () =>
    !!filteredMappingFields.value.length &&
    filteredMappingFields.value.every((field) =>
      draft.value.mappings.some(
        (mapping) => mapping.sourceFieldId === field.id,
      ),
    ),
);
const partlyMappingsChecked = computed(
  () =>
    !allMappingsChecked.value &&
    filteredMappingFields.value.some((field) =>
      draft.value.mappings.some(
        (mapping) => mapping.sourceFieldId === field.id,
      ),
    ),
);
function chooseMapping(fieldId: string, checked: boolean) {
  if (!checked)
    draft.value.mappings = draft.value.mappings.filter(
      (mapping) => mapping.sourceFieldId !== fieldId,
    );
  else if (
    !draft.value.mappings.some((mapping) => mapping.sourceFieldId === fieldId)
  )
    draft.value.mappings.push({
      sourceFieldId: fieldId,
      targetFieldId:
        props.modelValue.mappings.find(
          (mapping) => mapping.sourceFieldId === fieldId,
        )?.targetFieldId || "",
    });
}
function chooseAllMappings(checked: boolean) {
  for (const field of filteredMappingFields.value)
    chooseMapping(field.id, checked);
}
function mappingTargets(sourceId: string) {
  const original = source.value.find((field) => field.id === sourceId);
  return props.outputs.filter(
    (target) =>
      original &&
      selectionTypesMatch(original, target, props.profile) &&
      (!original.parentId || !!target.parentId) &&
      !["calculated", "serial"].includes(target.type),
  );
}
</script>
<template>
  <div class="frontend-selection-settings">
    <div class="form-group">
      <label for="selection-source">数据源</label>
      <div class="select-wrap selection-setting-control">
        <select
          id="selection-source"
          :value="modelValue.formId"
          @change="sourceChange"
        >
          <option value="">请选择数据源</option>
          <option
            v-if="
              modelValue.formId &&
              !store.activeForms.some(
                (form) => form.id === modelValue.formId && form.published,
              )
            "
            :value="modelValue.formId"
          >
            表单已移除或未发布
          </option>
          <optgroup
            v-for="app in store.data.apps.filter((app) =>
              store.activeForms.some(
                (form) => form.appId === app.id && form.published,
              ),
            )"
            :key="app.id"
            :label="app.name"
          >
            <option
              v-for="form in store.activeForms.filter(
                (form) => form.appId === app.id && form.published,
              )"
              :key="form.id"
              :value="form.id"
            >
              {{ form.title }}
            </option>
          </optgroup></select
        ><AppIcon name="down" :size="13" />
      </div>
    </div>
    <div class="form-group">
      <label>数据选择过程</label
      ><button
        type="button"
        class="button selection-setting-control"
        :disabled="!currentSource.length"
        aria-label="设置数据选择过程"
        @click="start('process')"
      >
        {{ modelValue.columns.length ? "已设置" : "设置"
        }}<AppIcon name="edit" :size="14" />
      </button>
    </div>
    <slot name="before-mappings" />
    <div class="form-group">
      <label>填充到表单字段</label
      ><button
        type="button"
        class="button selection-setting-control"
        :disabled="!currentSource.length"
        aria-label="设置填充规则"
        @click="start('mapping')"
      >
        {{ modelValue.mappings.length ? "已设置填充规则" : "设置"
        }}<AppIcon name="edit" :size="14" />
      </button>
    </div>
  </div>
  <BaseDialog
    :open="processOpen"
    title="数据选择过程"
    width="100vw"
    class-name="selection-process-dialog"
    @close="processDismiss.requestClose"
  >
    <div class="selection-process-layout">
      <div class="selection-process-preview">
        <SelectionRecords
          :config="draft"
          :data="store.data"
          :values="sample"
          :inputs="inputs"
          :selectable="false"
          :profile="profile"
        />
      </div>
      <aside class="selection-process-properties">
        <div v-if="profile === 'lookup'" class="form-group">
          <label for="lookup-button-text">按钮文字</label
          ><input id="lookup-button-text" v-model="draftButtonText" />
        </div>
        <div class="form-group">
          <label>选择数据时的显示字段</label
          ><SelectionColumns
            :columns="draft.columns"
            :labels="draft.columnLabels"
            :fields="source"
            @change="
              (columns, labels) => {
                draft.columns = columns;
                if (labels) draft.columnLabels = labels;
                else delete draft.columnLabels;
              }
            "
          />
        </div>
        <div class="form-group">
          <label>数据过滤</label
          ><button class="button full-width" @click="filtersOpen = true">
            {{ draft.filters.length ? "已添加过滤条件" : "添加过滤条件"
            }}<AppIcon name="edit" :size="14" />
          </button>
        </div>
        <div class="form-group">
          <label>数据排序规则</label>
          <div class="selection-sort">
            <select v-model="draft.sort.fieldId" aria-label="选择数据排序字段">
              <option value="$createdAt">创建时间</option>
              <option
                v-for="field in selectionSortFields(source, profile)"
                :key="field.id"
                :value="field.id"
              >
                {{ field.pathLabel }}
              </option></select
            ><select
              v-model="draft.sort.direction"
              aria-label="选择数据排序方向"
            >
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </div>
        </div>
      </aside>
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div v-if="processDismiss.confirmDiscard.value" class="config-discard">
      <p>修改尚未保存，是否放弃？</p>
      <button
        class="button"
        @click="processDismiss.confirmDiscard.value = false"
      >
        继续编辑</button
      ><button class="button danger" @click="processDismiss.discard">
        放弃修改
      </button>
    </div>
    <template #footer
      ><button class="button" @click="processDismiss.requestClose">取消</button
      ><button class="button primary" @click="apply('process')">
        完成
      </button></template
    >
  </BaseDialog>
  <BaseDialog
    :open="filtersOpen"
    title="数据过滤"
    width="700px"
    @close="filtersOpen = false"
    ><div class="form-group">
      <label>符合以下条件</label
      ><select v-model="draft.match" aria-label="过滤条件关系">
        <option value="all">所有</option>
        <option value="any">任一</option>
      </select>
    </div>
    <DataFilterEditor
      v-model="draft.filters"
      :source-fields="source.filter((field) => !field.parentId)"
      :local-fields="inputs"
      compact
    /><template #footer
      ><button class="button primary" @click="filtersOpen = false">
        完成
      </button></template
    ></BaseDialog
  >
  <BaseDialog
    :open="mappingOpen"
    title="填充规则设置"
    :width="profile === 'lookup' ? '700px' : '600px'"
    class-name="selection-mapping-dialog"
    @close="mappingDismiss.requestClose"
  >
    <div v-if="profile === 'lookup'" class="selection-mapping-layout">
      <div class="selection-mapping-source">
        <div class="selection-mapping-heading">
          <span>1.选择字段</span>
          <div class="search-input">
            <AppIcon name="search" :size="14" /><input
              v-model="mappingQuery"
              aria-label="搜索填充字段"
              placeholder="搜索"
            />
          </div>
        </div>
        <div class="selection-mapping-fields">
          <label class="checkbox-line">
            <input
              type="checkbox"
              :checked="allMappingsChecked"
              :indeterminate="partlyMappingsChecked"
              :disabled="!filteredMappingFields.length"
              :aria-label="
                mappingQuery ? '全选搜索结果填充字段' : '全选填充字段'
              "
              @change="
                chooseAllMappings(($event.target as HTMLInputElement).checked)
              "
            />{{ mappingQuery ? "全选搜索结果" : "全选" }}
          </label>
          <label
            v-for="field in filteredMappingFields"
            :key="field.id"
            class="checkbox-line"
          >
            <input
              type="checkbox"
              :checked="
                draft.mappings.some(
                  (mapping) => mapping.sourceFieldId === field.id,
                )
              "
              :aria-label="`填充来源 ${field.pathLabel}`"
              @change="
                chooseMapping(
                  field.id,
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />{{ field.pathLabel }}
          </label>
          <label
            v-for="(mapping, index) in draft.mappings.filter(
              (mapping) =>
                !mappingFields.some(
                  (field) => field.id === mapping.sourceFieldId,
                ),
            )"
            :key="mapping.sourceFieldId"
            class="checkbox-line"
          >
            <input
              type="checkbox"
              checked
              :aria-label="`失效填充来源 ${index + 1}`"
              @change="chooseMapping(mapping.sourceFieldId, false)"
            />来源字段已移除或不在当前范围
          </label>
          <span v-if="!filteredMappingFields.length" class="muted"
            >没有匹配字段</span
          >
        </div>
      </div>
      <div class="selection-mapping-processing">
        <div class="selection-mapping-heading">2.字段值如何处理</div>
        <div class="select-wrap selection-mapping-mode">
          <select v-model="mappingMode" aria-label="字段值如何处理">
            <option v-if="createFields" value="new">填充到新字段</option>
            <option value="existing">填充到已有字段</option></select
          ><AppIcon name="down" :size="13" />
        </div>
        <div
          v-if="mappingMode === 'existing'"
          class="selection-mapping-targets"
        >
          <label
            v-for="(mapping, index) in draft.mappings"
            :key="mapping.sourceFieldId"
            class="form-group"
          >
            <span>{{ name(mapping.sourceFieldId) }}</span>
            <div class="select-wrap">
              <select
                v-model="mapping.targetFieldId"
                :aria-label="`填充字段 ${index + 1}`"
              >
                <option value="">选择当前表单字段</option>
                <option
                  v-if="
                    mapping.targetFieldId &&
                    !mappingTargets(mapping.sourceFieldId).some(
                      (field) => field.id === mapping.targetFieldId,
                    )
                  "
                  :value="mapping.targetFieldId"
                >
                  字段已移除或不在当前范围
                </option>
                <option
                  v-for="field in mappingTargets(mapping.sourceFieldId)"
                  :key="field.id"
                  :value="field.id"
                >
                  {{ field.pathLabel || field.label }}
                </option></select
              ><AppIcon name="down" :size="13" />
            </div>
          </label>
        </div>
      </div>
    </div>
    <template v-else>
      <p class="field-hint">选择数据后，将所选字段的值填充到当前表单字段。</p>
      <button
        type="button"
        class="text-button"
        @click="draft.mappings.push({ sourceFieldId: '', targetFieldId: '' })"
      >
        <AppIcon name="add" :size="14" />添加字段
      </button>
      <div
        v-for="(mapping, index) in draft.mappings"
        :key="index"
        class="selection-mapping-row"
      >
        <select
          v-model="mapping.sourceFieldId"
          :aria-label="`来源字段 ${index + 1}`"
          @change="mapping.targetFieldId = ''"
        >
          <option value="">选择来源字段</option>
          <option
            v-if="
              mapping.sourceFieldId &&
              !source.some((field) => field.id === mapping.sourceFieldId)
            "
            :value="mapping.sourceFieldId"
          >
            {{ name(mapping.sourceFieldId) }}
          </option>
          <option
            v-for="field in source.filter(
              (field) => !rowScoped || !field.parentId,
            )"
            :key="field.id"
            :value="field.id"
          >
            {{ field.pathLabel }}
          </option></select
        ><span>的值填充到</span
        ><select
          v-model="mapping.targetFieldId"
          :aria-label="`填充字段 ${index + 1}`"
        >
          <option value="">选择当前表单字段</option>
          <option
            v-if="
              mapping.targetFieldId &&
              !outputs.some((field) => field.id === mapping.targetFieldId)
            "
            :value="mapping.targetFieldId"
          >
            字段已移除或不在当前范围
          </option>
          <option
            v-for="field in outputs.filter(
              (target) =>
                source.some(
                  (original) =>
                    original.id === mapping.sourceFieldId &&
                    selectionTypesMatch(original, target, profile) &&
                    (!original.parentId || !!target.parentId),
                ) && !['calculated', 'serial'].includes(target.type),
            )"
            :key="field.id"
            :value="field.id"
          >
            {{ field.label }}
          </option></select
        ><button
          class="icon-button"
          :aria-label="`删除填充字段 ${index + 1}`"
          @click="draft.mappings.splice(index, 1)"
        >
          <AppIcon name="trash" :size="14" />
        </button>
      </div>
      <div
        v-if="
          draft.mappings.some(
            (mapping) =>
              outputs.find((field) => field.id === mapping.targetFieldId)
                ?.parentId,
          )
        "
        class="form-group"
      >
        <label>子表单填充方式</label
        ><select v-model="draft.subformFill" aria-label="选数子表单填充方式">
          <option value="replace">先清空再填充</option>
          <option value="merge">直接填充</option>
        </select>
      </div>
    </template>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div v-if="mappingDismiss.confirmDiscard.value" class="config-discard">
      <p>修改尚未保存，是否放弃？</p>
      <button
        class="button"
        @click="mappingDismiss.confirmDiscard.value = false"
      >
        继续编辑</button
      ><button class="button danger" @click="mappingDismiss.discard">
        放弃修改
      </button>
    </div>
    <template #footer
      ><a
        v-if="profile === 'lookup'"
        class="selection-mapping-help"
        href="https://hc.jiandaoyun.com/doc/9024#24数据填充规则"
        target="_blank"
        rel="noopener noreferrer"
        >如何设置填充规则？</a
      ><button class="button" @click="mappingDismiss.requestClose">取消</button
      ><button class="button primary" @click="apply('mapping')">
        完成
      </button></template
    >
  </BaseDialog>
</template>
<style>
.frontend-selection-settings label {
  font-weight: 600;
}
.selection-setting-control {
  width: 200px;
  max-width: 100%;
}
button.selection-setting-control {
  justify-content: space-between;
}
.selection-process-dialog {
  position: fixed;
  inset: 45px 0 0;
  margin: 0;
  height: calc(100dvh - 45px);
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
}
.selection-process-dialog .dialog-header {
  justify-content: center;
  position: relative;
}
.selection-process-dialog .dialog-header > .icon-button {
  position: absolute;
  right: 16px;
}
.selection-process-dialog .dialog-body {
  padding: 0;
  background: #f7f8fa;
}
.selection-process-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  min-height: 100%;
}
.selection-process-preview {
  margin: 20px;
  padding: 16px;
  background: white;
  border-radius: 4px;
  min-width: 0;
}
.selection-process-properties {
  padding: 16px;
  border-left: 1px solid var(--border);
  background: white;
}
.selection-sort {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 80px;
  gap: 8px;
}
.selection-mapping-dialog {
  min-height: 350px;
}
.selection-mapping-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 300px;
}
.selection-mapping-source {
  min-width: 0;
  padding-right: 16px;
  border-right: 1px solid var(--border);
}
.selection-mapping-processing {
  min-width: 0;
  padding-left: 16px;
}
.selection-mapping-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  margin-bottom: 12px;
  font-size: 13px;
}
.selection-mapping-heading .search-input {
  width: 140px;
  padding: 0 6px;
}
.selection-mapping-heading input {
  width: 100%;
  min-width: 0;
  height: 30px;
}
.selection-mapping-fields,
.selection-mapping-targets {
  max-height: 45vh;
  overflow: auto;
}
.selection-mapping-fields .checkbox-line {
  margin: 0;
  min-height: 32px;
}
.selection-mapping-mode {
  width: 100%;
  margin-bottom: 16px;
}
.selection-mapping-mode select {
  width: 100%;
}
.selection-mapping-targets .form-group {
  display: block;
  margin-bottom: 10px;
}
.selection-mapping-targets select {
  width: 100%;
}
.selection-mapping-targets .select-wrap {
  margin-top: 5px;
}
.selection-mapping-help {
  margin-right: auto;
  color: var(--teal);
  font-size: 13px;
  text-decoration: none;
}
.selection-mapping-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) 24px;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.selection-mapping-row > * {
  min-width: 0;
}
@media (max-width: 600px) {
  .selection-mapping-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .selection-mapping-source {
    padding-right: 0;
    border-right: 0;
  }
  .selection-mapping-processing {
    padding-left: 0;
  }
  .selection-mapping-fields {
    max-height: 25vh;
  }
  .selection-process-layout {
    grid-template-columns: 1fr;
  }
  .selection-process-properties {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
  .selection-process-preview {
    margin: 12px;
    padding: 12px;
  }
  .selection-mapping-row {
    grid-template-columns: minmax(0, 1fr) 24px;
  }
  .selection-mapping-row span {
    display: none;
  }
  .selection-mapping-row select {
    grid-column: 1;
  }
  .selection-mapping-row button {
    grid-column: 2;
    grid-row: auto;
  }
}
</style>
