<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  FormSchema,
  HiddenValueMode,
  FormField,
} from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, createField } from "../../../domain/form";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
const props = defineProps<{ schema: FormSchema }>();
const modes: { id: HiddenValueMode; label: string; hint: string }[] = [
  {
    id: "recalculate",
    label: "始终重新计算",
    hint: "不可见字段始终根据最新数据重新计算",
  },
  { id: "retain", label: "保持原值", hint: "不可见字段的原有值保持不变" },
  { id: "clear", label: "空值", hint: "提交时清空不可见字段的值" },
];
const open = ref(false),
  buffer = ref<Record<string, HiddenValueMode>>({}),
  error = ref("");
let original = "";
const dismiss = useDraftDismiss(
  () => open.value,
  () => buffer.value,
  () => (open.value = false),
);
const groups = computed(() =>
  ["clear", "retain", "recalculate"].flatMap((id) =>
    modes.filter(
      (mode) =>
        mode.id === id && mode.id !== props.schema.settings.hiddenValues,
    ),
  ),
);
const fields = computed(() => {
  const result: { field: FormField; label: string }[] = [];
  function visit(items: FormField[], path = "") {
    for (const field of items) {
      const label = path + field.label;
      if (
        !["tabs", "divider", "button", "serial", "query"].includes(field.type)
      )
        result.push({ field, label });
      visit(field.children, `${label} / `);
    }
  }
  visit(props.schema.fields);
  return result;
});
const picker = createField("select", {
  id: "hidden-assignment-field",
  placeholder: "添加字段",
});
const name = (id: string) =>
  fields.value.find((item) => item.field.id === id)?.label || "已删除字段";
const selected = (mode: HiddenValueMode) =>
  Object.keys(buffer.value).filter((id) => buffer.value[id] === mode);
function setMode(event: Event) {
  props.schema.settings.hiddenValues = (event.target as HTMLSelectElement)
    .value as HiddenValueMode;
  props.schema.settings.hiddenValueRules = copy(
    props.schema.settings.hiddenValueRules || {},
  );
}
function start() {
  buffer.value = copy(props.schema.settings.hiddenValueRules || {});
  original = JSON.stringify(props.schema.settings.hiddenValueRules);
  error.value = "";
  open.value = true;
}
function add(mode: HiddenValueMode, value: unknown) {
  if (
    typeof value === "string" &&
    fields.value.some((item) => item.field.id === value)
  )
    buffer.value[value] = mode;
}
function apply() {
  if (original !== JSON.stringify(props.schema.settings.hiddenValueRules)) {
    error.value = "赋值规则已被修改，请关闭后重新打开；本次选择已保留。";
    return;
  }
  props.schema.settings.hiddenValueRules = copy(buffer.value);
  dismiss.markSaved();
  open.value = false;
}
</script>
<template>
  <div class="form-group hidden-value-settings">
    <label for="hidden-values"
      >不可见字段赋值 <AppIcon name="help" :size="13" class="muted-icon"
    /></label>
    <div class="setting-with-action">
      <div class="select-wrap">
        <select
          id="hidden-values"
          :value="schema.settings.hiddenValues"
          @change="setMode"
        >
          <option v-for="mode in modes" :key="mode.id" :value="mode.id">
            {{ mode.label }}
          </option></select
        ><AppIcon name="down" />
      </div>
      <button
        type="button"
        class="button icon-button"
        aria-label="特殊字段赋值规则"
        @click="start"
      >
        <AppIcon name="settings" />
      </button>
    </div>
    <p class="field-hint">
      {{ modes.find((mode) => mode.id === schema.settings.hiddenValues)?.hint }}
    </p>
  </div>
  <BaseDialog
    :open="open"
    title="特殊字段赋值规则"
    width="600px"
    class-name="hidden-assignment-dialog"
    @close="dismiss.requestClose"
  >
    <p class="hidden-assignment-description">
      此处设置的字段，不可见时按照下方对应规则赋值，不受默认赋值规则的影响
    </p>
    <section
      v-for="group in groups"
      :key="group.id"
      class="hidden-assignment-group"
    >
      <div class="hidden-assignment-heading">
        <label
          >{{ group.label }} <AppIcon name="help" :size="13" class="muted-icon"
        /></label>
        <div class="hidden-assignment-add">
          <AppIcon name="add" :size="14" /><ChoiceFieldControl
            class="hidden-field-picker"
            :field="picker"
            :choices="
              fields
                .filter((item) => buffer[item.field.id] !== group.id)
                .map((item) => ({ id: item.field.id, label: item.label }))
            "
            model-value=""
            :label="`添加${group.label}字段`"
            @update:model-value="add(group.id, $event)"
          />
        </div>
      </div>
      <div class="hidden-assignment-fields">
        <span
          v-for="id in selected(group.id)"
          :key="id"
          class="hidden-assignment-tag"
          ><span>{{ name(id) }}</span
          ><button
            type="button"
            class="icon-button"
            :aria-label="`移除${name(id)}的${group.label}规则`"
            @click="delete buffer[id]"
          >
            <AppIcon name="close" :size="13" /></button
        ></span>
      </div>
    </section>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      role="alert"
      tabindex="-1"
    >
      赋值规则还有未保存的修改。<button
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
      ><a
        class="text-button hidden-assignment-help"
        href="https://hc.jiandaoyun.com/doc/9041"
        target="_blank"
        rel="noopener"
        >查看帮助文档</a
      ><button type="button" class="button" @click="dismiss.requestClose">
        取消</button
      ><button type="button" class="button primary" @click="apply">
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style>
.hidden-assignment-dialog {
  border: 0;
  font-family:
    -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans",
    sans-serif;
}
.hidden-assignment-dialog .dialog-header {
  min-height: 51px;
  height: 51px;
  padding: 12px 20px;
}
.hidden-assignment-dialog .dialog-header h2 {
  font-size: 18px;
  line-height: 26px;
  font-weight: 700;
}
.hidden-assignment-dialog .dialog-header > .icon-button {
  width: 24px;
  height: 24px;
}
.hidden-assignment-dialog .dialog-body {
  min-height: 392px;
  padding: 20px;
}
.hidden-assignment-description {
  font-size: 12px;
  line-height: 17px;
  color: var(--muted);
  margin: 0;
}
.hidden-assignment-group {
  margin-bottom: 15px;
}
.hidden-assignment-group + .hidden-assignment-group {
  border-top: 1px solid var(--border);
  padding-top: 15px;
}
.hidden-assignment-heading {
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hidden-assignment-heading > label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  line-height: 21px;
}
.hidden-assignment-add {
  display: flex;
  gap: 3px;
  align-items: center;
  color: var(--teal);
}
.hidden-field-picker {
  width: 56px;
  flex-shrink: 0;
}
.hidden-assignment-heading .hidden-field-picker summary {
  border: 0;
  min-height: 22px;
  color: var(--teal);
  padding: 0;
  background: transparent;
}
.hidden-assignment-heading .choice-placeholder {
  color: var(--teal);
  white-space: nowrap;
}
.hidden-field-picker summary > svg {
  display: none;
}
.hidden-assignment-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.hidden-assignment-fields:empty { margin-top: 0; }
.hidden-assignment-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border: 1px solid var(--border);
  padding: 3px 6px;
  border-radius: 3px;
}
.hidden-assignment-tag > span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.hidden-assignment-tag .icon-button {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
}
.hidden-assignment-dialog .dialog-footer {
  gap: 12px;
  min-height: 57px;
  height: 57px;
  padding: 12px 20px;
}
.hidden-assignment-dialog .dialog-footer .button {
  height: 32px;
  min-height: 32px;
  min-width: 0;
  padding: 0 12px;
}
.hidden-assignment-help {
  margin-right: auto;
  text-decoration: none;
}
@media (max-width: 600px) {
  .hidden-assignment-dialog .dialog-body {
    min-height: 320px;
  }
}
</style>
