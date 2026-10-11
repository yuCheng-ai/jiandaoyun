<script setup lang="ts">
import { ref } from "vue";
import type { FormField } from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { richTextValueIssue, sanitizeRichText } from "../../../domain/richText";
import RichTextEditor from "./RichTextEditor.vue";

const props = defineProps<{ field: FormField }>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const open = ref(false),
  buffer = ref(""),
  error = ref("");
let original = "";
const current = () =>
  JSON.stringify({
    id: props.field.id,
    type: props.field.type,
    value: props.field.defaultValue,
    linked: !!props.field.defaultLink?.enabled,
  });
const dismiss = useDraftDismiss(
  () => open.value,
  () => buffer.value,
  () => {
    open.value = false;
  },
);
function start() {
  original = current();
  buffer.value = String(props.field.defaultValue || "");
  error.value = "";
  open.value = true;
}
function apply() {
  if (current() !== original) {
    error.value = "默认值设置已变化，请重新打开；本次输入已保留。";
    return;
  }
  const value = sanitizeRichText(buffer.value);
  error.value = richTextValueIssue(value, props.field.defaultValue);
  if (error.value) return;
  emit("update", { defaultValue: value });
  dismiss.markSaved();
  open.value = false;
}
</script>

<template>
  <button
    type="button"
    class="button rich-default-settings"
    aria-label="设置富文本默认值"
    @click="start"
  >
    设置
  </button>
  <BaseDialog
    :open="open"
    title="设置默认值"
    width="680px"
    @close="dismiss.requestClose"
  >
    <RichTextEditor
      v-model="buffer"
      label="富文本默认值"
      variant="field"
      :images="false"
    />
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      role="alertdialog"
      aria-label="放弃默认值修改？"
      tabindex="-1"
    >
      <span>有尚未确认的修改。</span>
      <button
        type="button"
        class="text-button"
        @click="dismiss.confirmDiscard.value = false"
      >
        继续编辑
      </button>
      <button type="button" class="text-button" @click="dismiss.discard">
        放弃修改
      </button>
    </div>
    <template #footer>
      <button type="button" class="button" @click="dismiss.requestClose">
        取消
      </button>
      <button type="button" class="button primary" @click="apply">确定</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.rich-default-settings {
  width: 100%;
  margin-top: 10px;
}
</style>
