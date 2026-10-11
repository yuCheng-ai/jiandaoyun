<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { maxChoiceLabelLength } from "@platform/contracts";
import { useDialogLayer } from "../../../composables/useDialogLayer";

const props = defineProps<{
  label: string;
  existing: string[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ add: [text: string] }>();
const open = ref(false),
  text = ref(""),
  error = ref("");
const anchor = ref<HTMLElement>(),
  panel = ref<HTMLElement>();
const position = ref({ left: "0px", top: "0px", width: "280px" });
const { zIndex } = useDialogLayer(panel, close, () => {}, {
  modal: false,
  anchor: () => anchor.value,
});
function close() {
  open.value = false;
}
async function show() {
  if (props.disabled) return;
  if (open.value) return close();
  text.value = error.value = "";
  const rect = anchor.value!.getBoundingClientRect(),
    width = Math.min(280, window.innerWidth - 16);
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${rect.bottom + 4}px`,
    width: `${width}px`,
  };
  open.value = true;
  await nextTick();
  if (
    panel.value &&
    rect.bottom + panel.value.offsetHeight + 12 > window.innerHeight
  )
    position.value.top = `${Math.max(8, rect.top - panel.value.offsetHeight - 4)}px`;
  panel.value?.querySelector("input")?.focus();
}
function add() {
  if (props.disabled) return;
  const value = text.value.trim();
  error.value = !value
    ? "请填写选项名称"
    : value.length > maxChoiceLabelLength
      ? `选项名称不能超过${maxChoiceLabelLength}个字`
      : props.existing.some((label) => label.trim() === value)
        ? "该选项已存在，请直接选择"
        : "";
  if (error.value) return;
  emit("add", value);
  close();
}
watch(() => props.disabled, close);
</script>
<template>
  <button
    ref="anchor"
    type="button"
    class="text-button add-choice"
    :disabled="disabled"
    :aria-label="`${label}添加选项`"
    @click="show"
  >
    ＋添加选项
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="add-choice-panel"
      role="dialog"
      :aria-label="`${label}添加选项`"
      :style="{ ...position, zIndex }"
    >
      <input
        v-model="text"
        :aria-label="`${label}新增选项`"
        :aria-invalid="!!error"
        placeholder="请填写内容，enter确认"
        @keydown.enter.prevent="add"
        @input="error = ''"
      />
      <p v-if="error" role="alert">{{ error }}</p>
      <div>
        <button type="button" class="button" @click="close">取消</button
        ><button type="button" class="button primary" @click="add">确定</button>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.add-choice {
  align-self: flex-start;
}
.add-choice-panel {
  position: fixed;
  padding: 12px;
  border: 1px solid #dce2e8;
  border-radius: 4px;
  background: white;
  box-shadow: 0 4px 18px #24374726;
  font-size: 13px;
}
.add-choice-panel input {
  width: 100%;
  min-width: 0;
  height: 32px;
  font-size: 13px;
}
.add-choice-panel p {
  margin: 6px 0 0;
  color: #d95050;
  font-size: 12px;
}
.add-choice-panel > div {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.add-choice-panel button {
  height: 28px;
  font-size: 12px;
}
</style>
