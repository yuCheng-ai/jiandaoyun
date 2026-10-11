<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import {
  isMultipleChoice,
  isChoiceTextValue,
  choiceValueKey,
  equalFieldValues,
  maxChoiceTextLength,
  optionColor,
  toggleChoice,
  type ChoiceValue,
  type ChoiceTextValue,
  type FieldOption,
  type FormField,
} from "@platform/contracts";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";
import AddChoiceControl from "./AddChoiceControl.vue";
const props = defineProps<{
  field: FormField;
  choices?: FieldOption[];
  modelValue?: unknown;
  disabled?: boolean;
  label: string;
  inputId?: string;
  placeholder?: string;
  clearableRadio?: boolean;
  /** Bounded configuration pickers; ordinary field validation remains unchanged. */
  maxSelections?: number;
  /** Fields already bound elsewhere remain visible but cannot be selected. */
  disabledOptionIds?: string[];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: ChoiceValue | ChoiceValue[]];
}>();
const multiple = computed(() => isMultipleChoice(props.field.type));
const dropdown = computed(() =>
  ["select", "multiselect"].includes(props.field.type),
);
const choices = computed(() => props.choices || props.field.options);
function values(value: unknown): ChoiceValue[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter(
    (item): item is ChoiceValue =>
      typeof item === "string" || isChoiceTextValue(item),
  );
}
const selected = computed(() => values(props.modelValue));
const extras = ref<ChoiceTextValue[]>([]);
type RuntimeOption = FieldOption & {
  key: string;
  value: ChoiceValue;
  custom?: boolean;
};
const runtimeChoices = computed<RuntimeOption[]>(() => [
  ...choices.value.map((option) => ({
    ...option,
    key: choiceValueKey(option.id),
    value: option.id,
  })),
  ...extras.value.map((value) => ({
    id: "",
    label: value.text,
    key: choiceValueKey(value),
    value,
    custom: true,
  })),
]);
const selectedOptions = computed(() =>
  selected.value
    .map((value) =>
      runtimeChoices.value.find(
        (option) => option.key === choiceValueKey(value),
      ),
    )
    .filter((option): option is RuntimeOption => !!option),
);
const selectedOther = computed(() =>
  selectedOptions.value.find((option) => option.other),
);
const otherText = computed(() =>
  isChoiceTextValue(props.modelValue) ? props.modelValue.text : "",
);
const canAdd = computed(
  () =>
    multiple.value &&
    props.field.allowCustomChoices &&
    props.field.choiceSource.mode === "manual" &&
    !props.disabled,
);
let pending = false,
  lastEmitted: unknown;
function commit(value: ChoiceValue | ChoiceValue[]) {
  if (props.disabled) return;
  if (
    Array.isArray(value) &&
    props.maxSelections !== undefined &&
    value.length > props.maxSelections
  )
    return;
  pending = true;
  lastEmitted = value;
  emit("update:modelValue", value);
}
watch(
  () => props.modelValue,
  (value, previous) => {
    if (pending && equalFieldValues(value, lastEmitted)) pending = false;
    else if (!equalFieldValues(value, previous)) {
      pending = false;
      extras.value = values(value).filter(
        (item): item is ChoiceTextValue =>
          isChoiceTextValue(item) && !item.optionId,
      );
    }
  },
  { immediate: true, deep: true },
);
function checked(option: RuntimeOption) {
  return (
    (!multiple.value && !selected.value.length && option.id === "") ||
    selected.value.some((value) => choiceValueKey(value) === option.key)
  );
}
function unavailable(option: RuntimeOption) {
  return (
    !!props.disabledOptionIds?.includes(option.id) ||
    (props.maxSelections !== undefined &&
      !checked(option) &&
      selected.value.length >= props.maxSelections)
  );
}
function add(text: string) {
  if (!canAdd.value) return;
  const value = { text };
  extras.value.push(value);
  commit(
    toggleChoice<ChoiceValue>(
      props.field,
      selected.value,
      value,
      true,
      choices.value,
    ),
  );
}
function supplement(text: string) {
  if (selectedOther.value) commit({ optionId: selectedOther.value.id, text });
}
const query = ref(""),
  open = ref(false),
  trigger = ref<HTMLElement>(),
  panel = ref<HTMLElement>(),
  panelId = useId();
const keywords = computed(() => {
  const text = query.value.toLocaleLowerCase().trim();
  return text ? (multiple.value ? text.split(/\s+/u) : [text]) : [];
});
const filtered = computed(() =>
  runtimeChoices.value.filter(
    (option) =>
      !keywords.value.length ||
      keywords.value.some((keyword) =>
        option.label.toLocaleLowerCase().includes(keyword),
      ),
  ),
);
const selectableFiltered = computed(() =>
  filtered.value.filter(
    (option) => !props.disabledOptionIds?.includes(option.id),
  ),
);
const allChecked = computed(
  () =>
    !!selectableFiltered.value.length &&
    selectableFiltered.value.every(checked),
);
const partlyChecked = computed(
  () => !allChecked.value && selectableFiltered.value.some(checked),
);
function selectAll(checked: boolean) {
  if (props.disabled || !multiple.value || !selectableFiltered.value.length)
    return;
  const keys = new Set(selectableFiltered.value.map((option) => option.key));
  const selectedKeys = new Set(selected.value.map(choiceValueKey));
  commit(
    checked
      ? [
          ...selected.value,
          ...selectableFiltered.value
            .filter((option) => !selectedKeys.has(option.key))
            .map((option) => option.value),
        ]
      : selected.value.filter((value) => !keys.has(choiceValueKey(value))),
  );
}
const position = ref({
  left: "0px",
  top: "0px",
  width: "0px",
  maxHeight: "300px",
});
const { zIndex } = useDialogLayer(panel, close, () => {}, {
  modal: false,
  anchor: () => trigger.value,
});
function colorStyle(option: RuntimeOption) {
  if (!props.field.coloredOptions) return;
  if (option.other || option.custom)
    return { backgroundColor: "#f1f3f6", color: "#485970" };
  const color = optionColor(
    props.field,
    option.id,
    choices.value.findIndex((item) => item.id === option.id),
  );
  const rgb = [1, 3, 5].map((index) =>
    parseInt(color.slice(index, index + 2), 16),
  );
  return {
    backgroundColor: color,
    color:
      rgb[0]! * 0.299 + rgb[1]! * 0.587 + rgb[2]! * 0.114 > 180
        ? "#293644"
        : "#fff",
  };
}
function change(option: RuntimeOption, checked = true) {
  if (props.disabled || (checked && unavailable(option))) return;
  commit(
    multiple.value
      ? toggleChoice<ChoiceValue>(
          props.field,
          selected.value,
          option.value,
          checked,
          choices.value,
        )
      : (selected.value.find((value) => choiceValueKey(value) === option.key) ??
          option.value),
  );
  if (!multiple.value) close();
}
function close() {
  open.value = false;
}
async function show() {
  if (props.disabled) return;
  if (open.value) return close();
  const rect = trigger.value!.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 12,
    above = rect.top - 12;
  const height = Math.max(80, Math.min(300, Math.max(below, above)));
  const width = Math.min(Math.max(180, rect.width), window.innerWidth - 16);
  const upwards = below < Math.min(300, above);
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${below >= Math.min(300, above) ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`,
    width: `${width}px`,
    maxHeight: `${height}px`,
  };
  query.value = "";
  open.value = true;
  await nextTick();
  if (upwards && panel.value)
    position.value.top = `${Math.max(8, rect.top - panel.value.getBoundingClientRect().height - 4)}px`;
  panel.value?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
}
function keys(event: KeyboardEvent) {
  const items = Array.from(
    panel.value?.querySelectorAll<HTMLElement>(
      ".choice-popup-list button:not(:disabled), .choice-popup-list input:not(:disabled)",
    ) || [],
  );
  const index = items.indexOf(event.target as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[
      index < 0
        ? step > 0
          ? 0
          : items.length - 1
        : (index + step + items.length) % items.length
    ]?.focus();
  }
}
function scroll(event: Event) {
  if (!panel.value?.contains(event.target as Node)) close();
}
watch(() => props.disabled, close);
watch([() => props.field.id, () => props.field.type], () => {
  close();
  extras.value = selected.value.filter(
    (item): item is ChoiceTextValue =>
      isChoiceTextValue(item) && !item.optionId,
  );
});
onMounted(() => {
  window.addEventListener("resize", close);
  window.addEventListener("scroll", scroll, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", close);
  window.removeEventListener("scroll", scroll, true);
});
</script>
<template>
  <div
    v-if="!dropdown"
    class="runtime-options choice-group"
    :class="{ vertical: field.choiceLayout === 'vertical' }"
    :role="multiple ? 'group' : 'radiogroup'"
    :aria-label="label"
  >
    <div
      v-for="option in runtimeChoices"
      :key="option.key"
      class="choice-group-item"
    >
      <label
        ><input
          :type="multiple ? 'checkbox' : 'radio'"
          :name="inputId || field.id + '-' + label"
          :value="option.custom ? option.key : option.id"
          :checked="checked(option)"
          :disabled="disabled"
          :aria-label="`${label} ${option.label}`"
          @change="change(option, ($event.target as HTMLInputElement).checked)"
        /><span
          :class="{ 'choice-tag': field.coloredOptions }"
          :style="colorStyle(option)"
          >{{ option.label }}</span
        ></label
      ><input
        v-if="option.other && checked(option)"
        class="choice-other-text"
        :value="otherText"
        :maxlength="maxChoiceTextLength"
        :disabled="disabled"
        :aria-label="`${label}其他说明`"
        placeholder="请填写内容"
        @input="supplement(($event.target as HTMLInputElement).value)"
      />
    </div>
    <div v-if="canAdd" class="choice-add-row">
      <AddChoiceControl
        :label="label"
        :existing="runtimeChoices.map((option) => option.label)"
        @add="add"
      />
    </div>
    <button
      v-if="
        clearableRadio && field.type === 'radio' && selected.length && !disabled
      "
      type="button"
      class="text-button"
      @click="commit('')"
    >
      清空选择
    </button>
  </div>
  <div v-else class="choice-dropdown" :class="{ disabled }">
    <details :open="open">
      <summary
        :id="inputId"
        ref="trigger"
        role="combobox"
        aria-haspopup="dialog"
        :aria-label="label"
        :aria-expanded="open"
        :aria-controls="open ? panelId : undefined"
        :aria-disabled="disabled"
        :tabindex="disabled ? -1 : 0"
        @click.prevent="show"
        @keydown.down.prevent="show"
      >
        <span v-if="selectedOptions.length" class="choice-selected"
          ><template
            v-for="(option, index) in selectedOptions"
            :key="option.key"
            ><span v-if="index && !field.coloredOptions">、</span
            ><span
              :class="{ 'choice-tag': field.coloredOptions }"
              :style="colorStyle(option)"
              >{{ option.label }}</span
            ></template
          ></span
        >
        <span v-else class="choice-placeholder">{{
          selected.length
            ? `已选择 ${selected.length} 项`
            : placeholder ?? (field.placeholder || "请选择")
        }}</span
        ><AppIcon name="down" :size="14" />
      </summary>
    </details>
    <input
      v-if="selectedOther"
      class="choice-other-text dropdown-other"
      :value="otherText"
      :maxlength="maxChoiceTextLength"
      :disabled="disabled"
      :aria-label="`${label}其他说明`"
      placeholder="请填写内容"
      @input="supplement(($event.target as HTMLInputElement).value)"
    />
    <Teleport to="body">
      <div
        v-if="open"
        :id="panelId"
        ref="panel"
        class="choice-popup"
        role="dialog"
        :aria-label="`${label}选项`"
        :style="{ ...position, zIndex }"
        @keydown="keys"
      >
        <input
          v-model="query"
          type="search"
          :aria-label="`${label}搜索选项`"
          :placeholder="multiple ? '搜索（多个关键词用空格隔开）' : '搜索'"
        />
        <div
          class="choice-popup-list"
          :role="multiple ? 'group' : 'listbox'"
          :aria-label="`${label}可选项`"
        >
          <label
            v-if="multiple && maxSelections === undefined"
            class="choice-select-all"
          >
            <input
              type="checkbox"
              :checked="allChecked"
              :indeterminate="partlyChecked"
              :disabled="!selectableFiltered.length"
              :aria-label="`${label}${keywords.length ? '搜索结果全选' : '全选'}`"
              :aria-checked="partlyChecked ? 'mixed' : allChecked"
              @change="selectAll(($event.target as HTMLInputElement).checked)"
            /><span>{{ keywords.length ? "搜索结果全选" : "全选" }}</span>
          </label>
          <label v-if="multiple" v-for="option in filtered" :key="option.key"
            ><input
              type="checkbox"
              :value="option.custom ? option.key : option.id"
              :checked="checked(option)"
              :disabled="unavailable(option)"
              :aria-label="`${label} ${option.label}`"
              @change="
                change(option, ($event.target as HTMLInputElement).checked)
              "
            /><span
              :class="{ 'choice-tag': field.coloredOptions }"
              :style="colorStyle(option)"
              >{{ option.label }}</span
            ></label
          >
          <template v-else
            ><button
              v-for="option in filtered"
              :key="option.key"
              type="button"
              role="option"
              :aria-selected="checked(option)"
              :disabled="unavailable(option)"
              @click="change(option)"
            >
              <span
                :class="{ 'choice-tag': field.coloredOptions }"
                :style="colorStyle(option)"
                >{{ option.label }}</span
              >
            </button></template
          >
          <span v-if="!filtered.length" class="muted">{{
            query ? "没有匹配选项" : "暂无可选项"
          }}</span>
        </div>
        <AddChoiceControl
          v-if="canAdd"
          :label="label"
          :existing="runtimeChoices.map((option) => option.label)"
          @add="add"
        />
        <button
          v-if="selected.length && !choices.some((option) => option.id === '')"
          type="button"
          class="text-button choice-clear"
          @click="
            commit(multiple ? [] : '');
            if (!multiple) close();
          "
        >
          清空选择
        </button>
      </div>
    </Teleport>
  </div>
</template>
<style scoped>
.choice-group.vertical {
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.choice-group input[type="radio"],
.choice-group input[type="checkbox"],
.choice-popup-list input {
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  flex: 0 0 16px;
}
.choice-group-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  max-width: 100%;
}
.choice-group-item label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
}
.choice-other-text {
  width: 180px;
  min-width: 0;
  max-width: 100%;
  height: 32px;
  font-size: 13px;
}
.choice-group .choice-other-text {
  width: 180px;
  flex: 0 1 180px;
}
.choice-add-row {
  flex-basis: 100%;
}
.dropdown-other {
  display: block;
  width: 100%;
  margin-top: 6px;
}
.choice-tag {
  border-radius: 4px;
  padding: 3px 7px;
  line-height: 1.5;
  display: inline-block;
}
.choice-dropdown {
  max-width: var(--input-width, 354px);
  min-width: 0;
}
.choice-dropdown summary {
  list-style: none;
  border: 1px solid #dce2e8;
  border-radius: 4px;
  background: white;
  padding: 7px 10px;
  min-height: 34px;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}
.choice-dropdown summary::-webkit-details-marker {
  display: none;
}
.choice-dropdown.disabled summary {
  background: #f7f8fa;
  color: #737f8c;
  cursor: default;
}
.choice-dropdown summary:focus-visible {
  outline: 2px solid #00ada1;
  outline-offset: 2px;
}
.choice-placeholder {
  color: #99a0ad;
}
.choice-selected {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0;
  min-width: 0;
}
.choice-selected:has(.choice-tag) {
  gap: 5px;
}
.choice-popup {
  position: fixed;
  border: 1px solid #dce2e8;
  border-radius: 4px;
  background: white;
  box-shadow: 0 4px 18px #24374726;
  padding: 8px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
}
.choice-popup > input {
  flex: 0 0 32px;
  width: 100%;
  min-width: 0;
  margin-bottom: 6px;
  font-size: 13px;
}
.choice-popup-list {
  overflow-y: auto;
  overscroll-behavior: contain;
  min-height: 0;
}
.choice-popup-list label,
.choice-popup-list button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 4px;
  border: 0;
  background: white;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.choice-popup-list button:hover,
.choice-popup-list label:hover,
.choice-popup-list button[aria-selected="true"] {
  background: #e8f7f5;
}
.choice-popup-list .muted {
  display: block;
  padding: 8px 4px;
}
.choice-popup-list .choice-select-all {
  color: #00ada1;
}
.choice-popup-list .choice-select-all:has(input:disabled) {
  color: #99a0ad;
  cursor: default;
}
.choice-clear {
  align-self: flex-start;
  margin-top: 4px;
  flex: 0 0 auto;
}
</style>
