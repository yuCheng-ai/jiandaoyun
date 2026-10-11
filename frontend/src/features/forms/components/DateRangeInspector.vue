<script setup lang="ts">
import { computed } from "vue";
import {
  datePresets,
  dateUnits,
  dateScopeFields,
  dateInputType,
  dateInputStep,
  normalizeDateValue,
  emptyDateRange,
  type DateRange,
  type DateBoundary,
  type FormField,
} from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
const props = defineProps<{ field: FormField; fields: FormField[] }>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const range = computed(() => props.field.dateRange || emptyDateRange());
const available = computed(() =>
  dateScopeFields(props.fields, props.field.id).filter(
    (field) =>
      field.id !== props.field.id &&
      field.type === "datetime" &&
      field.format === props.field.format,
  ),
);
const weekdays = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
];
function update(patch: Partial<DateRange>) {
  emit("update", { dateRange: { ...range.value, ...patch } });
}
function boundary(key: "earliest" | "latest", patch: Partial<DateBoundary>) {
  update({ [key]: { ...range.value[key], ...patch } });
}
function day(value: number, enabled: boolean) {
  update({
    weekdays: enabled
      ? [...new Set([...range.value.weekdays, value])]
      : range.value.weekdays.filter((day) => day !== value),
  });
}
</script>
<template>
  <div class="form-group date-range-inspector">
    <label>限制可选范围</label>
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="range.weekdaysEnabled"
        @change="
          update({
            weekdaysEnabled: ($event.target as HTMLInputElement).checked,
          })
        "
      />可选星期</label
    >
    <div v-if="range.weekdaysEnabled" class="date-weekdays">
      <label v-for="dayItem in weekdays" :key="dayItem.value"
        ><input
          type="checkbox"
          :aria-label="`星期${dayItem.label}`"
          :checked="range.weekdays.includes(dayItem.value)"
          @change="
            day(dayItem.value, ($event.target as HTMLInputElement).checked)
          "
        />{{ dayItem.label }}</label
      >
    </div>
    <div
      v-for="item in [
        { key: 'earliest', label: '最早可选时间' },
        { key: 'latest', label: '最晚可选时间' },
      ] as const"
      :key="item.key"
    >
      <label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="range[item.key].enabled"
          @change="
            boundary(item.key, {
              enabled: ($event.target as HTMLInputElement).checked,
            })
          "
        />{{ item.label }}</label
      >
      <template v-if="range[item.key].enabled">
        <div
          class="date-boundary-row"
          :class="{
            'time-boundary':
              range[item.key].mode === 'fixed' &&
              field.format.startsWith('datetime-'),
          }"
        >
          <div class="select-wrap">
            <select
              :aria-label="`${item.label}方式`"
              :value="range[item.key].mode"
              @change="
                boundary(item.key, {
                  mode: ($event.target as HTMLSelectElement)
                    .value as DateBoundary['mode'],
                })
              "
            >
              <option value="dynamic">动态值</option>
              <option value="fixed">固定值</option>
              <option value="field">字段值</option></select
            ><AppIcon name="down" />
          </div>
          <div v-if="range[item.key].mode === 'dynamic'" class="select-wrap">
            <select
              :aria-label="`${item.label}动态值`"
              :value="range[item.key].preset"
              @change="
                boundary(item.key, {
                  preset:
                    ($event.target as HTMLSelectElement).value === 'custom'
                      ? 'custom'
                      : Number(($event.target as HTMLSelectElement).value),
                })
              "
            >
              <option
                v-for="preset in datePresets"
                :key="preset.value"
                :value="preset.value"
              >
                {{ preset.label }}
              </option>
              <option value="custom">自定义</option></select
            ><AppIcon name="down" />
          </div>
          <input
            v-else-if="range[item.key].mode === 'fixed'"
            :aria-label="`${item.label}固定值`"
            :type="dateInputType(field.format)"
            :step="dateInputStep(field.format)"
            :value="range[item.key].value"
            @input="
              boundary(item.key, {
                value: normalizeDateValue(
                  field.format,
                  ($event.target as HTMLInputElement).value,
                ),
              })
            "
          />
          <div v-else class="select-wrap">
            <select
              :aria-label="`${item.label}字段值`"
              :value="range[item.key].fieldId"
              @change="
                boundary(item.key, {
                  fieldId: ($event.target as HTMLSelectElement).value,
                })
              "
            >
              <option value="">请选择字段</option>
              <option
                v-if="
                  range[item.key].fieldId &&
                  !available.some(
                    (field) => field.id === range[item.key].fieldId,
                  )
                "
                :value="range[item.key].fieldId"
                disabled
              >
                原字段已失效
              </option>
              <option
                v-for="other in available"
                :key="other.id"
                :value="other.id"
              >
                {{ other.label }}
              </option></select
            ><AppIcon name="down" />
          </div>
        </div>
        <div
          v-if="
            range[item.key].mode === 'dynamic' &&
            range[item.key].preset === 'custom'
          "
          class="date-dynamic-row"
        >
          <div class="select-wrap">
            <select
              :aria-label="`${item.label}时间状态`"
              :value="range[item.key].direction"
              @change="
                boundary(item.key, {
                  direction: ($event.target as HTMLSelectElement)
                    .value as DateBoundary['direction'],
                })
              "
            >
              <option value="current">当前</option>
              <option value="past">过去</option>
              <option value="future">未来</option></select
            ><AppIcon name="down" />
          </div>
          <input
            :aria-label="`${item.label}数量`"
            type="number"
            min="1"
            max="99"
            :disabled="range[item.key].direction === 'current'"
            :value="
              range[item.key].direction === 'current'
                ? 1
                : range[item.key].amount
            "
            @change="
              boundary(item.key, {
                amount: Math.max(
                  1,
                  Math.min(
                    99,
                    Math.round(
                      Number(($event.target as HTMLInputElement).value),
                    ),
                  ),
                ),
              })
            "
          />
          <div class="select-wrap">
            <select
              :aria-label="`${item.label}单位`"
              :value="range[item.key].unit"
              @change="
                boundary(item.key, {
                  unit: ($event.target as HTMLSelectElement)
                    .value as DateBoundary['unit'],
                })
              "
            >
              <option
                v-for="unit in dateUnits"
                :key="unit.value"
                :value="unit.value"
              >
                {{ unit.label }}
              </option></select
            ><AppIcon name="down" />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.date-weekdays {
  display: flex;
  justify-content: space-between;
  margin: 4px 0 8px;
  gap: 4px;
}
.date-weekdays label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  margin: 0;
}
.date-weekdays input {
  width: 14px;
  height: 14px;
}
.date-boundary-row {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 8px;
  margin: 4px 0 8px;
}
.date-boundary-row > *,
.date-dynamic-row > * {
  min-width: 0;
  width: 100%;
}
.date-dynamic-row {
  display: grid;
  grid-template-columns: 1fr 52px 1fr;
  gap: 6px;
  margin: 0 0 8px;
}
.time-boundary > input {
  grid-column: 1 / -1;
}
</style>
