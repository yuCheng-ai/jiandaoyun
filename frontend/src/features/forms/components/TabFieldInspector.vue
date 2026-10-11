<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import TabStylePicker from "./TabStylePicker.vue";
import OptionColorPicker from "../../../components/OptionColorPicker.vue";
import { formAppearancePalette } from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import {
  editFormTabs,
  minFormTabs,
  maxFormTabs,
  type FormTabAction,
} from "../../../domain/formTabs";
import type { FormField, FormSchema } from "../../../domain/form";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  applySchema: (schema: FormSchema) => void;
}>();
const emit = defineEmits<{
  select: [tabId: string];
  update: [patch: Partial<FormField>];
}>();
const error = ref("");
const removing = ref<string>();
const anchor = ref<HTMLElement>();
const confirmation = ref<HTMLElement>();
const position = ref({ left: "0px", top: "0px" });
const dragging = ref<string>();
function close() {
  removing.value = undefined;
}
const { zIndex } = useDialogLayer(confirmation, close, () => {}, {
  modal: false,
  anchor: () => anchor.value,
});
watch(
  () => props.field.id,
  () => {
    close();
    error.value = "";
    dragging.value = undefined;
  },
);
async function apply(action: FormTabAction) {
  try {
    const result = editFormTabs(props.schema, props.field.id, action);
    props.applySchema(result.schema);
    error.value = "";
    close();
    emit("select", result.tabId);
    return result.tabId;
  } catch (cause) {
    error.value = (cause as Error).message;
  }
}
async function addOrCopy(action: FormTabAction) {
  const id = await apply(action);
  if (id) {
    await nextTick();
    document.getElementById(`tab-label-${id}`)?.focus({ preventScroll: true });
  }
}
async function requestRemove(id: string, event: MouseEvent) {
  if (props.field.tabs.length <= minFormTabs) return;
  anchor.value = event.currentTarget as HTMLElement;
  removing.value = id;
  const bounds = anchor.value.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  position.value = {
    left: `${Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12))}px`,
    top: `${bounds.bottom + 6}px`,
  };
  await nextTick();
  const height = confirmation.value?.getBoundingClientRect().height || 130;
  if (bounds.bottom + 6 + height > window.innerHeight - 12)
    position.value.top = `${Math.max(12, bounds.top - height - 6)}px`;
}
function rename(id: string, event: Event) {
  emit("select", id);
  const label = (event.target as HTMLInputElement).value;
  emit("update", {
    tabs: props.field.tabs.map((tab) =>
      tab.id === id ? { ...tab, label } : tab,
    ),
  });
}
function startDrag(id: string, event: DragEvent) {
  if (!event.dataTransfer) return;
  dragging.value = id;
  event.dataTransfer.setData(
    "application/x-form-tab",
    JSON.stringify({ fieldId: props.field.id, tabId: id }),
  );
  event.dataTransfer.effectAllowed = "move";
}
function drop(id: string, event: DragEvent) {
  const from = dragging.value;
  dragging.value = undefined;
  if (!from || from === id) return;
  try {
    const payload = JSON.parse(
      event.dataTransfer?.getData("application/x-form-tab") || "{}",
    );
    if (payload.fieldId !== props.field.id || payload.tabId !== from) return;
  } catch {
    return;
  }
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const old = props.field.tabs.findIndex((tab) => tab.id === from);
  const target = props.field.tabs.findIndex((tab) => tab.id === id);
  const insertion =
    target + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
  void apply({
    type: "move",
    tabId: from,
    index: insertion - (old < insertion ? 1 : 0),
  });
}
async function keyMove(id: string, event: KeyboardEvent) {
  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  const index =
    props.field.tabs.findIndex((tab) => tab.id === id) +
    (event.key === "ArrowUp" ? -1 : 1);
  if (index >= 0 && index < props.field.tabs.length) {
    await apply({ type: "move", tabId: id, index });
    await nextTick();
    if (handle.isConnected) handle.focus({ preventScroll: true });
  }
}
</script>
<template>
  <div class="form-group">
    <label>样式</label>
    <TabStylePicker
      :field="field"
      @select="emit('update', { tabStyle: $event })"
    />
  </div>
  <div class="form-group">
    <label class="switch-setting"
      >自定义颜色<button
        class="switch"
        :class="{ on: field.tabCustomColor }"
        type="button"
        role="switch"
        aria-label="标签页自定义颜色"
        :aria-checked="!!field.tabCustomColor"
        @click="
          emit('update', {
            tabCustomColor: !field.tabCustomColor,
            ...(!field.tabCustomColor && !field.tabColor
              ? { tabColor: '#00ada1' }
              : {}),
          })
        "
      >
        <span /></button
    ></label>
    <OptionColorPicker
      v-if="field.tabCustomColor"
      :color="field.tabColor || '#00ada1'"
      :palette="formAppearancePalette"
      label="标签页"
      swatch="bar"
      @change="emit('update', { tabColor: $event })"
    />
  </div>
  <div class="form-group tab-field-inspector">
    <label>多标签显示</label>
    <div class="tab-option-editor">
      <div
        v-for="(item, index) in field.tabs"
        :key="item.id"
        class="tab-option-row"
        @dragover="dragging && $event.preventDefault()"
        @drop.prevent.stop="drop(item.id, $event)"
      >
        <button
          type="button"
          class="icon-button tab-sort-handle"
          draggable="true"
          :aria-label="`排序标签页 ${index + 1}`"
          title="拖动排序；Alt+↑/↓调整顺序"
          @dragstart.stop="startDrag(item.id, $event)"
          @dragend="dragging = undefined"
          @keydown="keyMove(item.id, $event)"
        >
          <AppIcon name="align" />
        </button>
        <input
          :id="`tab-label-${item.id}`"
          :value="item.label"
          maxlength="80"
          :aria-label="`标签页 ${index + 1}`"
          @focus="emit('select', item.id)"
          @input="rename(item.id, $event)"
        />
        <button
          type="button"
          class="icon-button"
          :disabled="field.tabs.length >= maxFormTabs"
          :aria-label="`复制标签页 ${index + 1}`"
          :title="
            field.tabs.length >= maxFormTabs
              ? '最多允许添加 50 个标签页'
              : '复制'
          "
          @click="addOrCopy({ type: 'copy', tabId: item.id })"
        >
          <AppIcon name="duplicate" />
        </button>
        <button
          type="button"
          class="icon-button"
          :disabled="field.tabs.length <= minFormTabs"
          :aria-label="`删除标签页 ${index + 1}`"
          :title="
            field.tabs.length <= minFormTabs
              ? '至少需要保留 2 个标签页'
              : '删除'
          "
          @click="requestRemove(item.id, $event)"
        >
          <AppIcon name="trash" />
        </button>
      </div>
    </div>
    <button
      type="button"
      class="button full-width"
      :disabled="field.tabs.length >= maxFormTabs"
      :title="
        field.tabs.length >= maxFormTabs
          ? '最多允许添加 50 个标签页'
          : undefined
      "
      @click="addOrCopy({ type: 'add' })"
    >
      <AppIcon name="add" />添加标签页
    </button>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <Teleport to="body">
      <div
        v-if="removing"
        ref="confirmation"
        class="tab-delete-confirm"
        role="dialog"
        aria-label="删除标签页"
        tabindex="-1"
        :style="{ ...position, zIndex }"
      >
        <p>删除后，标签页内的字段将移到表单中。确定要删除吗？</p>
        <div>
          <button type="button" class="button" @click="close">取消</button>
          <button
            type="button"
            class="button danger"
            @click="apply({ type: 'remove', tabId: removing! })"
          >
            删除
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
