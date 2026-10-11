<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";
import {
  fieldDefinition,
  fieldRegistry,
  type FieldType,
  type FormField,
} from "../../../domain/form";
import type { FieldDrop } from "../useFormDesigner";
const props = defineProps<{ field: FormField }>();
const emit = defineEmits<{
  add: [type: FieldType];
  select: [id: string, event: MouseEvent | KeyboardEvent];
  duplicate: [id: string];
  remove: [id: string];
  drop: [payload: FieldDrop];
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
  const width = Math.min(280, window.innerWidth - 24),
    height = Math.min(388, window.innerHeight - 24);
  const below = window.innerHeight - rect.bottom - 12,
    above = rect.top - 12;
  const room = Math.min(height, Math.max(below, above));
  position.value = {
    left: `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`,
    top: `${below >= room ? rect.bottom + 4 : Math.max(12, rect.top - room - 4)}px`,
    width: `${width}px`,
    maxHeight: `${room}px`,
  };
  await nextTick();
  panel.value?.querySelector<HTMLButtonElement>("button")?.focus();
}
function choose(type: FieldType) {
  open.value = false;
  emit("add", type);
}
function drag(id: string, event: DragEvent) {
  event.stopPropagation();
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(
    "application/x-form-field",
    JSON.stringify({ id }),
  );
  event.dataTransfer.effectAllowed = "move";
}
function drop(index: number, event: DragEvent) {
  const data = event.dataTransfer?.getData("application/x-form-field");
  if (!data) return;
  try {
    const payload = JSON.parse(data);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    emit("drop", {
      ...payload,
      parentId: props.field.id,
      index: index + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0),
    });
  } catch {
    /* Unrelated drag data does not change the form. */
  }
}
async function keyMove(index: number, event: KeyboardEvent) {
  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const direction = event.key === "ArrowUp" ? -1 : 1;
  if (index + direction < 0 || index + direction >= props.field.children.length)
    return;
  const handle = event.currentTarget as HTMLElement;
  emit("drop", {
    id: props.field.children[index]!.id,
    parentId: props.field.id,
    index: index + (direction > 0 ? 2 : -1),
  });
  await nextTick();
  handle.focus({ preventScroll: true });
}
function navigate(index: number, event: KeyboardEvent) {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    ![
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  event.preventDefault();
  const buttons = [
    ...(panel.value?.querySelectorAll<HTMLButtonElement>(
      "button[data-field-type]",
    ) || []),
  ];
  const delta =
    event.key === "ArrowDown"
      ? 2
      : event.key === "ArrowUp"
        ? -2
        : event.key === "ArrowRight"
          ? 1
          : -1;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
const types = fieldRegistry.filter((item) => item.subform);
</script>
<template>
  <div class="form-group subfield-inspector" role="region" aria-label="子字段">
    <label>子字段</label>
    <div class="subfield-list">
      <div
        v-for="(child, index) in field.children"
        :key="child.id"
        class="subfield-row"
        @dragenter.prevent.stop
        @dragover.prevent.stop
        @drop.prevent.stop="drop(index, $event)"
      >
        <button
          type="button"
          class="icon-button subfield-sort"
          draggable="true"
          :aria-label="`排序子字段 ${child.label}`"
          title="拖动排序；Alt+↑/↓调整顺序"
          @dragstart="drag(child.id, $event)"
          @keydown="keyMove(index, $event)"
        >
          <AppIcon name="align" :size="14" />
        </button>
        <button
          type="button"
          class="subfield-name"
          :aria-label="`编辑子字段 ${child.label}`"
          @click="emit('select', child.id, $event)"
        >
          <AppIcon
            :name="fieldDefinition(child.type).icon"
            :size="13"
          /><span>{{ child.label }}</span>
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="`复制子字段 ${child.label}`"
          title="复制"
          :disabled="!fieldDefinition(child.type).subform"
          @click="emit('duplicate', child.id)"
        >
          <AppIcon name="duplicate" :size="13" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="`删除子字段 ${child.label}`"
          title="删除"
          @click="emit('remove', child.id)"
        >
          <AppIcon name="trash" :size="13" />
        </button>
      </div>
      <button
        ref="trigger"
        type="button"
        class="subfield-add"
        aria-label="添加子字段"
        aria-haspopup="menu"
        :aria-expanded="open"
        @click="show"
      >
        <AppIcon name="add" :size="14" />添加子字段
      </button>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="subfield-type-menu"
      role="menu"
      aria-label="子字段类型"
      :style="{ ...position, zIndex }"
    >
      <button
        v-for="(item, index) in types"
        :key="item.type"
        type="button"
        role="menuitem"
        class="palette-field"
        :data-field-type="item.type"
        @click="choose(item.type)"
        @keydown="navigate(index, $event)"
      >
        <AppIcon :name="item.icon" :size="14" /><span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>
<style scoped>
.subfield-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.subfield-row {
  display: flex;
  align-items: center;
  min-height: 30px;
  border: 1px solid #edf0f3;
  border-radius: 3px;
  padding: 0 3px;
  gap: 2px;
  background: #fff;
}
.subfield-row .icon-button {
  width: 24px;
  height: 26px;
  padding: 0;
  flex-shrink: 0;
}
.subfield-sort {
  cursor: grab;
  color: #8a929d;
}
.subfield-name {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 5px;
  padding: 0 2px;
  height: 28px;
  text-align: left;
  font-size: 12px;
}
.subfield-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subfield-name .app-icon {
  flex-shrink: 0;
  color: #7c8695;
}
.subfield-name:hover {
  color: var(--teal);
}
.subfield-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid #edf0f3;
  border-radius: 3px;
  min-height: 30px;
  font-size: 12px;
  color: #667180;
}
.subfield-add:hover {
  color: var(--teal);
  background: #f3faf8;
}
.subfield-type-menu {
  position: fixed;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: 6px;
  padding: 10px;
  overflow-y: auto;
  background: white;
  border: 1px solid #dde3e8;
  border-radius: 4px;
  box-shadow: 0 5px 20px #1e293b22;
}
.subfield-type-menu .palette-field {
  cursor: pointer;
  min-width: 0;
}
</style>
