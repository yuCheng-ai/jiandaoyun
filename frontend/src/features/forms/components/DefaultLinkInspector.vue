<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { DefaultLink, FormField, FormSchema } from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { copy, fieldDefinition } from "../../../domain/form";
import { emptyDefaultLink, linkTypesMatch } from "../../../domain/fieldConfig";
import { defaultLinkErrors } from "../../../domain/fieldValidation";
import { formulaTypes } from "@platform/contracts";
import {
  defaultLinkLocalFields,
  defaultLinkSourceFields,
} from "../../../domain/relations";
import DataFilterEditor from "./DataFilterEditor.vue";
import FormulaEditor from "./FormulaEditor.vue";

const props = withDefaults(defineProps<{
  field: FormField;
  schema: FormSchema;
  formId: string;
  allowLinked?: boolean;
}>(), { allowLinked: true });
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const runtime = useRuntimeData();
const open = ref(false),
  buffer = ref<DefaultLink>(emptyDefaultLink()),
  error = ref("");
let original = "";
const current = computed(() => props.field.defaultLink || emptyDefaultLink());
const fileField = computed(() => ["file", "image"].includes(props.field.type));
const sourceMode = computed(() =>
  current.value.enabled
    ? "linked"
    : props.field.defaultFormula
      ? "formula"
      : props.field.type === "datetime"
        ? props.field.dateDefault || "custom"
        : fileField.value
          ? "none"
          : "custom",
);
const sourceId = computed(() =>
  props.field.type === "datetime"
    ? "date-default-source"
    : fileField.value
      ? "file-default-source"
      : "field-default-source",
);
const forms = computed(() =>
  runtime.value.forms.filter(
    (f) =>
      !f.archived && f.id !== props.formId &&
      f.appId === runtime.value.forms.find((f) => f.id === props.formId)?.appId,
  ),
);
const remote = computed(() =>
  defaultLinkSourceFields(runtime.value, buffer.value.formId),
);
const linkedFields = computed(() =>
  remote.value.filter((f) => linkTypesMatch(props.field, f)),
);
const sourceChildren = computed(
  () => remote.value.find((f) => f.id === buffer.value.fieldId)?.children || [],
);
const unassignedChildren = computed(() =>
  props.field.children.filter(
    (f) =>
      !buffer.value.mappings?.some((m) => m.targetFieldId === f.id) &&
      !["query", "divider", "button", "calculated"].includes(f.type),
  ),
);
const mappingTrigger = ref<HTMLElement>(),
  mappingMenu = ref<HTMLElement>(),
  mappingMenuOpen = ref(false);
const mappingPosition = ref({
  left: "0px",
  top: "0px",
  width: "0px",
  maxHeight: "0px",
});
const { zIndex: mappingZIndex } = useDialogLayer(
  mappingMenu,
  () => (mappingMenuOpen.value = false),
  () => {},
  {
    modal: false,
    anchor: () => mappingTrigger.value,
  },
);
watch(open, () => (mappingMenuOpen.value = false));
async function showMappings() {
  mappingMenuOpen.value = !mappingMenuOpen.value;
  if (!mappingMenuOpen.value) return;
  const rect = mappingTrigger.value!.getBoundingClientRect();
  const width = Math.min(240, window.innerWidth - 24);
  const below = window.innerHeight - rect.bottom - 12,
    above = rect.top - 12;
  const room = Math.min(288, Math.max(below, above));
  mappingPosition.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${below >= room ? rect.bottom + 4 : Math.max(12, rect.top - room - 4)}px`,
    width: `${width}px`,
    maxHeight: `${room}px`,
  };
  await nextTick();
  const height = mappingMenu.value?.getBoundingClientRect().height || room;
  mappingPosition.value.top = `${below >= height ? rect.bottom + 4 : Math.max(12, rect.top - height - 4)}px`;
  mappingMenu.value?.querySelector<HTMLButtonElement>("button")?.focus();
}
function navigateMappings(index: number, event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [
    ...(mappingMenu.value?.querySelectorAll<HTMLButtonElement>("button") || []),
  ];
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next]?.focus();
}
function mappingFields(id: string) {
  const target = props.field.children.find((f) => f.id === id);
  return target
    ? sourceChildren.value.filter((f) => linkTypesMatch(target, f))
    : [];
}
function addMapping(targetId: string) {
  const target = props.field.children.find((f) => f.id === targetId);
  if (!target) return;
  (buffer.value.mappings ||= []).push({
    targetFieldId: target.id,
    sourceFieldId:
      mappingFields(target.id).find((f) => f.label === target.label)?.id || "",
  });
  mappingMenuOpen.value = false;
}
const conditionFields = computed(() =>
  remote.value.filter(
    (f) =>
      !["tabs", "subform", "divider", "button", "file", "image"].includes(
        f.type,
      ),
  ),
);
const local = computed(() =>
  defaultLinkLocalFields(props.schema.fields, props.field.id),
);
const dismiss = useDraftDismiss(
  () => open.value,
  () => buffer.value,
  () => {
    open.value = false;
  },
);
function mode(event: Event) {
  const selected = (event.target as HTMLSelectElement).value;
  emit("update", {
    defaultFormula: selected === "formula",
    defaultLink: {
      ...copy(current.value),
      enabled: selected === "linked",
    },
    ...(props.field.type === "datetime" && ["now", "custom"].includes(selected)
      ? { dateDefault: selected as "now" | "custom" }
      : {}),
  });
}
function start() {
  buffer.value = copy(current.value);
  original = JSON.stringify(current.value);
  error.value = "";
  open.value = true;
}
function source(event: Event) {
  buffer.value.formId = (event.target as HTMLSelectElement).value;
  buffer.value.filters = [];
  buffer.value.fieldId =
    linkedFields.value.find((f) => f.label === props.field.label)?.id || "";
  if (props.field.type === "subform") buffer.value.mappings = [];
}
function apply() {
  if (JSON.stringify(current.value) !== original) {
    error.value =
      "当前字段的联动设置已变化，请关闭后重新打开；本次输入已保留。";
    return;
  }
  error.value =
    defaultLinkErrors(
      { ...props.field, defaultLink: buffer.value },
      props.schema.fields,
      runtime.value,
    )[0] || "";
  if (error.value) return;
  emit("update", { defaultLink: copy(buffer.value) });
  dismiss.markSaved();
  open.value = false;
}
</script>
<template>
  <div class="form-group">
    <label :for="sourceId">默认值</label>
    <div class="select-wrap">
      <select
        :id="sourceId"
        :aria-label="
          field.type === 'datetime'
            ? '日期默认值'
            : fileField
              ? '文件默认值'
              : '默认值来源'
        "
        :value="sourceMode"
        @change="mode"
      >
        <option v-if="fileField" value="none">无</option>
        <option v-if="field.type === 'datetime'" value="now">填写当时</option>
        <option v-if="!fileField" value="custom">自定义</option>
        <option v-if="allowLinked !== false" value="linked">数据联动</option>
        <option v-if="formulaTypes.includes(field.type)" value="formula">
          公式编辑
        </option></select
      ><AppIcon name="down" />
    </div>
    <button
      v-if="current.enabled"
      type="button"
      class="button link-settings"
      @click="start"
    >
      数据联动设置
    </button>
    <slot v-if="sourceMode === 'custom'" />
    <FormulaEditor
      v-if="sourceMode === 'formula'"
      :field="field"
      :schema="schema"
      @update="emit('update', $event)"
    />
  </div>
  <BaseDialog
    :open="open"
    title="数据联动设置"
    width="800px"
    class-name="default-link-dialog"
    @close="dismiss.requestClose"
  >
    <div class="default-link-settings">
      <div class="form-group">
        <label for="default-link-form">联动表单</label>
        <div class="select-wrap">
          <select
            id="default-link-form"
            aria-label="联动表单"
            :value="buffer.formId"
            @change="source"
          >
            <option value="">请选择表单</option>
            <option
              v-if="buffer.formId && !forms.some((f) => f.id === buffer.formId)"
              :value="buffer.formId"
              disabled
            >
              原表单已失效
            </option>
            <option v-for="form in forms" :key="form.id" :value="form.id">
              {{ form.title }}
            </option></select
          ><AppIcon name="down" />
        </div>
      </div>
      <div class="link-condition-title">
        <span>联动表单字段满足以下</span>
        <div class="select-wrap">
          <select v-model="buffer.match" aria-label="联动条件关系">
            <option value="all">所有</option>
            <option value="any">任一</option></select
          ><AppIcon name="down" :size="12" />
        </div>
        <span>条件时</span>
      </div>
      <DataFilterEditor
        v-model="buffer.filters"
        :source-fields="conditionFields"
        :local-fields="local"
        compact
        compatible-types
      />
      <div class="link-trigger">
        <label>触发以下联动</label>
        <div class="link-field-head">
          <span>当前表单</span><span>联动表单</span>
        </div>
        <div class="link-field-row">
          <span class="link-target"
            ><AppIcon :name="fieldDefinition(field.type).icon" />{{
              field.label
            }}</span
          >
          <span>联动显示</span>
          <div class="select-wrap">
            <select
              v-model="buffer.fieldId"
              aria-label="联动来源字段"
              @change="field.type === 'subform' && (buffer.mappings = [])"
            >
              <option value="">请选择字段</option>
              <option
                v-if="
                  buffer.fieldId &&
                  !linkedFields.some((f) => f.id === buffer.fieldId)
                "
                :value="buffer.fieldId"
                disabled
              >
                原字段已失效
              </option>
              <option
                v-for="other in linkedFields"
                :key="other.id"
                :value="other.id"
              >
                {{ other.label }}
              </option></select
            ><AppIcon name="down" />
          </div>
          <span>的值</span>
        </div>
      </div>
      <template v-if="field.type === 'subform'">
        <button
          ref="mappingTrigger"
          type="button"
          class="text-button child-link-add"
          aria-label="添加联动子字段"
          aria-haspopup="menu"
          :aria-expanded="mappingMenuOpen"
          :disabled="!buffer.fieldId || !unassignedChildren.length"
          @click="showMappings"
        >
          <AppIcon name="add" :size="14" />添加子字段
        </button>
        <div
          v-for="(mapping, index) in buffer.mappings"
          :key="mapping.targetFieldId"
          class="child-link-row"
        >
          <div class="link-field-row">
            <span class="link-target"
              ><AppIcon
                v-if="
                  field.children.find((f) => f.id === mapping.targetFieldId)
                "
                :name="
                  fieldDefinition(
                    field.children.find((f) => f.id === mapping.targetFieldId)!
                      .type,
                  ).icon
                "
              />{{
                field.children.find((f) => f.id === mapping.targetFieldId)
                  ?.label || "原子字段已失效"
              }}</span
            >
            <span>显示为</span>
            <div class="select-wrap">
              <select
                v-model="mapping.sourceFieldId"
                :aria-label="`联动子字段 ${field.children.find((f) => f.id === mapping.targetFieldId)?.label || mapping.targetFieldId}`"
              >
                <option value="">请选择字段</option>
                <option
                  v-if="
                    mapping.sourceFieldId &&
                    !mappingFields(mapping.targetFieldId).some(
                      (f) => f.id === mapping.sourceFieldId,
                    )
                  "
                  :value="mapping.sourceFieldId"
                  disabled
                >
                  原字段已失效
                </option>
                <option
                  v-for="child in mappingFields(mapping.targetFieldId)"
                  :key="child.id"
                  :value="child.id"
                >
                  {{ child.label }}
                </option></select
              ><AppIcon name="down" />
            </div>
            <span>的值</span>
          </div>
          <button
            type="button"
            class="icon-button"
            :aria-label="`删除子字段对应 ${index + 1}`"
            @click="buffer.mappings!.splice(index, 1)"
          >
            <AppIcon name="trash" />
          </button>
        </div>
      </template>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <div
        v-if="dismiss.confirmDiscard.value"
        class="config-discard"
        role="alertdialog"
        aria-label="放弃联动修改？"
        tabindex="-1"
      >
        <span>有尚未确认的修改。</span
        ><button
          type="button"
          class="text-button"
          @click="dismiss.confirmDiscard.value = false"
        >
          继续编辑</button
        ><button type="button" class="text-button" @click="dismiss.discard">
          放弃修改
        </button>
      </div>
    </div>
    <template #footer>
      <a
        class="link-help"
        href="https://hc.jiandaoyun.com/doc/9028"
        target="_blank"
        rel="noopener noreferrer"
        >什么是数据联动？</a
      >
      <button type="button" class="button" @click="dismiss.requestClose">
        取消</button
      ><button type="button" class="button primary" @click="apply">确定</button>
    </template>
  </BaseDialog>
  <Teleport to="body">
    <div
      v-if="mappingMenuOpen"
      ref="mappingMenu"
      role="menu"
      aria-label="选择联动子字段"
      class="child-link-menu"
      :style="{ ...mappingPosition, zIndex: mappingZIndex }"
    >
      <button
        v-for="(child, index) in unassignedChildren"
        :key="child.id"
        type="button"
        role="menuitem"
        @click="addMapping(child.id)"
        @keydown="navigateMappings(index, $event)"
      >
        <AppIcon :name="fieldDefinition(child.type).icon" :size="14" /><span>{{
          child.label
        }}</span>
      </button>
    </div>
  </Teleport>
</template>
<style scoped>
.link-settings {
  width: 100%;
  margin-top: 10px;
}
.link-help {
  margin-right: auto;
  color: var(--teal);
  font-size: 13px;
}
.default-link-settings {
  min-height: 380px;
  font-size: 13px;
}
.link-condition-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 24px 0 12px;
  flex-wrap: wrap;
}
.link-condition-title .select-wrap {
  width: 65px;
}
.link-trigger {
  margin-top: 26px;
}
.link-trigger > label {
  font-weight: 500;
}
.link-field-head {
  display: grid;
  grid-template-columns: 44% 1fr;
  margin: 16px 0 6px;
  color: #8b919c;
}
.link-field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px minmax(0, 1fr) 50px;
  align-items: center;
  border: 1px solid #dce3e9;
  border-radius: 3px;
}
.link-field-row > span {
  padding: 8px 10px;
}
.link-field-row > span:last-child {
  white-space: nowrap;
}
.link-field-row .select-wrap {
  min-width: 0;
}
.link-field-row select {
  border: 0;
  border-left: 1px solid #dce3e9;
  border-right: 1px solid #dce3e9;
  border-radius: 0;
}
.link-target {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  overflow-wrap: anywhere;
  border-right: 1px solid #dce3e9;
}
.child-link-add {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 12px 0;
  color: var(--teal);
}
.child-link-menu {
  position: fixed;
  overflow-y: auto;
  padding: 4px;
  background: white;
  border: 1px solid #dce3e9;
  border-radius: 3px;
  box-shadow: 0 5px 20px #1e293b22;
}
.child-link-menu button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px;
  text-align: left;
}
.child-link-menu button:hover,
.child-link-menu button:focus-visible {
  background: #f3faf8;
  color: var(--teal);
}
.child-link-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  align-items: center;
}
.child-link-row .link-field-row {
  flex: 1;
  min-width: 0;
}
@media (max-width: 600px) {
  .default-link-settings {
    min-height: 0;
  }
  .link-field-row {
    grid-template-columns: minmax(0, 1fr) 88px;
  }
  .link-field-row .select-wrap {
    grid-column: 1;
  }
  .link-field-row > span:last-child {
    grid-column: 2;
  }
  .link-field-head {
    display: none;
  }
}
</style>
