<script setup lang="ts">
import { ref } from "vue";
import { subformRowCountIssue } from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import {
  copy,
  emptySchema,
  type FormField,
  type FormValues,
} from "../../../domain/form";
import FormFields from "./FormFields.vue";
const props = defineProps<{ field: FormField }>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const open = ref(false),
  buffer = ref<FormValues>({}),
  error = ref("");
const schema = ref(emptySchema());
let original = "";
const fingerprint = () =>
  JSON.stringify([
    props.field.id,
    props.field.children,
    props.field.defaultRows,
  ]);
const dismiss = useDraftDismiss(
  () => open.value,
  () => buffer.value,
  () => {
    open.value = false;
  },
);
function start() {
  const field = copy(props.field);
  field.visible = true;
  field.editable = true;
  field.showLabel = false;
  field.children.forEach((child) => {
    child.visible = true;
    child.editable = true;
  });
  schema.value = emptySchema();
  schema.value.fields = [field];
  buffer.value = { [field.id]: copy(field.defaultRows || []) };
  original = fingerprint();
  error.value = "";
  open.value = true;
}
function apply() {
  if (original !== fingerprint()) {
    error.value = "子表设置已变化，请关闭后重新打开；本次输入已保留。";
    return;
  }
  const issue = subformRowCountIssue(
    props.field,
    (buffer.value[props.field.id] as unknown[]).length,
    props.field.defaultRows?.length,
  );
  if (issue) {
    error.value = issue;
    return;
  }
  emit("update", {
    defaultRows: copy(buffer.value[props.field.id] as FormValues[]),
  });
  dismiss.markSaved();
  open.value = false;
}
</script>
<template>
  <button type="button" class="button subform-default-settings" @click="start">
    设置
  </button>
  <BaseDialog
    :open="open"
    title="默认值"
    width="800px"
    class-name="subform-default-dialog"
    @close="dismiss.requestClose"
  >
    <FormFields
      v-if="open"
      :fields="schema.fields"
      :schema="schema"
      :values="buffer"
      @change="(id, value) => (buffer[id] = value)"
    />
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      role="alertdialog"
      aria-label="放弃默认明细修改？"
      tabindex="-1"
    >
      <span>有尚未确认的修改。</span
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
    <template #footer
      ><button type="button" class="button" @click="dismiss.requestClose">
        取消</button
      ><button type="button" class="button primary" @click="apply">
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.subform-default-settings {
  width: 100%;
  margin-top: 10px;
}
</style>
