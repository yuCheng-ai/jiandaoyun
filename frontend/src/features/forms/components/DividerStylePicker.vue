<script setup lang="ts">
import { nextTick, ref } from "vue";
import { formDividerStyles, type FormField } from "@platform/contracts";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";
import FormDivider from "./FormDivider.vue";
const props = defineProps<{ field: FormField }>();
const emit = defineEmits<{
  select: [style: NonNullable<FormField["dividerStyle"]>];
}>();
const trigger = ref<HTMLElement>(),
  panel = ref<HTMLElement>(),
  open = ref(false);
const position = ref({
  left: "0px",
  top: "0px",
  width: "0px",
  maxHeight: "0px",
});
const { zIndex } = useDialogLayer(
  panel,
  () => (open.value = false),
  () => {},
  { modal: false, anchor: () => trigger.value },
);
async function show() {
  open.value = !open.value;
  if (!open.value) return;
  const rect = trigger.value!.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 268), window.innerWidth - 24);
  const below = window.innerHeight - rect.bottom - 16,
    above = rect.top - 16;
  const height = Math.min(420, Math.max(below, above));
  position.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${below >= height ? rect.bottom + 4 : Math.max(12, rect.top - height - 4)}px`,
    width: `${width}px`,
    maxHeight: `${height}px`,
  };
  await nextTick();
  const selected =
    panel.value?.querySelector<HTMLElement>('[aria-selected="true"]') ||
    panel.value?.querySelector<HTMLElement>('[role="option"]');
  selected?.focus();
}
function choose(style: NonNullable<FormField["dividerStyle"]>) {
  emit("select", style);
  open.value = false;
}
function navigate(index: number, event: KeyboardEvent) {
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey
  )
    return;
  event.preventDefault();
  const n = formDividerStyles.length;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? n - 1
        : (index + (event.key === "ArrowDown" ? 1 : n - 1)) % n;
  panel.value?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
}
function name(style: NonNullable<FormField["dividerStyle"]>, index: number) {
  return (
    (
      { none: "无", dashed: "虚线", thin: "细实线", thick: "粗实线" } as Record<
        string,
        string
      >
    )[style] || `样式${index - 3}`
  );
}
</script>
<template>
  <button
    ref="trigger"
    type="button"
    class="divider-style-trigger"
    aria-label="分割线样式"
    aria-haspopup="listbox"
    :aria-expanded="open"
    @click="show"
  >
    <FormDivider
      :field="{ ...field, showLabel: true, label: '字段标题' }"
    /><AppIcon name="down" :size="14" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="divider-style-menu"
      role="listbox"
      aria-label="分割线样式"
      :style="{ ...position, zIndex }"
    >
      <button
        v-for="(style, index) in formDividerStyles"
        :key="style"
        type="button"
        role="option"
        :aria-label="`分割线样式：${name(style, index)}`"
        :aria-selected="field.dividerStyle === style"
        @click="choose(style)"
        @keydown="navigate(index, $event)"
      >
        <FormDivider
          :field="{
            ...field,
            showLabel: true,
            label: '字段标题',
            dividerStyle: style,
          }"
        />
      </button>
    </div>
  </Teleport>
</template>
<style scoped>
.divider-style-trigger {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid #dce1e7;
  border-radius: 4px;
  background: white;
  text-align: left;
  cursor: pointer;
}
.divider-style-trigger > .runtime-divider {
  flex: 1;
  min-width: 0;
}
.divider-style-trigger > .app-icon {
  flex: none;
}
.divider-style-menu {
  position: fixed;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  padding: 8px;
  overflow: auto;
  border: 1px solid #e1e6ee;
  border-radius: 6px;
  background: white;
  box-shadow: 0 6px 28px #24374730;
}
.divider-style-menu > button {
  display: block;
  min-width: 0;
  width: 100%;
  min-height: 46px;
  padding: 8px;
  border: 1px solid #dce1e7;
  border-radius: 4px;
  background: white;
  text-align: left;
  cursor: pointer;
}
.divider-style-menu > button[aria-selected="true"] {
  border-color: #00ada1;
}
.divider-style-trigger:focus-visible,
.divider-style-menu > button:focus-visible {
  outline: 2px solid #00ada1;
  outline-offset: -2px;
}
</style>
