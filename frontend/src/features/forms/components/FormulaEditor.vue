<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { isNumericField } from "@platform/contracts";
import type {
  FormField,
  FormSchema,
  FormValues,
  FormValidationRule,
} from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, defaultValues, fieldDefinition } from "../../../domain/form";
import {
  formulaFields,
  formulaFunctions,
  formulaFunctionsFor,
  formulaTokens,
  formulaReferences,
  formulaValue,
  formulaConfigurationErrors,
  formulaExpressionErrors,
  evaluateFieldFormula,
  replaceFormulaReferences,
} from "../../../domain/formula";
import { validateFieldConfiguration } from "../../../domain/fieldValidation";
import { formulaLabel } from "../../../domain/formValidation";
import { escapeText, serializeFieldText } from "./fieldText";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  batchExcludedFunctions,
  recordBatchFormulaErrors,
} from "../../../domain/recordBatch";

const props = defineProps<{
  field?: FormField;
  validation?: FormValidationRule;
  schema: FormSchema;
  batch?: boolean;
}>();
const emit = defineEmits<{
  update: [patch: Partial<FormField>];
  updateValidation: [patch: Pick<FormValidationRule, "expression" | "remark">];
}>();
const runtime = useRuntimeData();
const open = ref(false),
  full = ref(false),
  code = ref(""),
  remark = ref(""),
  html = ref(""),
  error = ref(""),
  notice = ref(""),
  fieldSearch = ref(""),
  functionSearch = ref(""),
  activeFunction = ref(""),
  panel = ref(""),
  replacementFrom = ref(""),
  replacementTo = ref("");
const editor = ref<HTMLElement>(),
  samples = ref<FormValues>({});
let original = "",
  selection: Range | undefined;
const candidates = computed(() =>
  formulaFields(
    props.schema.fields,
    props.field?.id,
    props.field?.type === "calculated",
  ).filter((item) => props.batch || item.field.id !== props.field?.id),
);
const visibleFields = computed(() =>
  candidates.value.filter((item) => item.label.includes(fieldSearch.value)),
);
const referenceFields = computed(() => [
  ...new Map(
    [
      ...formulaFields(props.schema.fields, props.field?.id),
      ...candidates.value,
    ].map((item) => [item.field.id, item]),
  ).values(),
]);
const commonFunctions = ["CONCATENATE", "DATE", "DATEDIF", "IF", "SUM"];
const functionCatalog = computed(() => formulaFunctionsFor(props.field));
const groups = [
  "常用函数",
  "逻辑函数",
  "文本函数",
  "数学函数",
  "日期函数",
  "高级函数",
];
const visibleFunctions = computed(() =>
  functionCatalog.value.filter(
    (item) =>
      (!props.batch || !batchExcludedFunctions.includes(item.name)) &&
      (item.name + item.description)
        .toLowerCase()
        .includes(functionSearch.value.toLowerCase()),
  ),
);
const functionGroups = computed(() =>
  groups
    .map((name) => ({
      name,
      items:
        name === "常用函数"
          ? functionSearch.value
            ? []
            : commonFunctions.flatMap((name) =>
                visibleFunctions.value.filter((item) => item.name === name),
              )
          : visibleFunctions.value.filter((item) => item.group === name),
    }))
    .filter((group) => group.items.length),
);
const help = computed(() =>
  functionCatalog.value.find((item) => item.name === activeFunction.value),
);
const editingField = computed(() => ({
  ...props.field!,
  expression: code.value,
  ...(props.field?.type === "calculated" &&
  code.value !== props.field.expression
    ? { calculationVersion: 1 as const }
    : {}),
}));
const referenced = computed(() =>
  referenceFields.value.filter((item) =>
    formulaReferences(code.value).includes(item.field.id),
  ),
);
const sampleInputs = computed(() =>
  referenced.value.filter(
    (item) =>
      !item.column &&
      !["checkbox", "multiselect", "members", "departments"].includes(
        item.field.type,
      ),
  ),
);
const trial = computed(() =>
  props.validation
    ? evaluateFieldFormula(code.value, props.schema.fields, samples.value)
    : formulaValue(editingField.value, props.schema.fields, samples.value),
);
const dismiss = useDraftDismiss(
  () => open.value,
  () => ({ code: code.value, remark: remark.value }),
  () => {
    open.value = false;
  },
);
const snapshot = () =>
  JSON.stringify(
    props.validation || {
      id: props.field?.id,
      format: props.field?.format,
      calculationVersion: props.field?.calculationVersion,
      expression: props.field?.expression,
      defaultFormula: props.field?.defaultFormula,
      link: props.field?.defaultLink?.enabled,
      remark: props.field?.formulaRemark,
    },
  );
const escape = escapeText;
function render(value: string) {
  try {
    let output = "",
      end = 0;
    for (const token of formulaTokens(value)) {
      output += escape(value.slice(end, token.start));
      if (token.text.startsWith("{{")) {
        const id = token.text.slice(2, -2),
          item = referenceFields.value.find((f) => f.field.id === id);
        output +=
          '<span class="formula-variable' +
          (!item ? " invalid-variable" : "") +
          '" contenteditable="false" data-field="' +
          escape(id) +
          '">' +
          escape(item?.label || "已失效字段") +
          "</span>";
      } else if (
        formulaFunctions.some((f) => f.name === token.text.toUpperCase())
      )
        output +=
          '<span class="formula-function">' + escape(token.text) + "</span>";
      else output += escape(token.text);
      end = token.end;
    }
    return output + escape(value.slice(end));
  } catch {
    return escape(value);
  }
}
function input() {
  code.value = editor.value
    ? serializeFieldText(editor.value, editor.value)
    : "";
  error.value = "";
  notice.value = "";
  remember();
}
function remember() {
  const current = document.getSelection();
  if (current?.rangeCount && editor.value?.contains(current.anchorNode))
    selection = current.getRangeAt(0).cloneRange();
}
async function start() {
  original = snapshot();
  code.value = props.validation?.expression ?? props.field!.expression;
  remark.value = props.validation?.remark ?? props.field?.formulaRemark ?? "";
  html.value = render(code.value);
  error.value = "";
  notice.value = "";
  panel.value = "";
  full.value = false;
  fieldSearch.value = "";
  functionSearch.value = "";
  activeFunction.value = "";
  samples.value = defaultValues(props.schema.fields);
  for (const item of candidates.value) {
    if (!item.column && samples.value[item.field.id] === undefined)
      samples.value[item.field.id] = item.field.defaultValue;
  }
  selection = undefined;
  open.value = true;
  await nextTick();
  editor.value?.focus();
}
function insert(value: string, functionCall = false) {
  const element = editor.value;
  if (!element) return;
  element.focus();
  const range =
    selection && element.contains(selection.commonAncestorContainer)
      ? selection
      : document.createRange();
  if (!selection || !element.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  const fragment = range.createContextualFragment(render(value)),
    last = fragment.lastChild;
  range.deleteContents();
  range.insertNode(fragment);
  if (last) {
    if (functionCall && last.nodeType === Node.TEXT_NODE)
      range.setStart(last, Math.max(0, (last.textContent || "").length - 1));
    else range.setStartAfter(last);
    range.collapse(true);
    const current = document.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
  }
  input();
}
function paste(event: ClipboardEvent) {
  event.preventDefault();
  insert(event.clipboardData?.getData("text/plain") || "");
}
async function copyFormula() {
  try {
    await navigator.clipboard.writeText(code.value);
    notice.value = "公式已复制";
  } catch {
    notice.value = "复制失败，请重试";
  }
}
function replace() {
  if (!replacementFrom.value || !replacementTo.value) {
    error.value = "请选择要替换的字段";
    return;
  }
  code.value = replaceFormulaReferences(
    code.value,
    new Map([[replacementFrom.value, replacementTo.value]]),
  );
  html.value = render(code.value);
  selection = undefined;
  panel.value = "";
  error.value = "";
}
function sample(item: (typeof candidates.value)[number], event: Event) {
  const value = (event.target as HTMLInputElement).value;
  samples.value[item.field.id] = isNumericField(item.field)
    ? value === ""
      ? ""
      : Number(value)
    : value;
}
function apply() {
  if (snapshot() !== original) {
    error.value = "当前公式设置已变化，请关闭后重新打开；本次输入已保留。";
    return;
  }
  if (props.validation) {
    error.value =
      formulaExpressionErrors(code.value, props.schema.fields, {
        returns: "boolean",
      })[0] || "";
    if (error.value) return;
    emit("updateValidation", { expression: code.value, remark: remark.value });
    dismiss.markSaved();
    open.value = false;
    return;
  }
  const field = {
    ...editingField.value,
    formulaRemark: remark.value,
  };
  error.value =
    (props.batch
      ? recordBatchFormulaErrors(code.value, props.schema.fields, field.type)
      : formulaConfigurationErrors(field, props.schema.fields))[0] || "";
  if (!error.value && !props.batch) {
    const schema = copy(props.schema);
    const visit = (fields: FormField[]) =>
      fields.forEach((f) => {
        if (f.id === field.id) Object.assign(f, field);
        visit(f.children);
      });
    visit(schema.fields);
    error.value =
      validateFieldConfiguration(schema, runtime.value).find((message) =>
        message.includes("循环引用"),
      ) || "";
  }
  if (error.value) return;
  emit("update", {
    expression: code.value,
    formulaRemark: remark.value,
    ...(field.calculationVersion === 1 ? { calculationVersion: 1 } : {}),
  });
  dismiss.markSaved();
  open.value = false;
}
</script>
<template>
  <button
    type="button"
    class="button formula-launch"
    :class="{ 'formula-condition-launch': validation }"
    @click="start"
  >
    <template v-if="validation?.expression">{{
      formulaLabel(validation.expression, schema.fields)
    }}</template>
    <template v-else><AppIcon name="calculator" />编辑公式</template>
  </button>
  <BaseDialog
    :open="open"
    :title="validation ? '提交校验' : '公式编辑'"
    :width="full ? 'calc(100vw - 32px)' : '960px'"
    :class-name="full ? 'formula-dialog formula-full' : 'formula-dialog'"
    @close="dismiss.requestClose"
  >
    <div class="formula-shell">
      <div class="formula-toolbar">
        <span>{{ validation ? "公式" : field?.label }} =</span>
        <div>
          <button type="button" class="text-button" @click="copyFormula">
            <AppIcon name="duplicate" />复制
          </button>
          <button
            type="button"
            class="text-button"
            @click="panel = panel === 'replace' ? '' : 'replace'"
          >
            <AppIcon name="plugin" />替换变量
          </button>
          <button
            type="button"
            class="text-button"
            @click="panel = panel === 'remark' ? '' : 'remark'"
          >
            <AppIcon name="document" />备注
          </button>
          <button
            type="button"
            class="text-button"
            @click="panel = panel === 'debug' ? '' : 'debug'"
          >
            <AppIcon name="settings" />调试
          </button>
          <button
            type="button"
            class="icon-button"
            :aria-label="full ? '退出全屏' : '全屏'"
            @click="full = !full"
          >
            <AppIcon name="expand" />
          </button>
        </div>
      </div>
      <div
        ref="editor"
        class="formula-input"
        contenteditable="true"
        role="textbox"
        aria-label="公式内容"
        aria-multiline="true"
        spellcheck="false"
        @input="input"
        @paste="paste"
        @keyup="remember"
        @mouseup="remember"
        v-html="html"
      />
      <div class="formula-panels">
        <section class="formula-field-list">
          <div class="formula-search">
            <AppIcon name="search" /><input
              v-model="fieldSearch"
              aria-label="搜索变量"
              placeholder="搜索变量"
            />
          </div>
          <div class="formula-list">
            <button
              v-for="item in visibleFields"
              :key="item.field.id"
              type="button"
              @mousedown.prevent
              @click="insert('{{' + item.field.id + '}}')"
            >
              <span>{{ item.label }}</span
              ><small>{{
                item.column ||
                ["checkbox", "multiselect"].includes(item.field.type)
                  ? "数组"
                  : fieldDefinition(item.field.type).label
              }}</small>
            </button>
            <p v-if="!visibleFields.length" class="field-hint">
              没有匹配的字段
            </p>
          </div>
        </section>
        <section class="formula-function-list">
          <div class="formula-search">
            <AppIcon name="search" /><input
              v-model="functionSearch"
              aria-label="搜索函数"
              placeholder="搜索函数"
            />
          </div>
          <div class="formula-list">
            <details
              v-for="group in functionGroups"
              :key="group.name"
              :open="group.name === '常用函数' || !!functionSearch"
            >
              <summary>{{ group.name }}</summary>
              <button
                v-for="item in group.items"
                :key="item.name"
                type="button"
                @mousedown.prevent
                @click="
                  activeFunction = item.name;
                  insert(item.name + '()', true);
                "
              >
                <span>{{ item.name }}</span
                ><small>{{ item.description.split("；")[0] }}</small>
              </button>
            </details>
          </div>
        </section>
        <section class="formula-help">
          <template v-if="panel === 'replace'">
            <label for="formula-replace-from">要替换的变量</label
            ><select id="formula-replace-from" v-model="replacementFrom">
              <option value="">请选择字段</option>
              <option
                v-for="item in referenced"
                :key="item.field.id"
                :value="item.field.id"
              >
                {{ item.label }}
              </option>
            </select>
            <label for="formula-replace-to">替换后的变量</label
            ><select id="formula-replace-to" v-model="replacementTo">
              <option value="">请选择字段</option>
              <option
                v-for="item in candidates"
                :key="item.field.id"
                :value="item.field.id"
              >
                {{ item.label }}
              </option>
            </select>
            <button type="button" class="button" @click="replace">替换</button>
          </template>
          <template v-else-if="panel === 'remark'"
            ><label for="formula-remark">公式备注</label
            ><textarea
              id="formula-remark"
              v-model="remark"
              rows="4"
              maxlength="1000"
            />
          </template>
          <template v-else-if="panel === 'debug'">
            <label v-for="item in sampleInputs" :key="item.field.id"
              >{{ item.label
              }}<input
                :aria-label="'调试 ' + item.label"
                :type="
                  isNumericField(item.field)
                    ? 'number'
                    : item.field.type === 'datetime'
                      ? item.field.format === 'month'
                        ? 'month'
                        : item.field.format === 'date'
                          ? 'date'
                          : 'datetime-local'
                      : 'text'
                "
                :value="samples[item.field.id]"
                @input="sample(item, $event)"
            /></label>
            <p
              v-if="
                referenced.some(
                  (f) =>
                    f.column ||
                    ['checkbox', 'multiselect'].includes(f.field.type),
                )
              "
              class="field-hint"
            >
              明细列及多选项请在表单预览中调试。
            </p>
            <strong>计算结果</strong>
            <p :class="{ 'field-error': trial.error }" role="status">
              {{
                trial.error ||
                (trial.value === "" || trial.value === null
                  ? "空值"
                  : trial.value)
              }}
            </p>
          </template>
          <template v-else-if="help"
            ><strong>{{ help.name }}</strong>
            <p>{{ help.description }}</p>
            <code>{{ help.usage }}</code></template
          >
          <template v-else
            ><p>从左侧选择字段和函数，或输入函数。</p>
            <p>示例：ROUND(12.345, 2)</p>
            <a
              href="https://hc.jiandaoyun.com/doc/9032"
              target="_blank"
              rel="noopener noreferrer"
              >查看公式帮助文档</a
            ></template
          >
        </section>
      </div>
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      role="alertdialog"
      aria-label="放弃公式修改？"
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
    <template #footer
      ><button type="button" class="button" @click="dismiss.requestClose">
        取消</button
      ><button type="button" class="button primary" @click="apply">
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.formula-launch {
  width: 100%;
  justify-content: center;
  gap: 6px;
}
.formula-shell {
  border: 1px solid #dce2e9;
  border-radius: 4px;
  overflow: hidden;
}
.formula-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: #f5f6f8;
  border-bottom: 1px solid #e5e9ef;
}
.formula-toolbar > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.formula-toolbar button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.formula-input {
  min-height: 155px;
  max-height: 260px;
  overflow: auto;
  padding: 12px;
  outline: none;
  font:
    13px/1.9 ui-monospace,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.formula-input:focus-visible {
  box-shadow: inset 0 0 0 1px #00aaa0;
}
.formula-input :deep(.formula-variable) {
  display: inline;
  padding: 2px 5px;
  background: #e9f5ff;
  color: #3278db;
  border-radius: 2px;
}
.formula-input :deep(.invalid-variable) {
  color: #d33e46;
  background: #fff0f0;
}
.formula-input :deep(.formula-function) {
  color: #b23cce;
}
.formula-panels {
  display: grid;
  grid-template-columns: 35% 22% 43%;
  border-top: 1px solid #dce2e9;
  min-width: 0;
}
.formula-panels > section {
  min-width: 0;
}
.formula-field-list,
.formula-function-list {
  border-right: 1px solid #dce2e9;
}
.formula-search {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  gap: 6px;
  border-bottom: 1px solid #e5e9ef;
}
.formula-search input {
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0;
}
.formula-list {
  height: 210px;
  overflow: auto;
}
.formula-list button {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 9px 12px;
  color: #4d5563;
}
.formula-list button:hover {
  background: #f0faf9;
}
.formula-list small {
  flex-shrink: 0;
  font-size: 11px;
  color: #7187a4;
}
.formula-function-list button {
  display: block;
  padding-left: 20px;
}
.formula-function-list small {
  display: block;
  margin-top: 3px;
  white-space: normal;
  color: #8a929e;
}
.formula-list summary {
  padding: 8px 10px;
  color: #293443;
  cursor: pointer;
}
.formula-help {
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.8;
  max-height: 258px;
  overflow: auto;
}
.formula-help a {
  color: #2479d7;
}
.formula-help label {
  display: block;
  margin-bottom: 8px;
}
.formula-help input,
.formula-help select,
.formula-help textarea {
  width: 100%;
  margin: 4px 0 8px;
}
.formula-help code {
  display: block;
  white-space: pre-wrap;
  color: #b23cce;
}
:global(.formula-full .dialog-body) {
  flex: 1;
}
.config-discard {
  margin-top: 10px;
}
@media (max-width: 700px) {
  .formula-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
  .formula-toolbar > div {
    flex-wrap: wrap;
    gap: 8px;
  }
  .formula-input {
    min-height: 130px;
    max-height: 180px;
  }
  .formula-panels {
    grid-template-columns: 52% 48%;
  }
  .formula-function-list {
    border-right: 0;
  }
  .formula-list {
    height: 150px;
  }
  .formula-help {
    grid-column: 1/-1;
    border-top: 1px solid #dce2e9;
    max-height: 180px;
  }
  .formula-list button {
    padding: 8px;
  }
  .formula-list small {
    max-width: 66px;
  }
}
</style>
