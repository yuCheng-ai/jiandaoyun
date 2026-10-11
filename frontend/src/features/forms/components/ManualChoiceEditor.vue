<script setup lang="ts">
import { computed, ref } from "vue";
import {
  isMultipleChoice,
  maxChoiceOptions,
  maxChoiceLabelLength,
  optionColor,
  toggleChoice,
} from "@platform/contracts";
import OptionColorPicker from "../../../components/OptionColorPicker.vue";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { uid, type FormField, type FieldOption } from "../../../domain/form";

const props = defineProps<{
  field: FormField;
  disabled?: boolean;
  labelPrefix?: string;
  appearance?: boolean;
  readonlyOptions?: boolean;
}>();
const emit = defineEmits<{ update: [value: Partial<FormField>] }>();
const multiple = computed(() => isMultipleChoice(props.field.type));
const batchOpen = ref(false),
  batchText = ref("");
const dragging = ref(""),
  target = ref(""),
  after = ref(false);
const labels = computed(() =>
  batchText.value
    .split(/\r?\n/)
    .map((label) => label.trim())
    .filter(Boolean),
);
const batchError = computed(() =>
  labels.value.length +
    props.field.options.filter((option) => option.other).length >
  maxChoiceOptions
    ? `最多添加${maxChoiceOptions}个选项，当前有${labels.value.length + props.field.options.filter((option) => option.other).length}个。请减少后再确定。`
    : labels.value.some((label) => label.length > maxChoiceLabelLength)
      ? `选项名称不能超过${maxChoiceLabelLength}个字。请修改后再确定。`
      : "",
);
const prefix = computed(() => props.labelPrefix || "");
const optionsDisabled = computed(() => props.disabled || props.readonlyOptions);
function colors(enabled: boolean) {
  if (props.disabled) return;
  emit("update", {
    coloredOptions: enabled,
    optionColors: Object.fromEntries(
      props.field.options
        .filter((option) => !option.other)
        .map((option, index) => [
          option.id,
          optionColor(props.field, option.id, index),
        ]),
    ),
  });
}

function updateOptions(options: FieldOption[]) {
  if (optionsDisabled.value) return;
  const ids = new Set(options.map((option) => option.id));
  emit("update", {
    options: [
      ...options.filter((option) => !option.other),
      ...options.filter((option) => option.other),
    ],
    ...(props.field.optionColors
      ? {
          optionColors: Object.fromEntries(
            options
              .filter((option) => !option.other)
              .map((option, index) => [
                option.id,
                optionColor(props.field, option.id, index),
              ]),
          ),
        }
      : {}),
    defaultValue: Array.isArray(props.field.defaultValue)
      ? props.field.defaultValue.filter((id) => ids.has(id))
      : ids.has(String(props.field.defaultValue))
        ? props.field.defaultValue
        : "",
  });
}
function toggleDefault(id: string) {
  if (optionsDisabled.value) return;
  const selected = Array.isArray(props.field.defaultValue)
    ? props.field.defaultValue
    : [];
  emit("update", {
    defaultValue: multiple.value
      ? toggleChoice(props.field, selected, id, !selected.includes(id))
      : props.field.defaultValue === id
        ? ""
        : id,
  });
}
function add() {
  if (optionsDisabled.value || props.field.options.length >= maxChoiceOptions)
    return;
  updateOptions([
    ...props.field.options,
    { id: uid("option"), label: `选项${props.field.options.length + 1}` },
  ]);
}
function addOther() {
  if (
    optionsDisabled.value ||
    multiple.value ||
    props.field.options.some((option) => option.other) ||
    props.field.options.length >= maxChoiceOptions
  )
    return;
  updateOptions([
    ...props.field.options,
    { id: uid("option"), label: "其他", other: true },
  ]);
}
function move(id: string, offset: number) {
  if (optionsDisabled.value) return;
  const options = [...props.field.options],
    index = options.findIndex((option) => option.id === id),
    position = index + offset;
  if (
    index < 0 ||
    position < 0 ||
    position >= options.length ||
    options[index]?.other ||
    options[position]?.other
  )
    return;
  [options[index], options[position]] = [options[position]!, options[index]!];
  updateOptions(options);
}
function start(id: string, event: DragEvent) {
  if (optionsDisabled.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  dragging.value = id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
}
function over(id: string, event: DragEvent) {
  if (!dragging.value || optionsDisabled.value) return;
  event.preventDefault();
  target.value = id;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  after.value = event.clientY >= rect.top + rect.height / 2;
}
function end() {
  dragging.value = target.value = "";
}
function drop(id: string, event: DragEvent) {
  if (!dragging.value || optionsDisabled.value) return;
  event.preventDefault();
  const moving = props.field.options.find(
    (option) => option.id === dragging.value,
  );
  if (moving && moving.id !== id) {
    const options = props.field.options.filter(
      (option) => option.id !== moving.id,
    );
    const index = options.findIndex((option) => option.id === id);
    if (index >= 0) {
      options.splice(index + Number(after.value), 0, moving);
      updateOptions(options);
    }
  }
  end();
}
function openBatch() {
  if (optionsDisabled.value) return;
  batchText.value = props.field.options
    .filter((option) => !option.other)
    .map((option) => option.label)
    .join("\n");
  batchOpen.value = true;
}
function batch() {
  if (optionsDisabled.value || batchError.value) return;
  // Match repeated names one by one so an unchanged batch edit never replaces identities.
  const existing = new Map<string, FieldOption[]>();
  for (const option of props.field.options) {
    if (option.other) continue;
    const key = option.label.trim(),
      list = existing.get(key) || [];
    list.push(option);
    existing.set(key, list);
  }
  updateOptions([
    ...labels.value.map((label) => {
      const old = existing.get(label)?.shift();
      return old ? { ...old, label } : { id: uid("option"), label };
    }),
    ...props.field.options.filter((option) => option.other),
  ]);
  batchOpen.value = false;
}
</script>
<template>
  <div class="manual-choice-editor">
    <div v-if="appearance" class="choice-heading">
      <label>选项</label
      ><label class="choice-color-toggle"
        >彩色<input
          type="checkbox"
          role="switch"
          aria-label="彩色选项"
          :checked="field.coloredOptions"
          :disabled="disabled"
          @change="colors(($event.target as HTMLInputElement).checked)"
      /></label>
    </div>
    <div class="manual-option-list">
      <div
        v-for="(option, index) in field.options"
        :key="option.id"
        :class="{
          'drop-before': target === option.id && !after,
          'drop-after': target === option.id && after,
        }"
        @dragover.stop="over(option.id, $event)"
        @drop.stop="drop(option.id, $event)"
      >
        <input
          type="checkbox"
          class="option-default"
          :class="{ single: !multiple }"
          :checked="
            Array.isArray(field.defaultValue)
              ? field.defaultValue.includes(option.id)
              : field.defaultValue === option.id
          "
          :disabled="optionsDisabled"
          :aria-label="`${prefix}默认选中${option.label}`"
          @change="toggleDefault(option.id)"
        />
        <input
          :value="option.label"
          :maxlength="maxChoiceLabelLength"
          :disabled="optionsDisabled"
          :aria-label="`${prefix}选项 ${index + 1}`"
          @input="
            updateOptions(
              field.options.map((item) =>
                item.id === option.id
                  ? {
                      ...item,
                      label: ($event.target as HTMLInputElement).value,
                    }
                  : item,
              ),
            )
          "
        />
        <OptionColorPicker
          v-if="appearance && field.coloredOptions && !option.other"
          :color="optionColor(field, option.id, index)"
          :label="`${prefix}${option.label}`"
          :disabled="disabled"
          @change="
            emit('update', {
              optionColors: { ...field.optionColors, [option.id]: $event },
            })
          "
        />
        <button
          v-if="!option.other"
          type="button"
          class="icon-button option-drag"
          :draggable="!optionsDisabled"
          :disabled="optionsDisabled"
          :aria-label="`${prefix}拖动排序选项 ${index + 1}`"
          title="拖动排序（Alt+↑/↓）"
          @dragstart.stop="start(option.id, $event)"
          @dragend.stop="end"
          @keydown.alt.up.prevent="move(option.id, -1)"
          @keydown.alt.down.prevent="move(option.id, 1)"
        >
          <AppIcon name="list" :size="16" />
        </button>
        <button
          type="button"
          class="icon-button"
          :disabled="optionsDisabled"
          :aria-label="`${prefix}移除选项 ${index + 1}`"
          @click="
            updateOptions(field.options.filter((item) => item.id !== option.id))
          "
        >
          <AppIcon name="trash" :size="15" />
        </button>
      </div>
    </div>
    <div v-if="!readonlyOptions" class="choice-editor-actions">
      <button
        type="button"
        class="text-button"
        :disabled="optionsDisabled || field.options.length >= maxChoiceOptions"
        @click="add"
      >
        添加选项
      </button>
      <button
        v-if="!multiple"
        type="button"
        class="text-button"
        :disabled="
          optionsDisabled ||
          field.options.some((option) => option.other) ||
          field.options.length >= maxChoiceOptions
        "
        @click="addOther"
      >
        添加其他选项
      </button>
      <button
        type="button"
        class="text-button"
        :disabled="optionsDisabled"
        @click="openBatch"
      >
        批量编辑
      </button>
    </div>
    <div v-if="multiple && !readonlyOptions" class="choice-custom-settings">
      <label>选项设置</label>
      <label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.allowCustomChoices"
          :disabled="optionsDisabled"
          @change="
            !optionsDisabled &&
            emit('update', {
              allowCustomChoices: ($event.target as HTMLInputElement).checked,
            })
          "
        />允许成员填写时添加新选项</label
      >
    </div>
    <p v-if="field.options.length >= maxChoiceOptions" class="field-hint">
      最多添加{{ maxChoiceOptions }}个选项
    </p>
    <BaseDialog
      :open="batchOpen"
      title="批量编辑"
      width="680px"
      @close="batchOpen = false"
    >
      <p class="field-hint">每行对应一个选项</p>
      <textarea
        v-model="batchText"
        class="batch-options-text"
        rows="14"
        aria-label="批量选项内容"
        :aria-invalid="!!batchError"
        :aria-describedby="batchError ? 'batch-options-error' : undefined"
      />
      <p
        v-if="batchError"
        id="batch-options-error"
        class="batch-error"
        role="alert"
      >
        {{ batchError }}
      </p>
      <template #footer
        ><button type="button" class="button" @click="batchOpen = false">
          取消</button
        ><button
          type="button"
          class="button primary"
          :disabled="optionsDisabled || !!batchError"
          @click="batch"
        >
          确定
        </button></template
      >
    </BaseDialog>
  </div>
</template>
<style scoped>
.choice-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.choice-heading label {
  margin: 0;
}
.choice-heading .choice-color-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 400;
}
.choice-color-toggle input {
  appearance: none;
  width: 30px;
  height: 17px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: #b9bec4;
  cursor: pointer;
  position: relative;
}
.choice-color-toggle input::after {
  content: "";
  position: absolute;
  width: 13px;
  height: 13px;
  top: 2px;
  left: 2px;
  border-radius: 50%;
  background: white;
}
.choice-color-toggle input:checked {
  background: #00ada1;
}
.choice-color-toggle input:checked::after {
  left: 15px;
}
.manual-option-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 8px;
}
.manual-option-list > div {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}
.manual-option-list input:not([type="checkbox"]) {
  min-width: 0;
  flex: 1;
  width: 100%;
  font-size: 13px;
  height: 32px;
}
.option-default {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
}
.option-default.single {
  appearance: none;
  border: 1px solid #b1b9c4;
  border-radius: 50%;
  background: white;
}
.option-default.single:checked {
  background: #00ada1;
  border-color: #00ada1;
  box-shadow: inset 0 0 0 3px white;
}
.option-default.single:focus-visible {
  outline: 2px solid #00ada1;
  outline-offset: 2px;
}
.manual-option-list .icon-button {
  flex: 0 0 20px;
  min-width: 20px;
  width: 20px;
  height: 26px;
  color: #8c95a3;
}
.option-drag {
  cursor: grab;
}
.option-drag:active {
  cursor: grabbing;
}
.drop-before::before,
.drop-after::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: #00ada1;
  pointer-events: none;
}
.drop-before::before {
  top: -3px;
}
.drop-after::after {
  bottom: -3px;
}
.choice-editor-actions {
  display: flex;
  align-items: center;
  gap: 0;
}
.choice-custom-settings {
  margin-top: 20px;
}
.choice-custom-settings > label:first-child {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
}
.choice-editor-actions button {
  padding: 0 6px;
  font-size: 12px;
}
.choice-editor-actions button:first-child {
  padding-left: 22px;
}
.choice-editor-actions button + button {
  border-left: 1px solid #d8dce3;
}
.batch-options-text {
  width: 100%;
  min-height: 340px;
  resize: vertical;
}
.batch-error {
  color: #d74a49;
  font-size: 12px;
  margin: 8px 0 0;
}
</style>
