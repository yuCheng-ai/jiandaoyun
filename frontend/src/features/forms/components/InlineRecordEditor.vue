<script setup lang="ts">
import { recordFilterFields } from "../../../domain/relations";
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import FieldControl from "./FieldControl.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useWorkspaceStore } from "../../../stores/workspace";
import { copy } from "../../../domain/form";
import {
  inlineEditField,
  prepareInlineEdit,
} from "../../../domain/collaboration";
import type { FormEntry } from "../../../domain/workspace";
const props = defineProps<{ entry: FormEntry; fieldId: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  host = ref<HTMLElement>(),
  value = ref(copy(props.entry.values[props.fieldId] ?? "")),
  snapshot = copy(props.entry.values),
  error = ref("");
const field = computed(() =>
  inlineEditField(props.entry, props.fieldId, store.data),
);
const dirty = computed(
  () =>
    JSON.stringify(value.value) !==
    JSON.stringify(snapshot[props.fieldId] ?? ""),
);
const result = computed(() =>
  prepareInlineEdit(
    { ...props.entry, values: snapshot },
    props.fieldId,
    value.value,
    store.data,
  ),
);
let leave: ((allow: boolean) => void) | undefined;
function close() {
  if (leave) {
    const resolve = leave;
    leave = undefined;
    resolve(true);
  } else emit("close");
}
const { confirmDiscard, requestClose, discard } = useDraftDismiss(
  () => true,
  () => value.value,
  close,
);
function keepEditing() {
  confirmDiscard.value = false;
  leave?.(false);
  leave = undefined;
}
function guardNavigation() {
  if (!dirty.value) return true;
  leave?.(false);
  confirmDiscard.value = true;
  return new Promise<boolean>((resolve) => {
    leave = resolve;
  });
}
onBeforeRouteLeave(guardNavigation);
onBeforeRouteUpdate(guardNavigation);
onBeforeUnmount(() => leave?.(false));
function focusEditor() {
  host.value?.scrollIntoView({ block: "nearest", inline: "nearest" });
  host.value
    ?.querySelector<HTMLElement>("input,textarea,select,button")
    ?.focus({ preventScroll: true });
}
onMounted(async () => {
  await nextTick();
  focusEditor();
});
async function save() {
  error.value = result.value.errors[0] || "";
  if (error.value) return;
  if (
    !(await store.updateEntryField(
      props.entry.id,
      props.fieldId,
      value.value,
      snapshot,
    ))
  ) {
    error.value = "未保存，请根据页面提示处理；记录变化时请取消后重新编辑。";
    return;
  }
  store.notify(
    result.value.changes.length ? "单元格修改已保存" : "字段值没有变化",
  );
  emit("close");
}
async function keydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  } else if (
    event.key === "Enter" &&
    (event.ctrlKey ||
      event.metaKey ||
      ((event.target as HTMLElement).tagName === "INPUT" &&
        ["text", "number", "tel"].includes(
          (event.target as HTMLInputElement).type,
        )))
  ) {
    event.preventDefault();
    await save();
  }
}
</script>
<template>
  <div
    ref="host"
    class="inline-record-editor"
    :aria-label="`快捷编辑 ${field?.label || '字段'}`"
    @keydown="keydown"
  >
    <FieldControl
      :fields="recordFilterFields(store.data, entry)"
      v-if="field"
      v-model="value"
      :field="field"
      :values="result.values"
      :entry-id="entry.id"
      :label="`编辑${field.label}`"
    />
    <p v-else class="field-error">当前字段已不可编辑</p>
    <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    <div v-if="result.changes.length" class="inline-edit-changes">
      <span class="field-hint"
        >本次变更{{ result.changes.length > 1 ? "（含字段联动）" : "" }}</span
      >
      <div v-for="change in result.changes" :key="change.id">
        <strong>{{ change.label }}</strong
        ><span>{{ change.before }} → {{ change.after }}</span>
      </div>
    </div>
    <div class="inline-edit-actions">
      <button
        type="button"
        class="button primary"
        :disabled="!field"
        @click="save"
      >
        保存</button
      ><button type="button" class="button" @click="requestClose">取消</button>
    </div>
    <small class="field-hint">Ctrl / ⌘ + Enter 保存 · Esc 取消</small>
  </div>
  <BaseDialog
    :open="confirmDiscard"
    title="保留当前单元格修改？"
    width="460px"
    @close="keepEditing"
    @closed="focusEditor"
    ><p>当前修改尚未保存，离开后将丢失。</p>
    <template #footer
      ><button type="button" class="button" @click="keepEditing">
        继续编辑</button
      ><button type="button" class="button" @click="discard">
        放弃修改
      </button></template
    ></BaseDialog
  >
</template>
