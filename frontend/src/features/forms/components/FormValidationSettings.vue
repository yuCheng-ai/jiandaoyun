<script setup lang="ts">
import { ref } from "vue";
import type { FormSchema, FormValidationRule } from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, uid } from "../../../domain/form";
import {
  formValidationErrors,
  formulaLabel,
} from "../../../domain/formValidation";
import FormulaEditor from "./FormulaEditor.vue";
import FieldTextInput from "./FieldTextInput.vue";
const props = defineProps<{ schema: FormSchema }>();
const open = ref(false),
  error = ref("");
const current = ref<FormValidationRule>({
  id: "",
  expression: "",
  message: "",
  mode: "block",
  realtime: false,
});
let original = "";
const dismiss = useDraftDismiss(
  () => open.value,
  () => current.value,
  () => (open.value = false),
);
function start(rule?: FormValidationRule) {
  current.value = rule
    ? copy(rule)
    : {
        id: uid("validation"),
        expression: "",
        message: "",
        mode: "block",
        realtime: false,
      };
  original = JSON.stringify(rule);
  error.value = "";
  open.value = true;
}
function apply() {
  const rules = props.schema.settings.validations || [];
  if (
    JSON.stringify(rules.find((rule) => rule.id === current.value.id)) !==
    original
  ) {
    error.value = "这条校验已被修改，请关闭后重新打开；本次输入已保留。";
    return;
  }
  error.value =
    formValidationErrors(current.value, props.schema.fields)[0] || "";
  if (error.value) return;
  const index = rules.findIndex((rule) => rule.id === current.value.id);
  if (index < 0)
    props.schema.settings.validations = [...rules, copy(current.value)];
  else
    props.schema.settings.validations = rules.map((rule) =>
      rule.id === current.value.id ? copy(current.value) : rule,
    );
  dismiss.markSaved();
  open.value = false;
}
function move(id: string, to: number) {
  const rules = [...(props.schema.settings.validations || [])],
    from = rules.findIndex((rule) => rule.id === id);
  if (from < 0 || to < 0 || to >= rules.length || from === to) return;
  rules.splice(to, 0, rules.splice(from, 1)[0]!);
  props.schema.settings.validations = rules;
}
function drag(id: string, event: DragEvent) {
  event.dataTransfer?.setData("application/x-form-validation", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function drop(index: number, event: DragEvent) {
  move(
    event.dataTransfer?.getData("application/x-form-validation") || "",
    index,
  );
}
</script>
<template>
  <div class="form-group validation-settings">
    <label>表单提交时</label>
    <button
      type="button"
      class="settings-action-row"
      aria-label="添加校验条件"
      @click="start()"
    >
      <span>校验数据<AppIcon name="help" :size="13" class="muted-icon" /></span
      ><AppIcon name="add" />
    </button>
    <div
      v-for="(rule, index) in schema.settings.validations || []"
      :key="rule.id"
      class="validation-rule-item"
      @dragover.prevent
      @drop.prevent="drop(index, $event)"
    >
      <button
        type="button"
        class="validation-rule-drag"
        draggable="true"
        :aria-label="`移动校验条件 ${index + 1}`"
        title="拖动排序；Alt+↑/↓移动"
        @dragstart="drag(rule.id, $event)"
        @keydown.alt.up.prevent="move(rule.id, index - 1)"
        @keydown.alt.down.prevent="move(rule.id, index + 1)"
      >
        <AppIcon name="list" :size="14" />
      </button>
      <button
        type="button"
        class="validation-rule-summary"
        :aria-label="`编辑校验条件 ${index + 1}`"
        @click="start(rule)"
      >
        {{ formulaLabel(rule.expression, schema.fields) }}
      </button>
      <button
        type="button"
        class="icon-button"
        :aria-label="`删除校验条件 ${index + 1}`"
        @click="
          schema.settings.validations = (
            schema.settings.validations || []
          ).filter((item) => item.id !== rule.id)
        "
      >
        <AppIcon name="trash" :size="14" />
      </button>
    </div>
  </div>
  <BaseDialog
    :open="open"
    title="数据校验设置"
    width="640px"
    class-name="validation-dialog"
    @close="dismiss.requestClose"
  >
    <div class="form-group validation-condition">
      <label>校验条件</label>
      <FormulaEditor
        :validation="current"
        :schema="schema"
        @update-validation="Object.assign(current, $event)"
      />
    </div>
    <div class="form-group validation-message">
      <label
        ><span class="required-mark">*</span>不满足校验条件时的提示文字</label
      >
      <FieldTextInput
        v-model="current.message"
        :fields="schema.fields"
        label="不满足校验条件时的提示文字"
      />
      <label class="checkbox-line"
        ><input
          v-model="current.realtime"
          type="checkbox" />字段修改时实时校验<AppIcon
          name="help"
          :size="13"
          class="muted-icon"
      /></label>
    </div>
    <div class="validation-mode">
      <label>不满足校验条件后</label>
      <label class="checkbox-line"
        ><input
          v-model="current.mode"
          type="radio"
          value="block"
          name="validation-mode"
        />阻止提交</label
      >
      <label class="checkbox-line"
        ><input
          v-model="current.mode"
          type="radio"
          value="warn"
          name="validation-mode"
        />允许忽略并继续提交</label
      >
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      role="alert"
      tabindex="-1"
    >
      校验设置还有未保存的修改。<button
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
<style>
.validation-rule-item {
  display: flex;
  align-items: center;
  margin-top: 8px;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 2px;
}
.validation-rule-drag {
  cursor: grab;
  padding: 4px 2px;
  color: var(--muted);
}
.validation-rule-summary {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px;
}
.validation-dialog {
  font-family:
    -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans",
    sans-serif;
  font-size: 14px;
}
.validation-dialog .dialog-header {
  height: 51px;
  padding: 12px 20px;
}
.validation-dialog .dialog-body {
  padding: 20px;
  min-height: 432px;
}
.validation-dialog .form-group {
  margin-bottom: 16px;
}
.validation-dialog .form-group > label,
.validation-mode > label:first-child {
  display: block;
  font-size: 14px;
  font-weight: 600;
  line-height: 21px;
  margin-bottom: 4px;
}
.validation-dialog .formula-condition-launch {
  height: 160px;
  padding: 8px;
  border: 1px dashed #d8dfe6;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  font-size: 13px;
  font-weight: 400;
}
.validation-dialog .checkbox-line {
  font-size: 13px;
  gap: 4px;
  line-height: 22px;
  font-weight: 400;
}
.validation-dialog .validation-message > .checkbox-line {
  display: flex;
  margin-top: 8px;
  margin-bottom: 0;
}
.validation-dialog .validation-mode > .checkbox-line {
  display: flex;
  height: 30px;
  margin: 0;
}
.validation-dialog input[type="radio"],
.validation-dialog input[type="checkbox"] {
  accent-color: var(--teal);
  width: 16px;
  height: 16px;
}
.validation-dialog .dialog-footer {
  height: 57px;
  padding: 12px 20px;
  gap: 12px;
}
.validation-dialog .dialog-footer .button {
  min-width: 54px;
  height: 32px;
  min-height: 32px;
  padding: 0 12px;
}
.validation-dialog .required-mark {
  color: #d85767;
  margin-right: 2px;
}
.validation-dialog .config-discard {
  margin-top: 12px;
}
</style>
