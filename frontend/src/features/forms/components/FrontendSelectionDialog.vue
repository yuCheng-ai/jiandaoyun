<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FrontendEvent, FrontendFieldChange } from "@platform/contracts";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  frontendEventScope,
  runFrontendEvent,
} from "../../../domain/frontendEvents";
import {
  isFieldVisibleInSchema,
  type FormSchema,
  type FormValues,
  type FormField,
} from "../../../domain/form";
import {
  lookupSelection,
  lookupScope,
  lookupMultiple,
  applyLookupSelection,
} from "../../../domain/lookup";
import BaseDialog from "../../../components/BaseDialog.vue";
import SelectionRecords from "./SelectionRecords.vue";
const props = defineProps<{
  open: boolean;
  event?: FrontendEvent;
  field?: FormField;
  schema: FormSchema;
  values: FormValues;
  row?: FrontendFieldChange["row"];
}>();
const emit = defineEmits<{
  cancel: [];
  select: [id: string];
  lookup: [ids: string[]];
}>();
const data = useRuntimeData(),
  selectedId = ref(""),
  selectedIds = ref<string[]>([]),
  error = ref("");
const inputs = computed(() =>
  (props.field
    ? lookupScope(props.field, props.schema).inputs
    : frontendEventScope(props.schema, props.event!).fields
  ).filter((field) =>
    isFieldVisibleInSchema(field, props.schema, values.value),
  ),
);
const values = computed(() => ({
  ...props.values,
  ...(props.row && Array.isArray(props.values[props.row.subformId])
    ? (props.values[props.row.subformId] as FormValues[])[props.row.index] || {}
    : {}),
}));
const config = computed(() =>
  props.field
    ? lookupSelection(props.field, data.value)
    : props.event?.selection,
);
const multiple = computed(
  () =>
    !!props.field &&
    lookupMultiple(props.field, props.schema, props.values, props.row),
);
watch([() => props.open, () => props.event?.id, () => props.field?.id], () => {
  selectedId.value = "";
  selectedIds.value = [];
  error.value = "";
});
function choose(id: string) {
  selectedId.value = id;
  error.value = "";
  if (props.field && !multiple.value) confirm();
}
function confirm() {
  if (props.field) {
    try {
      const ids = multiple.value
        ? selectedIds.value
        : selectedId.value
          ? [selectedId.value]
          : [];
      applyLookupSelection(
        props.field,
        props.schema,
        props.values,
        data.value,
        ids,
        props.row,
      );
      emit("lookup", ids);
    } catch (e) {
      error.value = (e as Error).message;
    }
    return;
  }
  if (!selectedId.value) {
    error.value = "请选择一条数据";
    return;
  }
  const run = runFrontendEvent(
    props.event!,
    props.schema,
    props.values,
    data.value,
    props.row,
    false,
    selectedId.value,
  );
  error.value = run.error?.message || "";
  if (run.status === "success") emit("select", selectedId.value);
}
</script>
<template>
  <BaseDialog
    :open="open"
    title="选择数据"
    width="820px"
    @close="emit('cancel')"
  >
    <SelectionRecords
      v-if="config"
      :config="config"
      :profile="field ? 'lookup' : 'event'"
      :multiple="multiple"
      :selected-ids="selectedIds"
      :data="data"
      :values="values"
      :inputs="inputs"
      :selected-id="selectedId"
      @select="choose"
      @change-selection="
        selectedIds = $event;
        error = '';
      "
    />
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <template #footer
      ><button type="button" class="button" @click="emit('cancel')">取消</button
      ><button
        v-if="!field || multiple"
        type="button"
        class="button primary"
        @click="confirm"
      >
        确定
      </button></template
    >
  </BaseDialog>
</template>
