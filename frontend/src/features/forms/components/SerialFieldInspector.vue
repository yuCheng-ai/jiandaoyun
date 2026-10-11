<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  defaultSerialSettings,
  formatSerialDate,
  serialDateFormats,
  serialResetCycles,
  serialSettingsErrors,
  type SerialRule,
  type SerialSettings,
} from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import {
  copy,
  uid,
  findField,
  type FormField,
  type FormSchema,
} from "../../../domain/form";
import {
  currentSerialCounter,
  serialSourceFields,
} from "../../../domain/serial";
import { useWorkspaceStore } from "../../../stores/workspace";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const store = useWorkspaceStore();
const settings = computed(() => props.field.serial);
const sources = computed(() => serialSourceFields(props.schema));
const dialog = ref<"" | "counter" | "date" | "reset">("");
const counterDraft = ref(defaultSerialSettings("counter"));
const counterError = computed(
  () => serialSettingsErrors(counterDraft.value)[0] || "",
);
const dateId = ref(""),
  dateMode = ref<"preset" | "custom">("custom"),
  customDate = ref("yyyyMMdd"),
  presetDate = ref("yyyy");
const dateFormat = computed(() =>
  dateMode.value === "preset" ? presetDate.value : customDate.value,
);
const sampleDate = new Date("2015-01-01T00:00:00+08:00");
const counter = computed(() =>
  settings.value
    ? currentSerialCounter(store.data, props.formId, props.field)
    : undefined,
);
const started = computed(
  () =>
    !!store.data.serialCounters?.[props.formId]?.[props.field.id]?.[
      settings.value?.reset || "none"
    ],
);
const resetBusy = ref(false);
const resetInitial = computed(() => {
  const published = store.data.forms.find(
    (f) => f.id === props.formId,
  )?.published;
  return published
    ? findField(published.schema.fields, props.field.id)?.serial?.initial
    : undefined;
});
async function resetCounter() {
  if (resetBusy.value) return;
  resetBusy.value = true;
  try {
    if (await store.resetSerialCounter(props.formId, props.field.id))
      dialog.value = "";
  } finally {
    resetBusy.value = false;
  }
}
const trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  menu = ref(false),
  fieldMenu = ref(false);
const position = ref({ left: "0px", top: "0px" });
const { zIndex } = useDialogLayer(
  panel,
  () => {
    menu.value = false;
  },
  () => {},
  { modal: false, anchor: () => trigger.value },
);
function update(patch: Partial<SerialSettings>) {
  if (settings.value)
    emit("update", { serial: { ...settings.value, ...patch } });
}
function rules(next: SerialRule[]) {
  update({ rules: next });
}
function openCounter() {
  counterDraft.value = copy(settings.value!);
  dialog.value = "counter";
}
function saveCounter() {
  if (counterError.value) return;
  const { digits, fixed, reset, initial } = counterDraft.value;
  update({ digits, fixed, reset, initial });
  dialog.value = "";
}
function openDate(rule: Extract<SerialRule, { type: "date" }>) {
  dateId.value = rule.id;
  dateMode.value = rule.mode;
  customDate.value = rule.mode === "custom" ? rule.format : "yyyyMMdd";
  presetDate.value = rule.mode === "preset" ? rule.format : "yyyy";
  dialog.value = "date";
}
function saveDate() {
  if (!dateFormat.value.trim()) return;
  rules(
    settings.value!.rules.map((r) =>
      r.id === dateId.value
        ? {
            id: r.id,
            type: "date",
            mode: dateMode.value,
            format: dateFormat.value,
          }
        : r,
    ),
  );
  dialog.value = "";
}
async function openMenu() {
  if (menu.value) {
    menu.value = false;
    return;
  }
  const rect = trigger.value!.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.left + rect.width - 200, window.innerWidth - 188))}px`,
    top: `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 260))}px`,
  };
  fieldMenu.value = false;
  menu.value = true;
  await nextTick();
  panel.value
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}
function add(type: "date" | "text" | "field", fieldId = "") {
  if (
    !settings.value ||
    (type === "date" && settings.value.rules.some((r) => r.type === "date"))
  )
    return;
  const id = uid("rule"),
    rule: SerialRule =
      type === "date"
        ? { id, type, mode: "custom", format: "yyyyMMdd" }
        : type === "text"
          ? { id, type, value: "" }
          : { id, type, fieldId };
  rules([...settings.value.rules, rule]);
  menu.value = false;
}
const dragging = ref(""),
  target = ref(""),
  after = ref(false);
function end() {
  dragging.value = target.value = "";
}
function start(id: string, event: DragEvent) {
  if (!event.dataTransfer) return;
  dragging.value = id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
}
function over(id: string, event: DragEvent) {
  if (!dragging.value) return;
  event.preventDefault();
  target.value = id;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  after.value = event.clientY >= rect.top + rect.height / 2;
}
function drop(id: string, event: DragEvent) {
  event.preventDefault();
  const rule = settings.value!.rules.find((r) => r.id === dragging.value);
  if (rule && rule.id !== id) {
    const next = settings.value!.rules.filter((r) => r.id !== rule.id),
      index = next.findIndex((r) => r.id === id);
    if (index >= 0) {
      next.splice(index + Number(after.value), 0, rule);
      rules(next);
    }
  }
  end();
}
function move(index: number, offset: number) {
  const next = [...settings.value!.rules],
    to = index + offset;
  if (to < 0 || to >= next.length) return;
  [next[index], next[to]] = [next[to]!, next[index]!];
  rules(next);
}
function text(rule: SerialRule, value: string) {
  rules(
    settings.value!.rules.map((r) =>
      r.id === rule.id ? { id: r.id, type: "text", value } : r,
    ),
  );
}
</script>
<template>
  <template v-if="settings">
    <div class="form-group serial-inspector">
      <label>流水号规则</label>
      <div class="serial-rule-list">
        <div
          v-for="(rule, index) in settings.rules"
          :key="rule.id"
          class="serial-rule"
          :class="{
            'drop-before': target === rule.id && !after,
            'drop-after': target === rule.id && after,
          }"
          @dragover.stop="over(rule.id, $event)"
          @drop.stop="drop(rule.id, $event)"
        >
          <button
            type="button"
            class="icon-button serial-drag"
            draggable="true"
            :aria-label="`拖动排序流水号规则 ${index + 1}`"
            title="拖动排序（Alt+↑/↓）"
            @dragstart.stop="start(rule.id, $event)"
            @dragend.stop="end"
            @keydown.alt.up.prevent="move(index, -1)"
            @keydown.alt.down.prevent="move(index, 1)"
          >
            <AppIcon name="list" :size="14" />
          </button>
          <button
            v-if="rule.type === 'counter'"
            type="button"
            class="serial-rule-content"
            @click="openCounter"
          >
            <span>自动计数</span> {{ settings.digits }}位数字,{{
              serialResetCycles[settings.reset]
            }}
          </button>
          <button
            v-else-if="rule.type === 'date'"
            type="button"
            class="serial-rule-content"
            @click="openDate(rule)"
          >
            <span>提交日期</span> 格式：{{
              formatSerialDate(rule.format, sampleDate)
            }}
          </button>
          <label v-else-if="rule.type === 'text'" class="serial-rule-content"
            ><span>固定字符</span
            ><input
              :value="rule.value"
              :aria-label="`固定字符 ${index + 1}`"
              @input="text(rule, ($event.target as HTMLInputElement).value)"
          /></label>
          <div v-else class="serial-rule-content">
            <span>表单字段</span>
            {{
              sources.find((f) => f.id === rule.fieldId)?.label || "字段已删除"
            }}
          </div>
          <button
            v-if="rule.type !== 'counter'"
            type="button"
            class="icon-button"
            :aria-label="`移除流水号规则 ${index + 1}`"
            @click="rules(settings.rules.filter((r) => r.id !== rule.id))"
          >
            <AppIcon name="trash" :size="14" />
          </button>
        </div>
      </div>
      <button
        ref="trigger"
        type="button"
        class="button serial-add"
        aria-label="添加流水号规则"
        :aria-expanded="menu"
        @click="openMenu"
      >
        <AppIcon name="add" :size="14" />添加
      </button>
    </div>
    <div class="form-group">
      <label>流水号重置</label>
      <p class="field-hint serial-next">
        {{
          started ? "已开始计数" : "暂未开始计数"
        }}，下一条数据提交时计数值为{{ counter?.next }}
      </p>
      <button
        v-if="started && resetInitial !== undefined"
        type="button"
        class="text-button"
        @click="dialog = 'reset'"
      >
        重置
      </button>
    </div>
  </template>
  <div v-else class="form-group">
    <label>流水号规则</label
    ><button
      type="button"
      class="button"
      @click="
        emit('update', {
          serial: defaultSerialSettings(uid('rule')),
          required: false,
          unique: false,
          editable: false,
        })
      "
    >
      设置流水号规则
    </button>
  </div>
  <Teleport to="body"
    ><div
      v-if="menu"
      ref="panel"
      class="serial-add-menu"
      role="menu"
      aria-label="流水号规则类型"
      :style="{ ...position, zIndex }"
    >
      <button
        type="button"
        role="menuitem"
        :disabled="settings?.rules.some((r) => r.type === 'date')"
        @click="add('date')"
      >
        提交日期
      </button>
      <button type="button" role="menuitem" @click="add('text')">
        固定字符
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!sources.length"
        :aria-expanded="fieldMenu"
        @click="fieldMenu = !fieldMenu"
      >
        <AppIcon :name="fieldMenu ? 'down' : 'right'" :size="12" /> 表单字段
      </button>
      <div v-if="fieldMenu" class="serial-field-menu">
        <button
          v-for="field in sources"
          :key="field.id"
          type="button"
          role="menuitem"
          @click="add('field', field.id)"
        >
          {{ field.label }}
        </button>
      </div>
    </div></Teleport
  >
  <BaseDialog
    :open="dialog === 'counter'"
    title="计数设置"
    width="560px"
    class-name="serial-settings-dialog"
    @close="dialog = ''"
  >
    <div class="serial-counter-form">
      <label>计数位数</label>
      <div class="serial-stepper">
        <button
          type="button"
          class="button"
          aria-label="减少计数位数"
          :disabled="counterDraft.digits <= 2"
          @click="counterDraft.digits--"
        >
          <AppIcon name="minus" :size="14" /></button
        ><input
          v-model.number="counterDraft.digits"
          type="number"
          min="2"
          max="12"
          aria-label="计数位数"
        /><button
          type="button"
          class="button"
          aria-label="增加计数位数"
          :disabled="counterDraft.digits >= 12"
          @click="counterDraft.digits++"
        >
          <AppIcon name="add" :size="14" />
        </button>
      </div>
      <label class="serial-spaced">位数固定</label
      ><input
        v-model="counterDraft.fixed"
        type="checkbox"
        role="switch"
        class="serial-switch"
        aria-label="位数固定"
      />
      <label class="serial-spaced" for="serial-reset-cycle">重置周期</label>
      <div class="select-wrap serial-select">
        <select id="serial-reset-cycle" v-model="counterDraft.reset">
          <option
            v-for="(label, value) in serialResetCycles"
            :key="value"
            :value="value"
          >
            {{ label }}
          </option>
        </select>
        <AppIcon name="down" :size="14" />
      </div>
      <label class="serial-spaced" for="serial-initial">初始值</label
      ><input
        id="serial-initial"
        v-model.number="counterDraft.initial"
        type="number"
        min="0"
        :max="10 ** Number(counterDraft.digits) - 1"
      />
      <p v-if="counterError" class="error-message" role="alert">
        {{ counterError }}
      </p>
    </div>
    <template #footer
      ><button type="button" class="button" @click="dialog = ''">取消</button
      ><button
        type="button"
        class="button primary"
        :disabled="!!counterError"
        @click="saveCounter"
      >
        确定
      </button></template
    >
  </BaseDialog>
  <BaseDialog
    :open="dialog === 'date'"
    title="日期格式设置"
    width="560px"
    class-name="serial-settings-dialog"
    @close="dialog = ''"
  >
    <div class="serial-date-form">
      <label class="serial-radio"
        ><input
          v-model="dateMode"
          type="radio"
          value="preset"
          name="serial-date-mode"
        />预定义格式</label
      >
      <div class="select-wrap serial-select">
        <select
          v-model="presetDate"
          :disabled="dateMode !== 'preset'"
          aria-label="预定义日期格式"
        >
          <option
            v-for="format in serialDateFormats"
            :key="format"
            :value="format"
          >
            {{ formatSerialDate(format, sampleDate) }}
          </option>
        </select>
        <AppIcon name="down" :size="14" />
      </div>
      <label class="serial-radio serial-spaced"
        ><input
          v-model="dateMode"
          type="radio"
          value="custom"
          name="serial-date-mode"
        />自定义格式</label
      ><input
        v-model="customDate"
        :disabled="dateMode !== 'custom'"
        aria-label="自定义日期格式"
      />
      <p class="field-hint serial-date-preview">
        格式预览：{{ formatSerialDate(dateFormat, sampleDate) }}
      </p>
      <p v-if="!dateFormat.trim()" class="error-message" role="alert">
        请填写日期格式
      </p>
    </div>
    <template #footer
      ><button type="button" class="button" @click="dialog = ''">取消</button
      ><button
        type="button"
        class="button primary"
        :disabled="!dateFormat.trim()"
        @click="saveDate"
      >
        确定
      </button></template
    >
  </BaseDialog>
  <BaseDialog
    :open="dialog === 'reset'"
    title="重置流水号"
    :busy="resetBusy"
    @close="dialog = ''"
  >
    <p>
      确定重置流水号？重置后，下一条数据从已发布规则的初始值
      {{ resetInitial }} 开始计数，已有数据的编号保持不变。
    </p>
    <template #footer
      ><button type="button" class="button" @click="dialog = ''">取消</button
      ><button type="button" class="button primary" @click="resetCounter">
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.serial-rule-list {
  display: grid;
  gap: 8px;
  margin-bottom: 8px;
}
.serial-rule {
  display: flex;
  align-items: center;
  border: 1px solid #d9dde2;
  border-radius: 4px;
  height: 32px;
  position: relative;
}
.serial-rule .icon-button {
  flex: 0 0 30px;
  width: 30px;
  height: 28px;
}
.serial-drag {
  cursor: grab;
  border-right: 1px solid #e8eaed;
  border-radius: 0;
}
.serial-rule-content {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  padding: 0 6px;
  font-size: 14px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  margin: 0;
  height: 30px;
}
.serial-rule-content span {
  color: #2b73f0;
  flex-shrink: 0;
}
.serial-rule-content input {
  flex: 1;
  min-width: 0;
  border: 0;
  height: 28px;
  padding: 0;
  font-size: 14px;
}
.serial-add {
  width: 100%;
  justify-content: center;
}
.serial-next {
  margin: 0;
  line-height: 1.8;
}
.drop-before::before,
.drop-after::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: #00ada1;
}
.drop-before::before {
  top: -5px;
}
.drop-after::after {
  bottom: -5px;
}
.serial-add-menu {
  position: fixed;
  width: 180px;
  max-height: 252px;
  overflow: auto;
  background: white;
  border: 1px solid #dce1e8;
  border-radius: 4px;
  box-shadow: 0 4px 14px #24364d26;
  padding: 4px;
}
.serial-add-menu button {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 8px 12px;
  text-align: left;
  font-size: 13px;
}
.serial-add-menu button:hover {
  background: #e9f7f5;
}
.serial-add-menu button:disabled {
  color: #b7bdc6;
}
.serial-field-menu button {
  padding-left: 36px;
}
.serial-counter-form {
  min-height: 390px;
}
.serial-counter-form > label,
.serial-date-form > label {
  display: block;
  font-size: 13px;
  margin-bottom: 10px;
}
.serial-spaced {
  margin-top: 26px;
}
.serial-counter-form > input:not([type="checkbox"]),
.serial-select {
  width: 246px;
  max-width: 100%;
}
.serial-counter-form > input:not([type="checkbox"]),
.serial-select > select {
  height: 32px;
  padding: 4px 8px;
  border: 1px solid #d6dce4;
  border-radius: 4px;
  font-size: 13px;
}
.serial-select > select {
  width: 100%;
  padding-right: 28px;
}
.serial-stepper {
  display: flex;
  width: 130px;
}
.serial-stepper .button {
  width: 32px;
  min-width: 32px;
  padding: 0;
  justify-content: center;
}
.serial-stepper input {
  width: 66px;
  height: 32px;
  border: 1px solid #d6dce4;
  border-left: 0;
  border-right: 0;
  text-align: center;
  appearance: textfield;
  border-radius: 0;
}
.serial-stepper input::-webkit-inner-spin-button {
  appearance: none;
}
.serial-counter-form .serial-switch {
  appearance: none;
  width: 44px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: #b9bec4;
  position: relative;
  cursor: pointer;
}
.serial-switch::after {
  content: "";
  width: 18px;
  height: 18px;
  position: absolute;
  top: 2px;
  left: 2px;
  border-radius: 50%;
  background: white;
}
.serial-counter-form .serial-switch:checked {
  background: #00ada1;
}
.serial-switch:checked::after {
  left: 24px;
}
.serial-date-form {
  min-height: 180px;
}
.serial-date-preview {
  margin: 4px 0 0 20px;
}
.serial-date-form > input {
  width: 350px;
  max-width: calc(100% - 20px);
  height: 32px;
  padding: 4px 8px;
  border: 1px solid #d6dce4;
  border-radius: 4px;
  font-size: 13px;
  margin-left: 20px;
}
.serial-date-form > .serial-select {
  margin-left: 20px;
  max-width: calc(100% - 20px);
}
.serial-date-form .serial-radio {
  display: flex;
  align-items: center;
  gap: 8px;
}
.serial-radio input {
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
}
.error-message {
  color: #c33;
  font-size: 12px;
}
:global(.serial-settings-dialog > .dialog-header) {
  padding: 10px 20px;
}
:global(.serial-settings-dialog > .dialog-header h2) {
  font-size: 18px;
}
:global(.serial-settings-dialog > .dialog-body) {
  padding: 20px;
}
:global(.serial-settings-dialog > .dialog-footer) {
  padding: 12px 20px;
}
:global(.serial-settings-dialog > .dialog-footer .button) {
  min-width: 54px;
}
</style>
