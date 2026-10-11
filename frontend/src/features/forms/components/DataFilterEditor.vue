<script setup lang="ts" generic="Filter extends SelectionFilter = DataFilter">
import { conditionValueType, conditionDisplayValue } from "../../../domain/conditionValues";
import { resolveChoices, resolveConditionOption } from "../../../domain/relations";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import AppIcon from "../../../components/AppIcon.vue";
import { computed } from "vue";
import { uid, createField, type FormField } from "../../../domain/form";
import type { DataFilter, SelectionFilter } from "../../../domain/fieldConfig";
import {
  hasFieldValue,
  isNumericField,
  dateInputType,
  dateInputStep,
} from "@platform/contracts";
import type { ChoiceValue } from "@platform/contracts";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
import {
  selectionFilterOperators,
  linkTypesMatch,
} from "../../../domain/fieldConfig";
const props = withDefaults(
  defineProps<{
    modelValue: Filter[];
    sourceFields: (FormField & { pathLabel?: string })[];
    localFields: (FormField & { pathLabel?: string })[];
    hint?: string;
    allowFieldSource?: boolean;
    sourcePlaceholder?: string;
    compact?: boolean;
    compatibleTypes?: boolean;
    constantOnly?: boolean;
    constantOptions?: Record<string, { id: string; label: string }[]>;
  }>(),
  { allowFieldSource: true, sourcePlaceholder: "选择来源表字段" },
);
const emit = defineEmits<{ "update:modelValue": [value: Filter[]] }>();
const runtimeData = useRuntimeData();
const sourceCandidates = computed(() =>
  props.sourceFields.filter(hasFieldValue),
);
const localCandidates = computed(() => props.localFields.filter(hasFieldValue));
function patch(id: string, value: Partial<SelectionFilter>) {
  emit(
    "update:modelValue",
    props.modelValue.map((f) => {
      if (f.id !== id) return f;
      const next = { ...f, ...value };
      const field = sourceCandidates.value.find(field => field.id === next.sourceFieldId);
      if (field?.choiceConversion && ("value" in value || "source" in value || "sourceFieldId" in value))
        next.valueType = next.source === "constant" ? (props.constantOnly ? "text" : conditionValueType(field)) : undefined;
      return next;
    }),
  );
}
function localChoices(filter: SelectionFilter) {
  const source = sourceCandidates.value.find(
    (f) => f.id === filter.sourceFieldId,
  );
  return props.compatibleTypes
    ? localCandidates.value.filter((f) => source && linkTypesMatch(source, f))
    : localCandidates.value;
}
const labels: Record<SelectionFilter["operator"], string> = {
  equals: "等于",
  notEquals: "不等于",
  contains: "包含",
  greater: "大于",
  less: "小于",
  notEmpty: "不为空",
  empty: "为空",
  equalsAny: "等于任意一个",
  notEqualsAny: "不等于任意一个",
  notContains: "不包含",
};
const sourceField = (filter: SelectionFilter) =>
  sourceCandidates.value.find((field) => field.id === filter.sourceFieldId);
function operators(filter: SelectionFilter) {
  const field = sourceField(filter);
  return selectionFilterOperators(field).filter(
    (operator) =>
      props.constantOnly ||
      (field?.type === "address" && !props.allowFieldSource
        ? operator === "notEmpty"
        : [
            "equals",
            "notEquals",
            "contains",
            "greater",
            "less",
            "notEmpty",
          ].includes(operator)),
  );
}
function filterValue(filter: SelectionFilter) {
  return typeof filter.value === "string"
    ? conditionDisplayValue(sourceField(filter), filter.value, filter.valueType,
        (field, id) => resolveConditionOption(field, id, runtimeData.value))
    : filter.value;
}
function options(filter: SelectionFilter) {
  const field = sourceField(filter);
  const choices = props.constantOnly
    ? props.constantOptions?.[filter.sourceFieldId] || []
    : field && conditionValueType(field) === "choice"
      ? resolveChoices({ ...field, choiceSource: { ...field.choiceSource, filters: [] } }, runtimeData.value, {})
      : [];
  const value = filterValue(filter);
  if (field?.choiceConversion && (props.constantOnly || conditionValueType(field) === "choice") && typeof value === "string" && value && !choices.some(option => option.id === value))
    return [...choices, { id: value, label: field.choiceConversion.options.find(option => option.id === value)?.label || value }];
  return choices;
}
const comparisonField = createField("multiselect", { options: [] });
function comparisonOptions(filter: SelectionFilter) {
  const candidates = options(filter);
  return (
    filter.operator === "equalsAny"
      ? [{ id: "", label: "未填写" }, ...candidates]
      : candidates
  ).map((option, index) => ({ ...option, key: String(index + 1) }));
}
function comparisonChoiceField(filter: SelectionFilter) {
  return {
    ...comparisonField,
    id: filter.id,
    options: comparisonOptions(filter).map((option) => ({
      id: option.key,
      label: option.label,
    })),
  };
}
function selectedComparisons(filter: SelectionFilter) {
  const values = Array.isArray(filter.value) ? filter.value : [];
  return comparisonOptions(filter)
    .filter((option) => values.includes(option.id))
    .map((option) => option.key);
}
function changeComparisons(
  filter: SelectionFilter,
  value: ChoiceValue | ChoiceValue[],
) {
  const keys = Array.isArray(value) ? value : [value];
  patch(filter.id, {
    value: comparisonOptions(filter)
      .filter((option) => keys.includes(option.key))
      .map((option) => option.id),
  });
}
function changeSource(filter: SelectionFilter, fieldId: string) {
  const field = sourceCandidates.value.find((field) => field.id === fieldId);
  const multiple =
    props.constantOnly && selectionFilterOperators(field).includes("equalsAny");
  patch(filter.id, {
    sourceFieldId: fieldId,
    ...(props.constantOnly
      ? {
          value: multiple ? [] : "",
          operator: multiple ? ("equalsAny" as const) : ("equals" as const),
        }
      : {}),
    ...(props.compatibleTypes && filter.source === "field"
      ? { value: "" }
      : {}),
    ...(!props.constantOnly && field?.type === "address"
      ? props.allowFieldSource
        ? { source: "field" as const, value: "" }
        : { operator: "notEmpty" as const, value: "" }
      : {}),
  });
}
function addCondition() {
  emit("update:modelValue", [
    ...props.modelValue,
    {
      id: uid("filter"),
      sourceFieldId: "",
      operator: "equals",
      source:
        !props.constantOnly && props.allowFieldSource ? "field" : "constant",
      value: "",
    } as Filter,
  ]);
}
const val = (e: Event) => (e.target as HTMLInputElement).value;
</script>
<template>
  <div
    class="data-filter-editor"
    :class="{ 'compact-filters': compact, 'constant-filters': constantOnly }"
  >
    <p v-if="!compact" class="field-hint">
      {{ hint || "同时满足以下条件；引用字段为空时不显示候选数据。" }}
    </p>
    <div
      v-for="(filter, index) in modelValue"
      :key="filter.id"
      class="data-filter-card"
    >
      <div class="config-card-header">
        <span>条件 {{ index + 1 }}</span
        ><button
          class="icon-button"
          :aria-label="`删除条件${index + 1}`"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((f) => f.id !== filter.id),
            )
          "
        >
          <AppIcon :name="compact ? 'trash' : 'close'" :size="14" />
        </button>
      </div>
      <select
        :value="filter.sourceFieldId"
        :aria-label="`条件${index + 1}来源字段`"
        @change="changeSource(filter, val($event))"
      >
        <option value="">{{ sourcePlaceholder }}</option>
        <option
          v-if="filter.sourceFieldId && !sourceField(filter)"
          :value="filter.sourceFieldId"
          disabled
        >
          原字段不在当前可用范围
        </option>
        <option v-for="f in sourceCandidates" :key="f.id" :value="f.id">
          {{ f.pathLabel || f.label }}
        </option></select
      ><select
        :value="filter.operator"
        :disabled="!filter.sourceFieldId"
        :aria-label="`条件${index + 1}运算符`"
        @change="
          patch(filter.id, {
            operator: val($event) as SelectionFilter['operator'],
            ...(constantOnly
              ? {
                  value: ['equalsAny', 'notEqualsAny'].includes(val($event))
                    ? []
                    : '',
                }
              : {}),
          })
        "
      >
        <option
          v-if="
            filter.sourceFieldId && !operators(filter).includes(filter.operator)
          "
          :value="filter.operator"
          disabled
        >
          {{ labels[filter.operator] }}（请调整）
        </option>
        <option
          v-for="operator in operators(filter)"
          :key="operator"
          :value="operator"
        >
          {{ labels[operator] }}
        </option></select
      ><template v-if="!['empty', 'notEmpty'].includes(filter.operator)"
        ><select
          v-if="!constantOnly"
          :value="filter.source"
          :aria-label="`条件${index + 1}值来源`"
          @change="
            patch(filter.id, {
              source: val($event) as DataFilter['source'],
              value: '',
            })
          "
        >
          <option
            v-if="sourceField(filter)?.type !== 'address'"
            value="constant"
          >
            固定值
          </option>
          <option v-if="allowFieldSource" value="field">当前表单字段</option>
          <option
            v-if="sourceField(filter)?.type !== 'address'"
            value="currentUser"
          >
            当前成员
          </option>
          <option
            v-if="sourceField(filter)?.type !== 'address'"
            value="currentDepartment"
          >
            当前成员主部门
          </option></select
        ><ChoiceFieldControl
          v-if="
            constantOnly &&
            ['equalsAny', 'notEqualsAny'].includes(filter.operator)
          "
          :field="comparisonChoiceField(filter)"
          class="filter-value"
          :model-value="selectedComparisons(filter)"
          :label="`条件${index + 1}固定值`"
          @update:model-value="changeComparisons(filter, $event)" /><select
          v-else-if="filter.source === 'field'"
          :value="filter.value"
          :aria-label="`条件${index + 1}引用字段`"
          @change="patch(filter.id, { value: val($event) })"
        >
          <option value="">选择当前表单字段</option>
          <option
            v-if="
              filter.value &&
              !localChoices(filter).some((field) => field.id === filter.value)
            "
            :value="filter.value"
            disabled
          >
            原字段不在当前可用范围
          </option>
          <option v-for="f in localChoices(filter)" :key="f.id" :value="f.id">
            {{ f.pathLabel || f.label }}
          </option></select
        ><select
          v-else-if="
            filter.source === 'constant' &&
            (!constantOnly ||
              ['equals', 'notEquals'].includes(filter.operator)) &&
            (!constantOnly ||
              (!isNumericField(sourceField(filter)) &&
                sourceField(filter)?.type !== 'datetime')) &&
            (constantOnly || options(filter).length)
          "
          class="filter-value"
          :value="filterValue(filter)"
          :disabled="constantOnly && !filter.sourceFieldId"
          :aria-label="`条件${index + 1}固定值`"
          @change="patch(filter.id, { value: val($event) })"
        >
          <option value="">请选择</option>
          <option v-for="o in options(filter)" :key="o.id" :value="o.id">
            {{ o.label }}
          </option></select
        ><input
          v-else-if="filter.source === 'constant'"
          class="filter-value"
          :value="filterValue(filter)"
          :type="
            constantOnly && sourceField(filter)?.type === 'datetime'
              ? dateInputType(sourceField(filter)!.format)
              : constantOnly && isNumericField(sourceField(filter))
                ? 'number'
                : 'text'
          "
          :step="
            constantOnly && sourceField(filter)?.type === 'datetime'
              ? dateInputStep(sourceField(filter)!.format)
              : 'any'
          "
          :aria-label="`条件${index + 1}固定值`"
          placeholder="输入比较值"
          @input="patch(filter.id, { value: val($event) })"
      /></template>
    </div>
    <button class="text-button" @click="addCondition">
      <AppIcon name="add" />{{ compact ? "添加过滤条件" : "添加筛选条件" }}
    </button>
  </div>
</template>
<style scoped>
.compact-filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.compact-filters > .text-button {
  order: -1;
  align-self: flex-start;
  margin: 0;
}
.compact-filters .data-filter-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 130px minmax(0, 1fr) 28px;
  gap: 0;
  border-radius: 3px;
  padding: 0;
  background: white;
  margin: 0;
}
.compact-filters .config-card-header {
  order: 5;
  grid-column: 5;
  grid-row: 1;
}
.compact-filters .config-card-header > span {
  display: none;
}
.compact-filters .data-filter-card > select,
.compact-filters .data-filter-card > input {
  width: 100%;
  min-width: 0;
  height: 32px;
  margin: 0;
  border: 0;
  border-right: 1px solid #e8ebf1;
  border-radius: 0;
  font-size: 13px;
}
.compact-filters select {
  appearance: auto;
}
.constant-filters .data-filter-card {
  grid-template-columns: minmax(0, 1fr) 130px minmax(0, 1.6fr) 28px;
}
.constant-filters .config-card-header {
  grid-column: 4;
}
.constant-filters .filter-value {
  min-width: 0;
  max-width: none;
}
.constant-filters :deep(.choice-dropdown summary) {
  min-height: 32px;
  border: 0;
  border-radius: 0;
  padding: 5px 8px;
  font-size: 13px;
}
@media (max-width: 600px) {
  .compact-filters .data-filter-card,
  .constant-filters .data-filter-card {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px;
    gap: 4px;
    padding: 4px;
  }
  .compact-filters .data-filter-card > select,
  .compact-filters .data-filter-card > input {
    border: 1px solid #e8ebf1;
    border-radius: 3px;
  }
  .compact-filters .config-card-header,
  .constant-filters .config-card-header {
    grid-column: 3;
    grid-row: 1 / span 2;
  }
  .constant-filters .filter-value {
    grid-column: 1 / span 2;
  }
  .constant-filters :deep(.choice-dropdown summary) {
    border: 1px solid #e8ebf1;
    border-radius: 3px;
  }
}
</style>
