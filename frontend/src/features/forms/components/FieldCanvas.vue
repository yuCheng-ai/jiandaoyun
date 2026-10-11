<script setup lang="ts">
import { ref } from "vue";
import { fieldGridSpan, subformColumnWidth } from "@platform/contracts";
import { sanitizeRichText } from "../../../domain/richText";
import AppIcon from "../../../components/AppIcon.vue";
import FieldControl from "./FieldControl.vue";
import FormTabBar from "./FormTabBar.vue";
import {
  fieldDefinition,
  flattenFields,
  type FormField,
} from "../../../domain/form";
import type { FieldDrop } from "../useFormDesigner";
const props = withDefaults(
  defineProps<{
    fields: FormField[];
    selectedIds: string[];
    parentId?: string;
    tabId?: string;
    activeTabId?: string;
    layout?: number;
    subform?: boolean;
    allowDuplicate?: boolean;
  }>(),
  { allowDuplicate: true },
);
const emit = defineEmits<{
  select: [id: string, event: MouseEvent | KeyboardEvent];
  drop: [payload: FieldDrop];
  duplicate: [id: string];
  remove: [id: string];
  move: [id: string, direction: -1 | 1];
  context: [parentId: string | null, tabId?: string];
}>();
const hover = ref<number | null>(null);
function tab(field: FormField) {
  return field.tabs.some((item) => item.id === props.activeTabId)
    ? props.activeTabId
    : field.tabs[0]?.id;
}
function selectTab(
  field: FormField,
  id: string,
  event: MouseEvent | KeyboardEvent,
) {
  emit("select", field.id, event);
  emit("context", field.id, id);
}
function startDrag(field: FormField, event: DragEvent) {
  event.stopPropagation();
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(
    "application/x-form-field",
    JSON.stringify({ id: field.id }),
  );
  event.dataTransfer.effectAllowed = "move";
}
function onDrop(index: number, event: DragEvent) {
  hover.value = null;
  const payload = event.dataTransfer?.getData("application/x-form-field");
  if (!payload) return;
  try {
    const parsed = JSON.parse(payload);
    emit("drop", {
      ...parsed,
      parentId: props.parentId,
      index,
      tabId: props.tabId,
    });
  } catch {
    /* Ignore unrelated drop data. */
  }
}
function insertionIndex(index: number, event: DragEvent) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const after = props.subform
    ? event.clientX >= bounds.left + bounds.width / 2
    : event.clientY >= bounds.top + bounds.height / 2;
  return index + (after ? 1 : 0);
}
function pick(field: FormField, event: MouseEvent) {
  emit("select", field.id, event);
  if (fieldDefinition(field.type).container)
    emit("context", field.id, field.type === "tabs" ? tab(field) : undefined);
  else emit("context", props.parentId || null, props.tabId);
}
</script>
<template>
  <div
    class="field-canvas"
    :class="{ nested: parentId, 'subform-columns': subform }"
    @click.self="emit('context', parentId || null, tabId)"
  >
    <div
      v-if="subform && fields.length"
      class="subform-design-row-number"
      aria-hidden="true"
    >
      <span /><span>1</span>
    </div>
    <template v-for="(field, index) in fields" :key="field.id"
      ><div
        class="field-design-slot"
        :style="
          subform
            ? { flexBasis: `${subformColumnWidth(field)}px` }
            : {
                gridColumn: `span ${fieldGridSpan(field, layout || 1)}`,
              }
        "
      >
        <div
          class="field-drop-zone"
          :class="{ over: hover === index }"
          :data-drop-index="index"
          @dragenter.prevent.stop="hover = index"
          @dragover.prevent.stop="hover = index"
          @dragleave="hover = null"
          @drop.prevent.stop="onDrop(index, $event)"
        />
        <article
          class="field-design-card"
          :class="{
            selected: selectedIds.includes(field.id),
            container: fieldDefinition(field.type).container,
          }"
          :data-field-id="field.id"
          draggable="true"
          @dragstart="startDrag(field, $event)"
          @dragenter.prevent.stop="hover = insertionIndex(index, $event)"
          @dragover.prevent.stop="hover = insertionIndex(index, $event)"
          @dragleave="hover = null"
          @drop.prevent.stop="onDrop(insertionIndex(index, $event), $event)"
          @click.stop="pick(field, $event)"
        >
          <div v-if="selectedIds.includes(field.id)" class="field-card-tools">
            <button
              v-if="
                allowDuplicate !== false &&
                !flattenFields([field]).some((f) =>
                  ['serial', 'tabs'].includes(f.type),
                )
              "
              type="button"
              aria-label="复制字段"
              title="复制"
              @click.stop="emit('duplicate', field.id)"
            >
              <AppIcon name="duplicate" :size="14" /></button
            ><button
              type="button"
              aria-label="删除字段"
              title="删除"
              @click.stop="emit('remove', field.id)"
            >
              <AppIcon name="trash" :size="14" />
            </button>
          </div>
          <label
            v-if="(subform || field.showLabel) && field.type !== 'divider'"
            class="field-design-label"
            ><template v-if="field.showLabel"
              ><span v-if="field.required" class="required">*</span
              ><span class="field-design-title" :title="field.label">{{
                field.label
              }}</span
              ><span v-if="!field.visible" class="field-flag"
                >隐藏</span
              ></template
            ></label
          >
          <div
            v-if="field.description && field.type !== 'divider' && !subform"
            class="field-description"
            v-html="sanitizeRichText(field.description)"
            @click.prevent
          />
          <FormTabBar
            v-if="field.type === 'tabs'"
            :items="field.tabs"
            :model-value="tab(field)"
            :label="field.label"
            :appearance="field"
            variant="design"
            @select="(id, event) => selectTab(field, id, event)"
          >
            <FieldCanvas
              :fields="
                field.children.filter(
                  (child) => !child.tabId || child.tabId === tab(field),
                )
              "
              :selected-ids="selectedIds"
              :active-tab-id="activeTabId"
              :parent-id="field.id"
              :tab-id="tab(field)"
              :allow-duplicate="allowDuplicate"
              @select="(id, event) => emit('select', id, event)"
              @context="(id, tabId) => emit('context', id, tabId)"
              @drop="emit('drop', $event)"
              @duplicate="emit('duplicate', $event)"
              @remove="emit('remove', $event)"
              @move="(id, direction) => emit('move', id, direction)"
          /></FormTabBar>
          <div
            v-else-if="field.type === 'subform'"
            class="subform-designer"
            tabindex="0"
            :aria-label="`${field.label}子字段`"
            @click.stop="
              emit('select', field.id, $event);
              emit('context', field.id);
            "
          >
            <FieldCanvas
              :fields="field.children"
              :selected-ids="selectedIds"
              :active-tab-id="activeTabId"
              :parent-id="field.id"
              subform
              :allow-duplicate="allowDuplicate"
              @select="(id, event) => emit('select', id, event)"
              @context="(id, tabId) => emit('context', id, tabId)"
              @drop="emit('drop', $event)"
              @duplicate="emit('duplicate', $event)"
              @remove="emit('remove', $event)"
              @move="(id, direction) => emit('move', id, direction)"
            />
          </div>
          <div
            v-else
            class="design-control-preview"
            :class="{
              'full-preview': ['relationTable', 'divider'].includes(field.type),
            }"
          >
            <FieldControl
              :field="field"
              :model-value="
                field.defaultLink?.enabled || field.defaultFormula
                  ? undefined
                  : field.defaultValue
              "
              design
            />
          </div>
          <div
            v-if="field.description && (field.type === 'divider' || subform)"
            class="field-description"
            v-html="sanitizeRichText(field.description)"
            @click.prevent
          />
        </article></div
    ></template>
    <div
      class="field-drop-zone last-drop-zone"
      :class="{ over: hover === fields.length, empty: !fields.length }"
      :data-drop-index="fields.length"
      @dragenter.prevent.stop="hover = fields.length"
      @dragover.prevent.stop="hover = fields.length"
      @dragleave="hover = null"
      @drop.prevent.stop="onDrop(fields.length, $event)"
    >
      <span
        v-if="subform && fields.length"
        class="subform-empty-heading"
        aria-hidden="true"
      />
      <template v-if="!fields.length"
        ><AppIcon name="add" :size="22" /><span>{{
          parentId
            ? "拖入字段，或点击左侧字段添加"
            : "从左侧拖入字段，开始设计表单"
        }}</span></template
      >
    </div>
  </div>
</template>
