<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { FormField } from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import { formulaFields } from "../../../domain/formula";
import { escapeText, serializeFieldText } from "./fieldText";
const props = defineProps<{
  modelValue: string;
  fields: FormField[];
  label: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const editor = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>();
const open = ref(false),
  search = ref(""),
  position = ref({ left: "0px", top: "0px" });
const available = computed(() => formulaFields(props.fields));
const choices = computed(() =>
  available.value.filter((item) => item.label.includes(search.value)),
);
let selection: Range | undefined;
const { zIndex } = useDialogLayer(
  panel,
  () => (open.value = false),
  () => {},
  { modal: false, anchor: () => trigger.value },
);
function render(value: string) {
  let output = "",
    end = 0;
  for (const match of value.matchAll(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g)) {
    const id = match[1]!,
      item = available.value.find((item) => item.field.id === id);
    output +=
      escapeText(value.slice(end, match.index)) +
      '<span contenteditable="false" class="field-text-variable" data-field="' +
      escapeText(id) +
      '">' +
      escapeText(item?.label || "已失效字段") +
      "</span>";
    end = match.index + match[0].length;
  }
  return output + escapeText(value.slice(end));
}
const html = ref(render(props.modelValue));
watch(
  () => props.modelValue,
  (value) => {
    if (
      !editor.value ||
      serializeFieldText(editor.value, editor.value) !== value
    )
      html.value = render(value);
  },
);
function remember() {
  const current = document.getSelection();
  if (current?.rangeCount && editor.value?.contains(current.anchorNode))
    selection = current.getRangeAt(0).cloneRange();
}
function input() {
  if (editor.value)
    emit("update:modelValue", serializeFieldText(editor.value, editor.value));
  remember();
}
function insert(text: string) {
  const element = editor.value;
  if (!element) return;
  element.focus();
  const range =
    selection && element.contains(selection.commonAncestorContainer)
      ? selection
      : document.createRange();
  if (!selection || !element.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  const fragment = range.createContextualFragment(render(text)),
    last = fragment.lastChild;
  range.deleteContents();
  range.insertNode(fragment);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    const current = document.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
  }
  open.value = false;
  input();
}
async function show() {
  if (open.value) {
    open.value = false;
    return;
  }
  const rect = trigger.value!.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.right - 260, window.innerWidth - 268))}px`,
    top: `${rect.bottom + 288 < window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 288)}px`,
  };
  search.value = "";
  trigger.value?.focus({ preventScroll: true });
  open.value = true;
  await nextTick();
  panel.value?.querySelector<HTMLInputElement>("input")?.focus();
}
</script>
<template>
  <div class="field-text-input">
    <div
      ref="editor"
      class="field-text-editor"
      contenteditable="true"
      role="textbox"
      :aria-label="label"
      aria-multiline="true"
      spellcheck="false"
      @input="input"
      @keyup="remember"
      @mouseup="remember"
      @paste.prevent="insert($event.clipboardData?.getData('text/plain') || '')"
      v-html="html"
    />
    <button
      ref="trigger"
      type="button"
      class="icon-button"
      aria-label="插入提示字段"
      :aria-expanded="open"
      @mousedown.prevent="remember"
      @click="show"
    >
      <AppIcon name="add" :size="17" />
    </button>
  </div>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="field-text-picker"
      role="dialog"
      aria-label="插入提示字段"
      :style="{ ...position, zIndex }"
    >
      <input
        v-model="search"
        aria-label="搜索提示字段"
        placeholder="搜索字段"
      />
      <div>
        <button
          v-for="item in choices"
          :key="item.field.id"
          type="button"
          @click="insert('{{' + item.field.id + '}}')"
        >
          {{ item.label }}
        </button>
        <p v-if="!choices.length" class="field-hint">暂无可用字段</p>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.field-text-input {
  display: flex;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: 4px;
  min-height: 34px;
}
.field-text-input:focus-within {
  border-color: var(--teal);
}
.field-text-editor {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.field-text-editor :deep(.field-text-variable) {
  color: #008e81;
  background: #e8f6f2;
  border-radius: 3px;
  padding: 1px 4px;
}
.field-text-input > button {
  flex-shrink: 0;
  height: 20px;
  width: 20px;
  min-width: 20px;
  padding: 0;
  margin: 6px;
  border: 1px solid #94d9d5;
  border-radius: 2px;
  color: var(--teal);
}
.field-text-picker {
  position: fixed;
  width: 260px;
  max-height: 284px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: white;
  box-shadow: 0 5px 20px #17273822;
}
.field-text-picker > input {
  width: 100%;
  height: 32px;
  margin-bottom: 6px;
}
.field-text-picker > div {
  max-height: 230px;
  overflow: auto;
}
.field-text-picker button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px;
}
.field-text-picker button:hover {
  background: #e8f6f2;
}
</style>
