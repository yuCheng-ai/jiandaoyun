<script setup lang="ts">
import { computed, ref } from "vue";
import type { FrontendDataSelection } from "@platform/contracts";
import type { FormField, FormSchema } from "../../../domain/form";
import {
  lookupSelection,
  lookupScope,
  createLookupFields,
} from "../../../domain/lookup";
import { selectionSourceFields } from "../../../domain/frontendSelections";
import { useWorkspaceStore } from "../../../stores/workspace";
import FrontendSelectionSettings from "./FrontendSelectionSettings.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import BaseDialog from "../../../components/BaseDialog.vue";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  applySchema?: (schema: FormSchema) => void;
}>();
const emit = defineEmits<{ update: [value: Partial<FormField>] }>();
const store = useWorkspaceStore(),
  displayOpen = ref(false),
  displayDraft = ref<string[]>([]);
const displayDismiss = useDraftDismiss(
  () => displayOpen.value,
  () => displayDraft.value,
  () => {
    displayOpen.value = false;
  },
);
const selection = computed(() => lookupSelection(props.field, store.data));
const scope = computed(() => lookupScope(props.field, props.schema));
const source = computed(() =>
  selectionSourceFields(store.data, props.field.referenceFormId, "lookup"),
);
function update(value: FrontendDataSelection) {
  const { columnLabels: _labels, ...reference } = props.field.reference;
  emit("update", {
    referenceFormId: value.formId,
    ...(value.formId !== props.field.referenceFormId
      ? { referenceFieldId: "" }
      : {}),
    reference: {
      ...reference,
      ...(value.columnLabels !== undefined
        ? { columnLabels: value.columnLabels }
        : {}),
      mode: "forward",
      columns: value.columns,
      filters: value.filters,
      match: value.match,
      sort: value.sort,
      mappings: value.mappings,
      ...(value.formId !== props.field.referenceFormId
        ? { displayColumns: [] }
        : {}),
    },
  });
}
function startDisplay() {
  displayDraft.value = [...(props.field.reference.displayColumns || [])];
  displayOpen.value = true;
}
function createFields(sourceIds: string[]) {
  if (!props.applySchema) throw Error("当前编辑器不支持创建填充字段");
  props.applySchema(
    createLookupFields(props.schema, props.field.id, sourceIds, store.data),
  );
}
function applyDisplay() {
  emit("update", {
    reference: { ...props.field.reference, displayColumns: displayDraft.value },
  });
  displayDismiss.markSaved();
  displayOpen.value = false;
}
</script>
<template>
  <FrontendSelectionSettings
    :model-value="selection"
    :inputs="scope.inputs"
    :outputs="scope.outputs"
    :row-scoped="!!scope.owner"
    :create-fields="applySchema ? createFields : undefined"
    profile="lookup"
    :button-text="field.buttonText === '按钮' ? '选择数据' : field.buttonText"
    @update:model-value="update"
    @update:button-text="emit('update', { buttonText: $event })"
  >
    <template #before-mappings>
      <div class="form-group">
        <label>显示在表单中</label
        ><button
          class="button full-width"
          :disabled="!source.length"
          @click="startDisplay"
        >
          设置显示字段
        </button>
      </div>
    </template>
  </FrontendSelectionSettings>
  <BaseDialog
    :open="displayOpen"
    title="显示在表单中"
    width="600px"
    @close="displayDismiss.requestClose"
  >
    <label v-for="field in source" :key="field.id" class="checkbox-line"
      ><input
        type="checkbox"
        :checked="displayDraft.includes(field.id)"
        :aria-label="`表单显示字段 ${field.pathLabel}`"
        @change="
          displayDraft = displayDraft.includes(field.id)
            ? displayDraft.filter((id) => id !== field.id)
            : [...displayDraft, field.id]
        "
      />{{ field.pathLabel }}</label
    >
    <div v-if="displayDismiss.confirmDiscard.value" class="config-discard">
      <p>修改尚未保存，是否放弃？</p>
      <button
        class="button"
        @click="displayDismiss.confirmDiscard.value = false"
      >
        继续编辑</button
      ><button class="button danger" @click="displayDismiss.discard">
        放弃修改
      </button>
    </div>
    <template #footer
      ><button class="button" @click="displayDismiss.requestClose">取消</button
      ><button class="button primary" @click="applyDisplay">
        完成
      </button></template
    >
  </BaseDialog>
</template>
