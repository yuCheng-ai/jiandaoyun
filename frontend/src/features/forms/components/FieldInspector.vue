<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  isNumericField,
  fieldDefaultValue,
  dateFormats,
  dateInputType,
  dateInputStep,
  dateFormatPatch,
  normalizeDateValue,
  addressTypes,
  addressType,
  dividerColors,
  formAppearancePalette,
  subformWidthOptions,
  subformColumnWidth,
  subformWidthErrors,
  subformSummarySupported,
  subformMobileErrors,
  textFormats,
  maxFieldLabelLength,
  maxFieldPlaceholderLength,
  supportsFieldPlaceholder,
} from "@platform/contracts";
import SubformPermissionOptions from "./SubformPermissionOptions.vue";
import AppIcon from "../../../components/AppIcon.vue";
import NumberInput from "../../../components/NumberInput.vue";
import RichTextEditor from "./RichTextEditor.vue";
import RichTextDefaultInspector from "./RichTextDefaultInspector.vue";
import ChoiceSettings from "./ChoiceSettings.vue";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
import VisibilityRules from "./VisibilityRules.vue";
import ChoiceFieldInspector from "./ChoiceFieldInspector.vue";
import OrganizationFieldInspector from "./OrganizationFieldInspector.vue";
import RelationFieldInspector from "./RelationFieldInspector.vue";
import LookupFieldInspector from "./LookupFieldInspector.vue";
import LocationFieldInspector from "./LocationFieldInspector.vue";
import OcrFieldInspector from "./OcrFieldInspector.vue";
import DateRangeInspector from "./DateRangeInspector.vue";
import AddressFieldControl from "./AddressFieldControl.vue";
import FileFieldInspector from "./FileFieldInspector.vue";
import DefaultLinkInspector from "./DefaultLinkInspector.vue";
import SubformDefaultInspector from "./SubformDefaultInspector.vue";
import FormulaEditor from "./FormulaEditor.vue";
import SerialFieldInspector from "./SerialFieldInspector.vue";
import TabFieldInspector from "./TabFieldInspector.vue";
import OptionColorPicker from "../../../components/OptionColorPicker.vue";
import DividerStylePicker from "./DividerStylePicker.vue";
import SubformFieldInspector from "./SubformFieldInspector.vue";
import type { FieldDrop } from "../useFormDesigner";
import { defaultLinkTypes } from "../../../domain/fieldConfig";
import {
  fieldDefinition,
  findFieldContainer,
  flattenFields,
  fieldTypeAlternatives,
  fieldTypePatch,
  fieldTypeChangeIssue,
  type FormField,
  type FormSchema,
  type FieldType,
} from "../../../domain/form";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  formId: string;
  applySchema?: (schema: FormSchema) => void;
  manageSubform?: boolean;
  calculatedTypeLocked?: boolean;
}>();
const emit = defineEmits<{
  update: [patch: Partial<FormField>];
  selectTab: [tabId: string];
  addChild: [type: FieldType, parentId: string];
  selectChild: [id: string, event: MouseEvent | KeyboardEvent];
  duplicateChild: [id: string];
  removeChild: [id: string];
  dropChild: [payload: FieldDrop];
}>();
const definition = computed(() => fieldDefinition(props.field.type));
let titleBeforeEditing = props.field.label;
function finishTitle(event: FocusEvent) {
  const input = event.target as HTMLInputElement;
  if (input.value === titleBeforeEditing) return;
  const label =
    input.value.trim().slice(0, maxFieldLabelLength) ||
    titleBeforeEditing.trim() ||
    definition.value.label;
  input.value = label;
  emit("update", { label });
}
function changeCalculatedType(event: Event) {
  if (props.calculatedTypeLocked) return;
  const format = (event.target as HTMLSelectElement).value;
  if (format !== "number" && format !== "text") return;
  if ((isNumericField(props.field) ? "number" : "text") === format) return;
  emit("update", { format, expression: "" });
}
const insideSubform = computed(() => {
  const container = findFieldContainer(props.schema.fields, props.field.id);
  return flattenFields(props.schema.fields).some(
    (field) => field.type === "subform" && field.children === container,
  );
});
const isSubfield = computed(() => props.manageSubform && insideSubform.value);
const wholeSubformLink = computed(
  () =>
    props.manageSubform &&
    ["text", "textarea", "number", "datetime", "address"].includes(
      props.field.type,
    ) &&
    flattenFields(props.schema.fields).some(
      (f) =>
        f.type === "subform" &&
        f.defaultLink?.enabled &&
        f.children.some((c) => c.id === props.field.id),
    ),
);
const customWidthInput = ref("");
const fixedDevice = ref<"desktop" | "mobile">("desktop");
const fixedCount = computed(
  () => props.field.subformFixedColumns?.[fixedDevice.value] ?? 0,
);
const fixedOptions = computed(() =>
  Math.max(props.field.children.length, fixedCount.value),
);
function changeFixedColumns(count: number) {
  emit("update", {
    subformFixedColumns: {
      desktop: props.field.subformFixedColumns?.desktop ?? 0,
      mobile: props.field.subformFixedColumns?.mobile ?? 0,
      [fixedDevice.value]: count,
    },
  });
}
const mobileLayout = computed(
  () => props.field.subformMobile?.layout || "table",
);
function changeMobile(patch: Partial<NonNullable<FormField["subformMobile"]>>) {
  emit("update", {
    subformMobile: {
      layout: mobileLayout.value,
      summary: "first",
      fieldIds: [],
      ...props.field.subformMobile,
      ...patch,
    },
  });
}
const summaryPicker = computed<FormField>(() => {
  const selected = props.field.subformMobile?.fieldIds || [];
  const children = props.field.children.filter(
    (child) => subformSummarySupported(child) || selected.includes(child.id),
  );
  return {
    ...props.field,
    type: "multiselect",
    coloredOptions: false,
    allowCustomChoices: false,
    placeholder: "请选择简报字段（最多3个）",
    options: [
      ...children.map((child) => ({
        id: child.id,
        label:
          child.label +
          (subformSummarySupported(child) ? "" : "（不支持简报）"),
      })),
      ...selected
        .filter((id) => !children.some((child) => child.id === id))
        .map((id) => ({ id, label: "字段已移除" })),
    ],
  };
});
watch(
  () => [props.field.id, props.field.subformWidth] as const,
  ([id, width], previous) => {
    if (
      typeof width === "number" &&
      (previous?.[0] !== id || Number(customWidthInput.value) !== width)
    )
      customWidthInput.value = String(width);
  },
  { immediate: true },
);
function changeCustomWidth(event: Event) {
  customWidthInput.value = value(event);
  emit("update", { subformWidth: Number(customWidthInput.value) });
}
const subfieldUnique = computed(
  () => isSubfield.value && definition.value.subformUnique,
);
const showUnique = computed(
  () =>
    !(props.field.type === "ocr" && props.field.ocr) &&
    !["subform", "file", "image", "signature", "address", "location"].includes(
      props.field.type,
    ) &&
    (!isSubfield.value || subfieldUnique.value || props.field.unique),
);
function changeUnique(event: Event) {
  const unique = checked(event);
  if (!subfieldUnique.value) {
    emit("update", { unique });
    return;
  }
  emit("update", {
    unique,
    uniqueInRecord: unique || props.field.uniqueInRecord === true,
    ...(unique && props.field.duplicateMessage === undefined
      ? { duplicateMessage: "此项内容已存在，不允许重复提交" }
      : {}),
  });
}
function changeUniqueInRecord(event: Event) {
  const uniqueInRecord = props.field.unique || checked(event);
  emit("update", {
    uniqueInRecord,
    ...(uniqueInRecord && props.field.duplicateMessage === undefined
      ? { duplicateMessage: "此项内容已存在，不允许重复提交" }
      : {}),
  });
}
const dividerAppearance = computed(() => dividerColors(props.field));
const alternateTypes = computed(() => fieldTypeAlternatives(props.field.type));
function changeType(event: Event) {
  const target = event.target as HTMLSelectElement;
  const patch = fieldTypePatch(props.field, target.value as FieldType);
  // A parent may request confirmation; retain the current selection until applied.
  target.value = props.field.type;
  if (patch) emit("update", patch);
}
function value(event: Event) {
  return (event.target as HTMLInputElement).value;
}
function checked(event: Event) {
  return (event.target as HTMLInputElement).checked;
}
function dateFormat(event: Event) {
  emit("update", dateFormatPatch(props.field, value(event)));
}
const rangeEnabled = computed(
  () =>
    props.field.limitRange ??
    (props.field.min !== undefined || props.field.max !== undefined),
);
</script>
<template>
  <div class="field-inspector">
    <div class="form-group field-title-group">
      <div class="label-line">
        <label for="field-title"><span class="required">*</span>标题</label>
        <div v-if="alternateTypes.length" class="field-type-switch select-wrap">
          <select
            :value="field.type"
            aria-label="字段类型"
            @change="changeType"
          >
            <option :value="field.type">{{ definition.label }}</option>
            <option
              v-for="type in alternateTypes"
              :key="type"
              :value="type"
              :disabled="!!fieldTypeChangeIssue(field, type)"
              :title="fieldTypeChangeIssue(field, type)"
            >
              {{ fieldDefinition(type).label }}
            </option></select
          ><AppIcon name="down" :size="12" />
        </div>
        <span v-else class="field-type-label">{{ definition.label }}</span>
      </div>
      <input
        id="field-title"
        :value="field.label"
        :maxlength="maxFieldLabelLength"
        @focus="titleBeforeEditing = field.label"
        @input="emit('update', { label: value($event) })"
        @blur="finishTitle"
      /><label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.showLabel"
          @change="emit('update', { showLabel: checked($event) })"
        />显示标题</label
      >
    </div>
    <div class="form-group">
      <label>描述信息</label
      ><RichTextEditor
        :key="field.id"
        :model-value="field.description"
        label="字段描述信息"
        @update:model-value="emit('update', { description: $event })"
      />
    </div>
    <template v-if="field.type === 'divider'">
      <div class="form-group">
        <DividerStylePicker
          :key="field.id"
          :field="field"
          @select="emit('update', { dividerStyle: $event })"
        />
      </div>
      <div class="form-group divider-color-setting">
        <label>配色</label>
        <OptionColorPicker
          :key="`${field.id}-divider-color`"
          :color="dividerAppearance.color"
          :palette="formAppearancePalette"
          label="分割线"
          swatch="bar"
          @change="emit('update', { dividerColor: $event })"
        />
      </div>
      <div class="form-group divider-color-setting">
        <label>标题颜色</label>
        <OptionColorPicker
          :key="`${field.id}-divider-title-color`"
          :color="dividerAppearance.titleColor"
          :palette="formAppearancePalette"
          label="分割线标题"
          swatch="bar"
          @change="emit('update', { dividerTitleColor: $event })"
        />
      </div>
    </template>
    <template v-if="supportsFieldPlaceholder(field.type, insideSubform)"
      ><div class="form-group">
        <label for="field-placeholder"
          >提示文字 <AppIcon name="help" :size="13" class="muted-icon" /></label
        ><input
          id="field-placeholder"
          :value="field.placeholder"
          :maxlength="maxFieldPlaceholderLength"
          @input="
            emit('update', {
              placeholder: value($event).slice(0, maxFieldPlaceholderLength),
            })
          "
        /></div
    ></template>
    <ChoiceFieldInspector
      v-if="definition.options"
      :field="field"
      :schema="schema"
      :form-id="formId"
      @update="emit('update', $event)"
    />
    <SerialFieldInspector
      v-if="field.type === 'serial'"
      :key="field.id"
      :field="field"
      :schema="schema"
      :form-id="formId"
      @update="emit('update', $event)"
    />
    <OrganizationFieldInspector
      v-if="
        ['member', 'members', 'department', 'departments'].includes(field.type)
      "
      :field="field"
      :schema="schema"
      @update="emit('update', $event)"
    />
    <template v-if="field.type === 'text'"
      ><div class="form-group">
        <label for="text-format">格式</label>
        <div class="select-wrap">
          <select
            id="text-format"
            :value="field.format"
            @change="emit('update', { format: value($event) })"
          >
            <option
              v-for="item in textFormats"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </option></select
          ><AppIcon name="down" />
        </div></div
    ></template>
    <div v-if="field.type === 'calculated'" class="form-group">
      <label for="calculated-result-type">计算结果类型</label>
      <div class="select-wrap">
        <select
          id="calculated-result-type"
          :value="isNumericField(field) ? 'number' : 'text'"
          :disabled="calculatedTypeLocked"
          @change="changeCalculatedType"
        >
          <option value="number">数字</option>
          <option value="text">文本</option></select
        ><AppIcon name="down" />
      </div>
    </div>
    <template v-if="isNumericField(field)"
      ><div class="form-group">
        <label for="number-format">格式</label>
        <div class="select-wrap">
          <select
            id="number-format"
            :value="field.format === 'percent' ? 'percent' : 'number'"
            @change="emit('update', { format: value($event) })"
          >
            <option value="number">数值</option>
            <option value="percent">百分比</option></select
          ><AppIcon name="down" />
        </div>
        <label class="checkbox-line"
          ><input
            type="checkbox"
            :checked="field.retainPrecision !== false"
            @change="emit('update', { retainPrecision: checked($event) })"
          />保留小数位数</label
        >
        <input
          v-if="field.retainPrecision !== false"
          id="precision"
          aria-label="小数位数"
          type="number"
          min="0"
          max="8"
          :value="field.precision"
          @change="
            emit('update', {
              precision: Math.max(
                0,
                Math.min(8, Math.round(Number(value($event)))),
              ),
            })
          "
        />
        <label v-if="field.format !== 'percent'" class="checkbox-line"
          ><input
            type="checkbox"
            :checked="field.numberGrouping"
            @change="emit('update', { numberGrouping: checked($event) })"
          />显示千分符</label
        >
      </div></template
    >
    <div v-if="field.type === 'datetime'" class="form-group">
      <label for="date-format">类型</label>
      <div class="select-wrap">
        <select id="date-format" :value="field.format" @change="dateFormat">
          <option
            v-for="item in dateFormats"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </option></select
        ><AppIcon name="down" />
      </div>
    </div>
    <template v-if="field.type === 'address'">
      <div class="form-group">
        <label for="address-type">类型</label>
        <div class="select-wrap">
          <select
            id="address-type"
            :value="addressType(field)"
            @change="emit('update', { format: value($event) })"
          >
            <option
              v-for="type in addressTypes"
              :key="type.value"
              :value="type.value"
            >
              {{ type.label }}
            </option></select
          ><AppIcon name="down" />
        </div>
      </div>
    </template>
    <div v-if="field.type === 'calculated'" class="form-group">
      <label>计算公式</label>
      <FormulaEditor
        :field="field"
        :schema="schema"
        @update="emit('update', $event)"
      />
    </div>
    <LookupFieldInspector
      v-if="field.type === 'lookup'"
      :field="field"
      :schema="schema"
      :apply-schema="applySchema"
      @update="emit('update', $event)"
    />
    <OcrFieldInspector
      v-if="field.type === 'ocr'"
      :key="field.id"
      :field="field"
      :schema="schema"
      :apply-schema="applySchema"
      @update="emit('update', $event)"
    />
    <RelationFieldInspector
      v-if="['query', 'relation', 'relationTable'].includes(field.type)"
      :field="field"
      :schema="schema"
      :form-id="formId"
      @update="emit('update', $event)"
    />
    <SubformFieldInspector
      v-if="field.type === 'subform' && manageSubform"
      :field="field"
      @add="(type) => emit('addChild', type, field.id)"
      @select="(id, event) => emit('selectChild', id, event)"
      @duplicate="emit('duplicateChild', $event)"
      @remove="emit('removeChild', $event)"
      @drop="emit('dropChild', $event)"
    />
    <VisibilityRules
      v-if="field.type === 'subform'"
      :key="field.id"
      :schema="schema"
      :scope-id="field.id"
    />
    <TabFieldInspector
      v-if="field.type === 'tabs' && applySchema"
      :field="field"
      :schema="schema"
      :apply-schema="applySchema"
      @update="emit('update', $event)"
      @select="emit('selectTab', $event)"
    />
    <div v-if="field.type === 'button'" class="form-group">
      <label for="button-text">按钮文字</label
      ><input
        id="button-text"
        :value="field.buttonText"
        @input="emit('update', { buttonText: value($event) })"
      />
    </div>
    <DefaultLinkInspector
      v-if="
        defaultLinkTypes.includes(field.type) &&
        (field.type !== 'subform' || manageSubform) &&
        !wholeSubformLink
      "
      :key="field.id"
      :field="field"
      :schema="schema"
      :form-id="formId"
      @update="emit('update', $event)"
    >
      <LocationFieldInspector
        v-if="field.type === 'location'"
        :field="field"
        :fields="schema.fields"
        section="default"
        @update="emit('update', $event)"
      />
      <SubformDefaultInspector
        v-if="field.type === 'subform'"
        :field="field"
        @update="emit('update', $event)"
      />
      <AddressFieldControl
        v-if="field.type === 'address'"
        :field="{ ...field, editable: true }"
        :model-value="field.defaultValue"
        label="默认地址"
        @update:model-value="emit('update', { defaultValue: $event })"
      />
      <textarea
        v-else-if="field.type === 'textarea'"
        id="field-default"
        aria-label="自定义默认值"
        :value="String(field.defaultValue ?? '')"
        rows="3"
        @input="emit('update', { defaultValue: value($event) })"
      />
      <RichTextDefaultInspector
        v-else-if="field.type === 'richtext'"
        :field="field"
        @update="emit('update', $event)"
      />
      <NumberInput
        v-else-if="field.type === 'number'"
        :key="field.id + ':default'"
        id="field-default"
        aria-label="自定义默认值"
        :settings="field"
        :model-value="fieldDefaultValue(field)"
        :format-on-blur="false"
        @update:model-value="emit('update', { defaultValue: $event })"
      />
      <input
        v-else-if="['text', 'datetime'].includes(field.type)"
        id="field-default"
        aria-label="自定义默认值"
        :type="field.type === 'datetime' ? dateInputType(field.format) : 'text'"
        :value="field.defaultValue"
        :step="
          field.type === 'datetime' ? dateInputStep(field.format) : undefined
        "
        @input="
          emit('update', {
            defaultValue:
              field.type === 'datetime'
                ? normalizeDateValue(field.format, value($event))
                : value($event),
          })
        "
      />
    </DefaultLinkInspector>
    <div
      v-if="
        field.type === 'phone' &&
        field.defaultValue !== '' &&
        field.defaultValue != null
      "
      class="form-group"
    >
      <label for="field-default">默认值</label>
      <input
        id="field-default"
        :value="field.defaultValue"
        @input="emit('update', { defaultValue: value($event) })"
      />
    </div>
    <LocationFieldInspector
      v-if="field.type === 'location'"
      :field="field"
      :fields="schema.fields"
      section="settings"
      @update="emit('update', $event)"
    />
    <DateRangeInspector
      v-if="field.type === 'datetime'"
      :field="field"
      :fields="schema.fields"
      @update="emit('update', $event)"
    />
    <div
      v-if="
        field.type === 'text' ||
        (field.type === 'phone' &&
          field.maxLength > 0 &&
          ![11, 200].includes(field.maxLength)) ||
        (field.type === 'textarea' && field.maxLength > 0)
      "
      class="form-group"
    >
      <label for="field-length">最大长度</label
      ><input
        id="field-length"
        type="number"
        :min="field.type === 'textarea' ? 0 : 1"
        max="10000"
        :value="field.maxLength"
        @change="
          emit('update', {
            maxLength: Math.max(
              field.type === 'textarea' ? 0 : 1,
              Math.min(10000, Number(value($event))),
            ),
          })
        "
      />
      <p v-if="field.type === 'textarea'" class="field-hint">0 表示不限。</p>
    </div>
    <FileFieldInspector
      v-if="field.type === 'image'"
      :field="field"
      section="appearance"
      @update="emit('update', $event)"
    />
    <div
      v-if="
        !['tabs', 'divider', 'button', 'serial'].includes(field.type) &&
        !(field.type === 'ocr' && field.ocr)
      "
      class="form-group"
    >
      <label>校验</label
      ><label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.required"
          @change="emit('update', { required: checked($event) })"
        />必填</label
      ><label v-if="showUnique" class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.unique"
          @change="changeUnique"
        />不允许重复值</label
      >
      <template v-if="subfieldUnique">
        <label class="checkbox-line"
          ><input
            type="checkbox"
            :checked="field.unique || field.uniqueInRecord === true"
            :disabled="field.unique"
            @change="changeUniqueInRecord"
          />单条数据内不允许重复值</label
        >
        <div
          v-if="field.unique || field.uniqueInRecord"
          class="duplicate-message-setting"
        >
          <label for="field-duplicate-message">自定义提示内容</label>
          <input
            id="field-duplicate-message"
            :value="field.duplicateMessage"
            @input="emit('update', { duplicateMessage: value($event) })"
          />
        </div>
      </template>
      <label v-if="field.type === 'address'" class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.addressComplete === true"
          @change="emit('update', { addressComplete: checked($event) })"
        />按类型完整填写</label
      >
      <LocationFieldInspector
        v-if="field.type === 'location'"
        :field="field"
        :fields="schema.fields"
        section="range"
        @update="emit('update', $event)"
      />
      <FileFieldInspector
        v-if="['file', 'image'].includes(field.type)"
        :field="field"
        @update="emit('update', $event)"
      />
      <ChoiceSettings
        :field="field"
        section="validation"
        @update="emit('update', $event)"
      />
      <template v-if="field.type === 'number'">
        <label class="checkbox-line"
          ><input
            type="checkbox"
            :checked="rangeEnabled"
            @change="emit('update', { limitRange: checked($event) })"
          />限定数值范围</label
        >
        <div v-if="rangeEnabled" class="inline-range">
          <NumberInput
            :key="field.id + ':min'"
            :settings="field"
            :model-value="field.min"
            :format-on-blur="false"
            aria-label="最小值"
            placeholder="最小值"
            @update:model-value="
              emit('update', { min: $event === '' ? undefined : $event })
            "
          /><span>至</span>
          <NumberInput
            :key="field.id + ':max'"
            :settings="field"
            :model-value="field.max"
            :format-on-blur="false"
            aria-label="最大值"
            placeholder="最大值"
            @update:model-value="
              emit('update', { max: $event === '' ? undefined : $event })
            "
          />
        </div>
      </template>
    </div>
    <div class="form-group">
      <label
        >字段权限 <AppIcon name="help" :size="13" class="muted-icon" /></label
      ><label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.visible"
          @change="emit('update', { visible: checked($event) })"
        />可见</label
      ><label
        v-if="!['serial', 'divider', 'calculated'].includes(field.type)"
        class="checkbox-line"
        ><input
          type="checkbox"
          :checked="field.editable"
          @change="emit('update', { editable: checked($event) })"
        />可编辑</label
      >
      <SubformPermissionOptions
        v-if="field.type === 'subform' && manageSubform"
        :model-value="field.subformPermissions"
        :disabled="!field.editable"
        @update:model-value="emit('update', { subformPermissions: $event })"
      />
      <label
        v-if="field.type === 'subform' && manageSubform"
        class="checkbox-line"
      >
        <input
          type="checkbox"
          :checked="field.subformQuickFill === true"
          @change="emit('update', { subformQuickFill: checked($event) })"
        />快速填报
      </label>
    </div>
    <div v-if="field.type === 'subform' && manageSubform" class="form-group">
      <label>子表单展示样式</label>
      <div
        class="field-width-options"
        role="tablist"
        aria-label="子表单展示设备"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="fixedDevice === 'desktop'"
          :class="{ active: fixedDevice === 'desktop' }"
          @click="fixedDevice = 'desktop'"
        >
          电脑端
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="fixedDevice === 'mobile'"
          :class="{ active: fixedDevice === 'mobile' }"
          @click="fixedDevice = 'mobile'"
        >
          移动端
        </button>
      </div>
      <div v-if="fixedDevice === 'mobile'" class="subform-mobile-options">
        <label class="radio-line"
          ><input
            type="radio"
            :name="`${field.id}-mobile-layout`"
            value="vertical"
            :checked="mobileLayout === 'vertical'"
            @change="changeMobile({ layout: 'vertical' })"
          />纵向平铺</label
        >
        <label class="radio-line"
          ><input
            type="radio"
            :name="`${field.id}-mobile-layout`"
            value="table"
            :checked="mobileLayout === 'table'"
            @change="changeMobile({ layout: 'table' })"
          />横向表格</label
        >
      </div>
      <template v-if="fixedDevice === 'mobile' && mobileLayout === 'vertical'">
        <label class="subform-summary-label">数据收起时显示的简报</label>
        <select
          aria-label="移动端简报内容"
          :value="field.subformMobile?.summary || 'first'"
          @change="
            changeMobile({
              summary: ($event.target as HTMLSelectElement).value as
                'first' | 'custom',
            })
          "
        >
          <option value="first">前3个字段的值</option>
          <option value="custom">自定义</option>
        </select>
        <ChoiceFieldControl
          v-if="field.subformMobile?.summary === 'custom'"
          :field="summaryPicker"
          label="移动端简报字段"
          :model-value="field.subformMobile.fieldIds"
          :max-selections="3"
          @update:model-value="changeMobile({ fieldIds: $event as string[] })"
        />
        <p v-if="subformMobileErrors(field, true).length" class="field-error">
          {{ subformMobileErrors(field, true)[0] }}
        </p>
      </template>
      <div v-else class="subform-fixed-options">
        <label class="checkbox-line"
          ><input
            type="checkbox"
            :aria-label="`${fixedDevice === 'desktop' ? '电脑端' : '移动端'}固定列`"
            :checked="fixedCount > 0"
            :disabled="!field.children.length && !fixedCount"
            @change="changeFixedColumns(checked($event) ? 1 : 0)"
          />固定前</label
        >
        <select
          :aria-label="`${fixedDevice === 'desktop' ? '电脑端' : '移动端'}固定列数`"
          :disabled="!fixedCount"
          :value="fixedCount || 1"
          @change="
            changeFixedColumns(
              Number(($event.target as HTMLSelectElement).value),
            )
          "
        >
          <option v-for="count in fixedOptions" :key="count" :value="count">
            {{ count }}列
          </option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>字段宽度</label>
      <template v-if="insideSubform">
        <div class="field-width-options subform-width-options">
          <button
            v-for="item in subformWidthOptions"
            :key="item.value"
            type="button"
            :class="{
              active: (field.subformWidth ?? 'standard') === item.value,
            }"
            :aria-pressed="(field.subformWidth ?? 'standard') === item.value"
            @click="emit('update', { subformWidth: item.value })"
          >
            {{ item.label }}
          </button>
          <button
            type="button"
            :class="{ active: typeof field.subformWidth === 'number' }"
            :aria-pressed="typeof field.subformWidth === 'number'"
            @click="emit('update', { subformWidth: subformColumnWidth(field) })"
          >
            自定义
          </button>
        </div>
        <div
          v-if="typeof field.subformWidth === 'number'"
          class="custom-subform-width"
        >
          <input
            id="subform-column-width"
            type="number"
            min="1"
            max="1000"
            step="1"
            aria-label="自定义子字段宽度"
            :value="customWidthInput"
            :aria-invalid="subformWidthErrors(field).length > 0"
            :aria-describedby="
              subformWidthErrors(field).length
                ? 'subform-width-error'
                : undefined
            "
            @input="changeCustomWidth"
          /><span>px</span>
        </div>
        <small
          v-if="subformWidthErrors(field).length"
          id="subform-width-error"
          class="field-error"
        >
          {{ subformWidthErrors(field)[0] }}
        </small>
      </template>
      <div v-else class="field-width-options">
        <button
          v-for="item in [
            { n: 3, label: '1/4' },
            { n: 4, label: '1/3' },
            { n: 6, label: '1/2' },
            { n: 8, label: '2/3' },
            { n: 9, label: '3/4' },
            { n: 12, label: '整行' },
          ]"
          :key="item.n"
          :class="{ active: field.width === item.n }"
          @click="emit('update', { width: item.n })"
        >
          {{ item.label }}
        </button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.duplicate-message-setting {
  margin: 6px 0 0 22px;
}
.custom-subform-width {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.custom-subform-width input {
  width: 100%;
  min-width: 0;
}
</style>
