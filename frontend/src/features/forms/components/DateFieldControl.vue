<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
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
  view = ref<"day" | "month" | "year">("day"),
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
const year = computed(() => Number(month.value.slice(0, 4)));
const decade = computed(() => Math.floor(year.value / 10) * 10);
const years = computed(() =>
  Array.from({ length: 12 }, (_, index) => decade.value - 1 + index),
);
const yearStep = computed(() => (view.value === "year" ? 120 : 12));
function positionPanel() {
  if (!panel.value || !input.value) return;
  const rect = input.value.getBoundingClientRect(),
    size = panel.value.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8))}px`,
    top: `${Math.max(
      8,
      Math.min(
        rect.bottom + size.height + 8 <= window.innerHeight
          ? rect.bottom + 4
          : rect.top - size.height - 4,
        window.innerHeight - size.height - 8,
      ),
    )}px`,
  };
}
async function focusCell(value?: string) {
  await nextTick();
  const selector =
    view.value === "year"
      ? `[data-year="${value ?? year.value}"]`
      : view.value === "month"
        ? `[data-month="${value ?? month.value}"]`
        : `[data-day="${value ?? draft.value.slice(0, 10)}"]`;
  (
    panel.value?.querySelector<HTMLButtonElement>(
      `${selector}:not([disabled])`,
    ) ||
    panel.value?.querySelector<HTMLButtonElement>(
      "[data-cell]:not([disabled])",
    ) ||
    panel.value
  )?.focus({ preventScroll: true });
}
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
  view.value = monthly.value ? "month" : "day";
  open.value = true;
  await focusCell();
}
function showView(value: "year" | "month") {
  view.value = value;
  void focusCell();
}
function chooseYear(value: number) {
  month.value = `${String(value).padStart(4, "0")}-${month.value.slice(5)}`;
  showView("month");
}
function chooseMonth(value: string) {
  if (monthly.value) choose(value);
  else {
    month.value = value;
    view.value = "day";
    void focusCell(`${value}-01`);
  }
}
watch([open, view, month], positionPanel, { flush: "post" });
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
  else {
    month.value = draft.value.slice(0, 7);
    view.value = "day";
    void focusCell();
  }
}
function navigate(amount: number) {
  const date = civilDate(month.value);
  date.setUTCMonth(date.getUTCMonth() + amount);
  if (date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999)
    month.value = civilDay(date).slice(0, 7);
}
async function keys(event: KeyboardEvent) {
  if (
    !(event.target instanceof HTMLElement) ||
    !event.target.hasAttribute("data-cell")
  )
    return;
  const delta = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: view.value === "day" ? -7 : -3,
    ArrowDown: view.value === "day" ? 7 : 3,
  }[event.key as "ArrowLeft"];
  if (!delta) return;
  event.preventDefault();
  if (view.value === "year") {
    const target = Number(event.target.dataset.year) + delta;
    if (target < 1 || target > 9999) return;
    month.value = `${String(target).padStart(4, "0")}-${month.value.slice(5)}`;
    await focusCell(String(target));
    return;
  }
  const date = civilDate(
    event.target.dataset.month || event.target.dataset.day!,
  );
  for (let count = 0; count < 62; count++) {
    if (view.value === "month") date.setUTCMonth(date.getUTCMonth() + delta);
    else date.setUTCDate(date.getUTCDate() + delta);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    const day = civilDay(date),
      value = view.value === "month" ? day.slice(0, 7) : day;
    if ((view.value === "day" || monthly.value) && !selectable(value)) continue;
    month.value = day.slice(0, 7);
    await focusCell(value);
    return;
  }
}
function inputKey(event: KeyboardEvent) {
  if (event.altKey && event.key === "ArrowDown") {
    event.preventDefault();
    void show();
  }
}
watch(
  [() => props.field.id, () => props.field.format, () => props.disabled, text],
  () => {
    open.value = false;
  },
);
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
          :disabled="view === 'year' ? decade < 10 : year <= 1"
          :aria-label="view === 'year' ? '前十年' : '上一年'"
          @click="navigate(-yearStep)"
        >
          <AppIcon name="back" :size="13" /><AppIcon name="back" :size="13" />
        </button>
        <button
          v-if="view === 'day'"
          type="button"
          :disabled="month === '0001-01'"
          aria-label="上个月"
          @click="navigate(-1)"
        >
          <AppIcon name="back" :size="16" />
        </button>
        <div class="date-calendar-heading" aria-live="polite">
          <span v-if="view === 'year'">{{ decade }}～{{ decade + 9 }}</span>
          <template v-else>
            <button
              type="button"
              aria-label="选择年份"
              @click="showView('year')"
            >
              {{ year }}
            </button>
            <button
              v-if="view === 'day'"
              type="button"
              aria-label="选择月份"
              @click="showView('month')"
            >
              {{ Number(month.slice(5)) }}月
            </button>
          </template>
        </div>
        <button
          v-if="view === 'day'"
          type="button"
          :disabled="month === '9999-12'"
          aria-label="下个月"
          @click="navigate(1)"
        >
          <AppIcon name="right" :size="16" />
        </button>
        <button
          type="button"
          :disabled="view === 'year' ? decade >= 9990 : year >= 9999"
          :aria-label="view === 'year' ? '后十年' : '下一年'"
          @click="navigate(yearStep)"
        >
          <AppIcon name="right" :size="13" /><AppIcon name="right" :size="13" />
        </button>
      </header>
      <div v-if="view === 'year'" class="date-month-grid">
        <button
          v-for="value in years"
          :key="value"
          type="button"
          data-cell
          :data-year="value"
          :aria-label="`${value}年`"
          :disabled="value < 1 || value > 9999"
          :class="{
            selected: Number(draft.slice(0, 4)) === value,
            outside: value < decade || value > decade + 9,
          }"
          @click="chooseYear(value)"
        >
          {{ value }}
        </button>
      </div>
      <div v-else-if="view === 'month'" class="date-month-grid">
        <button
          v-for="value in months"
          :key="value"
          type="button"
          :data-day="monthly ? value : undefined"
          data-cell
          :data-month="value"
          :aria-label="value"
          :disabled="monthly && !selectable(value)"
          :class="{ selected: draft.slice(0, 7) === value }"
          @click="chooseMonth(value)"
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
            data-cell
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
      <div v-if="timed && view === 'day'" class="date-calendar-time">
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
      <footer v-if="view === 'day' || (monthly && view === 'month')">
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
  width: min(280px, calc(100vw - 16px));
  box-sizing: border-box;
  max-height: calc(100vh - 16px);
  overflow: auto;
  background: white;
  border: 1px solid #e9ebef;
  border-radius: 8px;
  box-shadow: 0 4px 20px #0002;
  color: #272e3b;
  font-size: 14px;
}
.date-calendar-panel header {
  display: flex;
  align-items: center;
  height: 40px;
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
.date-calendar-heading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.date-calendar-panel .date-calendar-heading button {
  width: auto;
  padding: 0 4px;
  color: inherit;
}
.date-calendar-week,
.date-calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  padding: 0 12px;
}
.date-calendar-week span {
  text-align: center;
  height: 40px;
  line-height: 40px;
}
.date-calendar-grid {
  padding-bottom: 10px;
}
.date-calendar-grid button {
  height: 30px;
  width: 30px;
  margin: 1px auto;
  border-radius: 4px;
}
.date-calendar-panel button.outside {
  color: #c2c6ce;
}
.date-calendar-panel button:disabled {
  color: #c2c6ce;
  cursor: default;
  opacity: 1;
}
.date-calendar-panel button:hover:not(:disabled) {
  background: #eaf7f6;
}
.date-calendar-panel button:focus-visible {
  outline: 2px solid #0db3a6;
  outline-offset: -2px;
}
.date-calendar-panel .selected:not(:disabled) {
  background: #0db3a6;
  color: white;
}
.date-calendar-panel footer {
  border-top: 1px solid #edf0f3;
  height: 40px;
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
  width: 120px;
}
.date-month-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 16px 8px;
  grid-auto-rows: 62px;
}
.date-month-grid button {
  height: 32px;
  width: 62px;
  align-self: center;
  justify-self: center;
  border-radius: 4px;
}
</style>
