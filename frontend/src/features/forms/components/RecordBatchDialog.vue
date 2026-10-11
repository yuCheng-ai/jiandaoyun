<script setup lang="ts">
import { computed, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import FieldControl from "./FieldControl.vue";
import FormulaEditor from "./FormulaEditor.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useWorkspaceStore } from "../../../stores/workspace";
import { copy, type FormSchema } from "../../../domain/form";
import {
  recordBatchFields,
  recordBatchFormulaFields,
  type RecordBatchChange,
} from "../../../domain/recordBatch";
import { formulaLabel } from "../../../domain/formValidation";
import type { FormEntry } from "../../../domain/workspace";

const props = defineProps<{
  formId: string;
  schema: FormSchema;
  entries: FormEntry[];
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useWorkspaceStore();
const candidates = computed(() =>
  recordBatchFields(props.schema).filter((target) =>
    props.entries.every((entry) => {
      const schema = store.data.forms
        .find((form) => form.id === props.formId)
        ?.versions.find(
          (version) => version.version === entry.definitionVersion,
        )?.schema;
      return (
        schema &&
        recordBatchFields(schema).some(
          (item) =>
            item.field.id === target.field.id &&
            item.field.type === target.field.type &&
            item.parent?.id === target.parent?.id,
        )
      );
    }),
  ),
);
const fieldId = ref(candidates.value[0]?.field.id || ""),
  mode = ref<RecordBatchChange["mode"]>("fixed"),
  value = ref<unknown>(""),
  expression = ref("");
const field = computed(() => {
  const target = candidates.value.find(
    (target) => target.field.id === fieldId.value,
  )?.field;
  return target
    ? {
        ...target,
        editable: true,
        required: false,
        min: undefined,
        max: undefined,
        maxLength: 0,
        dateRange: undefined,
        expression: expression.value,
      }
    : undefined;
});
const formulaSchema = computed(() => ({
  ...props.schema,
  fields: recordBatchFormulaFields(props.schema, fieldId.value),
}));
const dismiss = useDraftDismiss(
  () => true,
  () => ({
    fieldId: fieldId.value,
    mode: mode.value,
    value: value.value,
    expression: expression.value,
  }),
  () => emit("close"),
);
watch(fieldId, () => {
  value.value = "";
  expression.value = "";
});
async function save() {
  if (!field.value) return;
  const selection = props.entries.map((entry) => ({
    id: entry.id,
    definitionVersion: entry.definitionVersion,
    values: copy(entry.values),
  }));
  if (
    await store.batchUpdateEntries(props.formId, selection, {
      fieldId: fieldId.value,
      mode: mode.value,
      value: value.value,
      expression: expression.value,
    })
  ) {
    dismiss.markSaved();
    store.notify(`已修改 ${selection.length} 条记录`);
    emit("saved");
  }
}
</script>
<template>
  <BaseDialog
    :open="true"
    title="批量修改"
    width="760px"
    :busy="store.writePending"
    @close="dismiss.requestClose"
  >
    <template #header
      ><div class="record-batch-heading">
        <h2>批量修改</h2>
        <span
          >本次操作将修改 <strong>{{ entries.length }}</strong> 条数据</span
        >
      </div></template
    >
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      tabindex="-1"
    >
      <span>修改尚未保存。</span
      ><button class="button" @click="dismiss.confirmDiscard.value = false">
        继续编辑</button
      ><button class="button" @click="dismiss.discard">放弃修改</button>
    </div>
    <p class="dialog-description">
      每次最多修改 50000 条数据，保存后无法撤销。
    </p>
    <p class="field-hint">
      只修改所选字段，不触发联动、公式重算、校验或智能助手。唯一值字段不支持批量修改。
    </p>
    <fieldset class="record-controls-lock" :disabled="store.writePending">
      <div class="record-batch-inputs">
        <label for="record-batch-field">请选择需要修改的字段</label>
        <select id="record-batch-field" v-model="fieldId">
          <option v-if="!candidates.length" value="">
            没有共同支持批量修改的字段
          </option>
          <option
            v-for="target in candidates"
            :key="target.field.id"
            :value="target.field.id"
          >
            {{ target.label }}
          </option>
        </select>
        <div class="record-batch-mode">
          <label for="record-batch-mode">修改为</label
          ><select id="record-batch-mode" v-model="mode">
            <option value="fixed">固定值</option>
            <option value="formula">公式计算值</option>
            <option value="empty">空值</option>
          </select>
        </div>
        <div v-if="field && mode === 'fixed'" class="record-batch-value">
          <FieldControl
              :fields="schema.fields"
            :field="field"
            :label="'批量修改值'"
            :values="entries[0]?.values"
            :model-value="value"
            :edit-serial="true"
            @update:model-value="value = $event"
          />
        </div>
        <template v-else-if="field && mode === 'formula'">
          <FormulaEditor
            :field="field"
            :schema="formulaSchema"
            batch
            @update="expression = $event.expression || ''"
          />
          <p v-if="expression" class="field-hint">
            {{ formulaLabel(expression, formulaSchema.fields) }}
          </p>
        </template>
      </div>
    </fieldset>
    <template #footer
      ><button class="button" @click="dismiss.requestClose">取消</button
      ><button class="button primary" :disabled="!field" @click="save">
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.record-batch-inputs {
  display: grid;
  gap: 10px;
  padding: 22px 0;
}
.record-batch-inputs select {
  max-width: 320px;
  height: 34px;
}
.record-batch-inputs label:not(:first-child) {
  margin-top: 16px;
}
.record-batch-heading,
.record-batch-mode {
  display: flex;
  align-items: center;
  gap: 14px;
}
.record-batch-heading {
  flex-wrap: wrap;
}
.record-batch-heading span {
  color: #7c8797;
  font-size: 13px;
}
.record-batch-heading strong {
  color: #ed6b64;
  font-weight: normal;
}
.record-batch-mode {
  margin-top: 20px;
}
.record-batch-mode label {
  white-space: nowrap;
}
.record-batch-mode select {
  max-width: 180px;
}
.record-batch-value :deep(input),
.record-batch-value :deep(textarea) {
  width: 100%;
  min-height: 34px;
  border: 1px solid #d9dfe6;
  border-radius: 4px;
  padding: 6px 10px;
  font: inherit;
}
.record-batch-value :deep(.number-control) {
  width: 100%;
}
</style>
