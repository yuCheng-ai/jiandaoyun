<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  civilDate,
  civilDay,
  dateInputType,
  dateInputStep,
  dateValueAt,
  normalizeDateValue,
  datePanelValue,
  selectableDateValue,
  validDateValue,
  type FormField,
  type FormValues,
} from "@platform/contracts";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";
const props = withDefaults(
  defineProps<{
    field: FormField;
    modelValue?: unknown;
    disabled?: boolean;
    inputId?: string;
    placeholder?: string;
    label: string;
    values?: FormValues;
  }>(),
  { values: () => ({}) },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const input = ref<HTMLInputElement>(),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  open = ref(false),
  month = ref(""),
  draft = ref(""),
  openedAt = ref(new Date()),
  position = ref({ left: "0px", top: "0px" });
const text = computed(() =>
  typeof props.modelValue === "string" ? props.modelValue : "",
);
const hint = computed(() => props.placeholder ?? props.field.placeholder);
const timed = computed(() => props.field.format.startsWith("datetime-")),
  monthly = computed(() => props.field.format === "month");
const { zIndex } = useDialogLayer(
  panel,
  () => {
    open.value = false;
  },
  () => {},
  { modal: false, anchor: () => trigger.value },
);
const days = computed(() => {
  if (!month.value) return [];
  const start = civilDate(month.value);
  start.setUTCDate(1 - ((start.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const value = civilDay(date);
    return {
      value,
      label: date.getUTCDate(),
      outside: value.slice(0, 7) !== month.value,
    };
  });
});
const months = computed(() =>
  Array.from(
    { length: 12 },
    (_, index) =>
      `${month.value.slice(0, 4)}-${String(index + 1).padStart(2, "0")}`,
  ),
);
const candidate = (day: string) =>
  datePanelValue(props.field, day, draft.value, props.values, openedAt.value);
const selectable = (day: string) =>
  selectableDateValue(
    props.field,
    candidate(day),
    props.values,
    openedAt.value,
  );
const canApply = computed(() =>
  selectableDateValue(props.field, draft.value, props.values, openedAt.value),
);
async function show() {
  if (props.disabled) return;
  if (open.value) {
    open.value = false;
    return;
  }
  openedAt.value = new Date();
  draft.value = validDateValue(props.field.format, text.value)
    ? text.value
    : dateValueAt(props.field.format, openedAt.value);
  month.value = draft.value.slice(0, 7);
  const rect = input.value!.getBoundingClientRect(),
    height = timed.value ? 450 : monthly.value ? 300 : 400;
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(351, window.innerWidth - 16) - 8))}px`,
    top: `${Math.max(8, rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : rect.top - height - 4)}px`,
  };
  open.value = true;
  await nextTick();
  panel.value
    ?.querySelector<HTMLButtonElement>(
      `[data-day="${draft.value.slice(0, monthly.value ? 7 : 10)}"]:not([disabled])`,
    )
    ?.focus();
}
function apply() {
  if (!canApply.value || props.disabled) return;
  emit(
    "update:modelValue",
    normalizeDateValue(props.field.format, draft.value),
  );
  open.value = false;
}
function choose(day: string) {
  draft.value = candidate(day);
  if (!timed.value) apply();
}
function navigate(amount: number) {
  const date = civilDate(month.value);
  date.setUTCMonth(date.getUTCMonth() + amount);
  if (date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999)
    month.value = civilDay(date).slice(0, 7);
}
async function keys(event: KeyboardEvent) {
  if (
    monthly.value ||
    !(event.target instanceof HTMLElement) ||
    !event.target.dataset.day
  )
    return;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[
    event.key as "ArrowLeft"
  ];
  if (!delta) return;
  event.preventDefault();
  const date = civilDate(event.target.dataset.day);
  for (let count = 0; count < 62; count++) {
    date.setUTCDate(date.getUTCDate() + delta);
    const day = civilDay(date);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    if (!selectable(day)) continue;
    month.value = day.slice(0, 7);
    await nextTick();
    panel.value
      ?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)
      ?.focus();
    return;
  }
}
function inputKey(event: KeyboardEvent) {
  if (event.altKey && event.key === "ArrowDown") {
    event.preventDefault();
    void show();
  }
}
function leave(event: Event) {
  if (
    open.value &&
    !(event.target instanceof Node && panel.value?.contains(event.target))
  )
    open.value = false;
}
watch(open, (value) => {
  if (value) {
    window.addEventListener("resize", leave);
    window.addEventListener("scroll", leave, true);
  } else {
    window.removeEventListener("resize", leave);
    window.removeEventListener("scroll", leave, true);
  }
});
watch(
  [() => props.field.id, () => props.field.format, () => props.disabled],
  () => {
    open.value = false;
  },
);
onBeforeUnmount(() => {
  window.removeEventListener("resize", leave);
  window.removeEventListener("scroll", leave, true);
});
</script>
<template>
  <div class="date-field-control">
    <input
      ref="input"
      :id="inputId"
      :class="{ 'date-empty': !text }"
      :type="dateInputType(field.format)"
      :step="dateInputStep(field.format)"
      :aria-label="label"
      :placeholder="hint"
      :value="text"
      :disabled="disabled"
      @input="
        emit(
          'update:modelValue',
          normalizeDateValue(
            field.format,
            ($event.target as HTMLInputElement).value,
          ),
        )
      "
      @keydown="inputKey"
    />
    <span v-if="!text && hint" class="date-placeholder" aria-hidden="true">{{
      hint
    }}</span>
    <button
      ref="trigger"
      type="button"
      class="date-calendar-trigger"
      :aria-label="`选择${label}`"
      :aria-expanded="open"
      :disabled="disabled"
      @click="show"
    >
      <AppIcon name="calendar" :size="18" />
    </button>
  </div>
  <Teleport to="body">
    <section
      v-if="open"
      ref="panel"
      role="dialog"
      :aria-label="`${label}日期选择`"
      tabindex="-1"
      class="date-calendar-panel"
      :style="{ ...position, zIndex }"
      @keydown="keys"
    >
      <header>
        <button
          type="button"
          :disabled="Number(month.slice(0, 4)) <= 1"
          aria-label="上一年"
          @click="navigate(-12)"
        >
          <AppIcon name="back" :size="13" /><AppIcon name="back" :size="13" />
        </button>
        <button
          v-if="!monthly"
          type="button"
          :disabled="month === '0001-01'"
          aria-label="上个月"
          @click="navigate(-1)"
        >
          <AppIcon name="back" :size="16" />
        </button>
        <span
          >{{ month.slice(0, 4)
          }}<template v-if="!monthly"
            >　{{ Number(month.slice(5)) }}月</template
          ></span
        >
        <button
          v-if="!monthly"
          type="button"
          :disabled="month === '9999-12'"
          aria-label="下个月"
          @click="navigate(1)"
        >
          <AppIcon name="right" :size="16" />
        </button>
        <button
          type="button"
          :disabled="Number(month.slice(0, 4)) >= 9999"
          aria-label="下一年"
          @click="navigate(12)"
        >
          <AppIcon name="right" :size="13" /><AppIcon name="right" :size="13" />
        </button>
      </header>
      <div v-if="monthly" class="date-month-grid">
        <button
          v-for="value in months"
          :key="value"
          type="button"
          :data-day="value"
          :aria-label="value"
          :disabled="!selectable(value)"
          :class="{ selected: draft.slice(0, 7) === value }"
          @click="choose(value)"
        >
          {{ Number(value.slice(5)) }}月
        </button>
      </div>
      <template v-else>
        <div class="date-calendar-week">
          <span
            v-for="day in ['一', '二', '三', '四', '五', '六', '日']"
            :key="day"
            >{{ day }}</span
          >
        </div>
        <div class="date-calendar-grid">
          <button
            v-for="day in days"
            :key="day.value"
            type="button"
            :data-day="day.value"
            :aria-label="day.value"
            :disabled="!selectable(day.value)"
            :class="{
              outside: day.outside,
              selected: draft.slice(0, 10) === day.value,
            }"
            @click="choose(day.value)"
          >
            {{ day.label }}
          </button>
        </div>
      </template>
      <div v-if="timed" class="date-calendar-time">
        <label
          >时间<input
            aria-label="选择时间"
            type="time"
            :step="field.format === 'datetime-second' ? 1 : 60"
            :value="draft.slice(11)"
            @input="
              draft = `${draft.slice(0, 10)}T${normalizeDateValue(field.format, `${draft.slice(0, 10)}T${($event.target as HTMLInputElement).value}`).slice(11)}`
            " /></label
        ><button type="button" :disabled="!canApply" @click="apply">
          确定
        </button>
      </div>
      <footer>
        <button
          type="button"
          :disabled="!selectable(dateValueAt(field.format, openedAt))"
          @click="choose(dateValueAt(field.format, openedAt))"
        >
          {{ monthly ? "本月" : "今天" }}
        </button>
      </footer>
    </section>
  </Teleport>
</template>
<style scoped>
.date-field-control {
  position: relative;
  width: 100%;
  min-width: 0;
}
.date-field-control input {
  width: 100%;
  box-sizing: border-box;
}
.date-field-control input {
  padding-right: 32px;
}
.date-field-control input::-webkit-calendar-picker-indicator {
  display: none;
}
.date-empty:not(:focus)::-webkit-datetime-edit {
  color: transparent;
}
.date-placeholder {
  position: absolute;
  left: 10px;
  right: 34px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted, #8c929b);
  pointer-events: none;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.date-field-control input:focus + .date-placeholder {
  display: none;
}
.date-calendar-trigger {
  position: absolute;
  right: 2px;
  top: 2px;
  height: calc(100% - 4px);
  width: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #8c929b;
  display: grid;
  place-items: center;
}
.date-calendar-panel {
  position: fixed;
  width: min(351px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow: auto;
  background: white;
  border: 1px solid #e9ebef;
  border-radius: 8px;
  box-shadow: 0 4px 20px #0002;
  color: #272e3b;
  font-size: 16px;
}
.date-calendar-panel header {
  display: flex;
  align-items: center;
  height: 50px;
  padding: 0 12px;
  gap: 6px;
  border-bottom: 1px solid #edf0f3;
}
.date-calendar-panel button {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.date-calendar-panel header button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 30px;
  color: #8c929b;
}
.date-calendar-panel header button .app-icon + .app-icon {
  margin-left: -8px;
}
.date-calendar-panel header span {
  flex: 1;
  text-align: center;
  font-weight: 400;
}
.date-calendar-week,
.date-calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  padding: 0 12px;
}
.date-calendar-week span {
  text-align: center;
  height: 50px;
  line-height: 50px;
}
.date-calendar-grid {
  padding-bottom: 10px;
}
.date-calendar-grid button {
  height: 30px;
  width: 30px;
  margin: 5px auto;
  border-radius: 4px;
}
.date-calendar-grid button.outside {
  color: #c2c6ce;
}
.date-calendar-panel button:disabled {
  color: #c2c6ce;
  cursor: default;
  opacity: 1;
}
.date-calendar-panel button:hover:not(:disabled),
.date-calendar-panel button:focus-visible {
  background: #eaf7f6;
  outline: 2px solid #0db3a6;
  outline-offset: -2px;
}
.date-calendar-panel .selected:not(:disabled) {
  background: #0db3a6;
  color: white;
}
.date-calendar-panel footer {
  border-top: 1px solid #edf0f3;
  height: 49px;
  display: flex;
  justify-content: center;
  align-items: center;
}
.date-calendar-panel footer button,
.date-calendar-time button {
  color: #0aab9e;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 14px;
}
.date-calendar-time {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid #edf0f3;
  padding: 8px 16px;
  gap: 12px;
}
.date-calendar-time label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.date-calendar-time input {
  font: inherit;
  border: 1px solid #dce0e6;
  border-radius: 4px;
  padding: 4px 6px;
  width: 140px;
}
.date-month-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 8px 16px;
  gap: 8px;
}
.date-month-grid button {
  height: 38px;
  border-radius: 4px;
}
</style>
