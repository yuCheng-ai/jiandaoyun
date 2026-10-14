<script setup lang="ts">
import { provideFileUploads } from "../../../composables/useFileUploads";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import type { FrontendEvent, FrontendFieldChange } from "@platform/contracts";
import {
  subformRowLimitErrors,
  subformRowIdentityErrors,
  identifySubformRows,
  subformOperationErrors,
  subformRowId,
} from "@platform/contracts";
import {
  applyFrontendEvents,
  frontendEventIssues,
  runFrontendEvent,
} from "../../../domain/frontendEvents";
import { applyLookupSelection, lookupIssues } from "../../../domain/lookup";
import FrontendSelectionDialog from "./FrontendSelectionDialog.vue";
import FormFields from "./FormFields.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import {
  formValidationResults,
  changedValidationRules,
  type FormValidationIssue,
} from "../../../domain/formValidation";
import { applyOcrResult } from "../../../domain/ocr";
import { frontendValueFields } from "../../../domain/frontendEventValues";
const OcrRecognitionDialog = defineAsyncComponent(
  () => import("./OcrRecognitionDialog.vue"),
);
import { validateDynamicValues } from "../../../domain/fieldValidation";
import {
  runtimeDefaults,
  subformFillingBaseline,
  applyFieldChange,
  resolveRuntimeValues,
} from "../../../domain/relations";
import {
  validateValues,
  flattenFields,
  findField,
  isFieldVisibleInSchema,
  prepareSubmission,
  copy,
  uid,
  type FormValues,
  type FormSchema,
  type FieldError,
  type FormField,
} from "../../../domain/form";
const props = defineProps<{
  schema: FormSchema;
  device?: "desktop" | "mobile";
  formId: string;
}>();
const runtimeData = useRuntimeData();
const ocrContext = ref<{ fieldId: string }>();
const ocrField = computed(() =>
  ocrContext.value
    ? frontendValueFields(props.schema, true).find(
        (field) => field.id === ocrContext.value!.fieldId,
      )
    : undefined,
);
const ocrDisabled = computed(
  () =>
    !ocrField.value?.visible ||
    !ocrField.value.editable ||
    !ocrField.value.ocr?.mappings.length ||
    !isFieldVisibleInSchema(ocrField.value, props.schema, resolved.value),
);
function commitOcr(result: Record<string, unknown>, fingerprint?: string) {
  const context = ocrContext.value;
  if (!context || ocrDisabled.value || fingerprint !== selectionFingerprint())
    throw Error("表单已变化，请重新识别；填写内容已保留");
  let next = applyOcrResult(
    props.schema,
    context.fieldId,
    resolved.value,
    result,
    runtimeData.value,
  );
  const fields = frontendValueFields(props.schema),
    sources: FrontendFieldChange[] = [];
  for (const mapping of ocrField.value!.ocr!.mappings.filter((item) =>
    Object.hasOwn(result, item.contentId),
  )) {
    const target = fields.find((item) => item.id === mapping.fieldId)!;
    const raw = result[mapping.contentId];
    if (target.parentId && Array.isArray(raw))
      for (let index = 0; index < Math.min(200, raw.length); index++)
        sources.push({
          fieldId: target.id,
          row: { subformId: target.parentId, index },
        });
    else sources.push({ fieldId: target.id });
  }
  // OCR is a member write: the common row operation check must remain enabled.
  if (!triggerEvents(next, sources, false))
    throw Error(changeError.value || "回填未完成，请核对表单提示");
}
// 预览只运行交互与校验；关闭后回收本次上传，不写入记录或本地草稿。
const { uploading: uploadingFiles } = provideFileUploads();
function initialValues() {
  return identifySubformRows(
    props.schema.fields,
    runtimeDefaults(props.schema.fields, runtimeData.value),
  );
}
const values = ref<FormValues>(initialValues());
const permissionBaseline = ref<FormValues>(
  subformFillingBaseline(props.schema.fields, runtimeData.value, values.value),
);
const ignoreRowPermissions = computed(
  () =>
    runtimeData.value.forms.find((form) => form.id === props.formId)?.kind ===
    "workflow",
);
const runtimeKey = ref(0);
const errors = ref<FieldError[]>([]);
const changeError = ref("");
const validationAttempt = ref(0);
const content = ref<HTMLElement>();
const formIssues = ref<FormValidationIssue[]>([]),
  warningOpen = ref(false);
const eventFailures = ref<string[]>([]);
const selectionContext = ref<{
  source: FrontendFieldChange;
  field?: FormField;
  values: FormValues;
  events: FrontendEvent[];
  index: number;
  choices: Record<string, string>;
  fingerprint: string;
}>();
const selectionFingerprint = () =>
  JSON.stringify({
    schema: props.schema,
    values: resolved.value,
    runtime: runtimeKey.value,
    member: runtimeData.value.organization.currentUserId,
  });
const touchedRules = new Set<string>();
let submittedCheck = false,
  warningFingerprint = "";
function checkFormRules(ruleIds?: ReadonlySet<string>) {
  // Process-node validation stays in the existing workflow path.
  return runtimeData.value.forms.find((form) => form.id === props.formId)
    ?.kind === "workflow"
    ? []
    : formValidationResults(
        props.schema,
        prepareSubmission(props.schema, resolved.value, {}, true),
        { data: runtimeData.value, ruleIds },
      );
}
const warningIssues = computed(() =>
  formIssues.value.filter((issue) => issue.mode === "warn"),
);
const validationFingerprint = () =>
  JSON.stringify({
    values: resolved.value,
    rules: props.schema.settings.validations,
    warnings: warningIssues.value,
  });
function resetValidation() {
  selectionContext.value = undefined;
  eventFailures.value = [];
  errors.value = [];
  formIssues.value = [];
  touchedRules.clear();
  submittedCheck = false;
  warningOpen.value = false;
}

const status = ref("");
const resolved = computed(() =>
  resolveRuntimeValues(props.schema, values.value, runtimeData.value, {}),
);
function validationErrors() {
  return [
    ...(!ignoreRowPermissions.value
      ? subformOperationErrors(
          props.schema.fields,
          permissionBaseline.value,
          resolved.value,
          permissionBaseline.value,
        )
      : []),
    ...validateValues(props.schema, resolved.value),
    ...validateDynamicValues(props.schema, resolved.value, runtimeData.value),
  ];
}
function applyValues(next: FormValues, generated = false) {
  const before = copy(resolved.value);
  const issue = [
    ...subformRowLimitErrors(props.schema.fields, next, before),
    ...subformRowIdentityErrors(props.schema.fields, next),
  ][0];
  if (issue) {
    changeError.value = issue.message;
    return false;
  }
  const identified = generated
    ? identifySubformRows(props.schema.fields, next)
    : identifySubformRows(props.schema.fields, next, () => uid("row"));
  const duplicate = subformRowIdentityErrors(
    props.schema.fields,
    identified,
  )[0];
  const operation =
    !generated &&
    !ignoreRowPermissions.value &&
    subformOperationErrors(
      props.schema.fields,
      before,
      identified,
      permissionBaseline.value,
    )[0];
  if (duplicate || operation) {
    changeError.value = (duplicate || operation)!.message;
    return false;
  }
  const nextBaseline = copy(permissionBaseline.value);
  if (generated) {
    for (const field of flattenFields(props.schema.fields).filter(
      (f) => f.type === "subform",
    )) {
      const raw = Array.isArray(next[field.id])
        ? (next[field.id] as FormValues[])
        : [];
      const rows = Array.isArray(identified[field.id])
        ? (identified[field.id] as FormValues[])
        : [];
      const prior = Array.isArray(nextBaseline[field.id])
        ? (nextBaseline[field.id] as FormValues[])
        : [];
      if (raw.length && raw.every((row) => row._rowId === undefined))
        nextBaseline[field.id] = copy(rows);
      else
        nextBaseline[field.id] = prior.map(
          (old, i) =>
            rows.find(
              (row, index) =>
                subformRowId(field.id, row, index) ===
                subformRowId(field.id, old, i),
            ) || old,
        );
      if (!raw.length && field.defaultLink?.enabled)
        nextBaseline[field.id] = [];
    }
  }
  changeError.value = "";
  const nextValues = resolveRuntimeValues(
    props.schema,
    identified,
    runtimeData.value,
    {},
  );
  permissionBaseline.value = nextBaseline;
  values.value = nextValues;
  changedValidationRules(props.schema, before, resolved.value).forEach((id) =>
    touchedRules.add(id),
  );
  if (submittedCheck || errors.value.length) errors.value = validationErrors();
  formIssues.value = checkFormRules(submittedCheck ? undefined : touchedRules);
  warningOpen.value = false;
  status.value = "";
  return true;
}
function change(
  id: string,
  value: unknown,
  source: FrontendFieldChange | FrontendFieldChange[] = { fieldId: id },
  acknowledge?: (error?: string) => void,
) {
  try {
    if (!ignoreRowPermissions.value) {
      const direct = { ...resolved.value, [id]: value };
      const issue = subformOperationErrors(
        props.schema.fields,
        resolved.value,
        direct,
        permissionBaseline.value,
      )[0];
      if (issue) {
        changeError.value = issue.message;
        acknowledge?.(issue.message);
        return;
      }
    }
    const next = applyFieldChange(
      props.schema.fields,
      resolved.value,
      id,
      value,
      runtimeData.value,
    );
    const accepted = triggerEvents(next, source);
    acknowledge?.(
      accepted ? undefined : changeError.value || "回填未完成，请核对表单提示",
    );
  } catch (error) {
    changeError.value = (error as Error).message;
    acknowledge?.(changeError.value);
  }
}
function activate(source: FrontendFieldChange) {
  if (selectionContext.value || ocrContext.value) return;
  const field = findField(props.schema.fields, source.fieldId);
  if (field?.type === "ocr" && field.ocr) {
    const projected = frontendValueFields(props.schema, true).find(
      (item) => item.id === field.id,
    );
    if (
      projected?.visible &&
      projected.editable &&
      isFieldVisibleInSchema(projected, props.schema, resolved.value) &&
      field.ocr.mappings.length
    )
      ocrContext.value = { fieldId: field.id };
    return;
  }
  if (field?.type === "lookup") {
    eventFailures.value = lookupIssues(field, props.schema, runtimeData.value);
    if (!eventFailures.value.length)
      selectionContext.value = {
        source: copy(source),
        field: copy(field),
        values: copy(resolved.value),
        events: [],
        index: 0,
        choices: {},
        fingerprint: selectionFingerprint(),
      };
    return;
  }
  const events = (props.schema.settings.frontendEvents || []).filter(
    (event) =>
      event.enabled &&
      event.trigger === "field" &&
      event.fieldIds.includes(source.fieldId) &&
      event.selection,
  );
  if (events.length) {
    const issues = events.flatMap((event) =>
      frontendEventIssues(event, props.schema, runtimeData.value).map(
        (issue) => `${event.name}：${issue.message}`,
      ),
    );
    eventFailures.value = issues;
    if (!issues.length)
      selectionContext.value = {
        source: copy(source),
        values: copy(resolved.value),
        events: copy(events),
        index: 0,
        choices: {},
        fingerprint: selectionFingerprint(),
      };
    return;
  }
  triggerEvents(resolved.value, source);
}
function selectLookup(ids: string[]) {
  const context = selectionContext.value;
  if (!context?.field) return;
  if (context.fingerprint !== selectionFingerprint()) {
    eventFailures.value = ["表单已变化，请重新选择；填写内容已保留。"];
    selectionContext.value = undefined;
    return;
  }
  try {
    const next = applyLookupSelection(
      context.field,
      props.schema,
      resolved.value,
      runtimeData.value,
      ids,
      context.source.row,
    );
    selectionContext.value = undefined;
    eventFailures.value = [];
    applyValues(next);
  } catch (e) {
    eventFailures.value = [(e as Error).message];
  }
}
function selectRecord(id: string) {
  const context = selectionContext.value;
  if (!context) return;
  if (context.fingerprint !== selectionFingerprint()) {
    eventFailures.value = ["表单已变化，请重新选择；填写内容已保留。"];
    selectionContext.value = undefined;
    return;
  }
  context.choices[context.events[context.index]!.id] = id;
  context.index++;
  if (context.index < context.events.length) return;
  const failures = context.events.flatMap((event) => {
    const run = runFrontendEvent(
      event,
      props.schema,
      context.values,
      runtimeData.value,
      context.source.row,
      false,
      context.choices[event.id],
    );
    return run.status === "success"
      ? []
      : [`${event.name}：${run.error?.message || "回填失败"}`];
  });
  selectionContext.value = undefined;
  if (failures.length) {
    eventFailures.value = failures;
    return;
  }
  const result = applyFrontendEvents(
    props.schema,
    context.values,
    runtimeData.value,
    "field",
    context.source,
    context.choices,
  );
  eventFailures.value = result.failures;
  applyValues(result.values);
}
function triggerEvents(
  next: FormValues,
  source: FrontendFieldChange | FrontendFieldChange[],
  generated = true,
) {
  const failures: string[] = [];
  for (const change of Array.isArray(source) ? source : [source]) {
    const result = applyFrontendEvents(
      props.schema,
      next,
      runtimeData.value,
      "field",
      change,
    );
    next = result.values;
    failures.push(...result.failures);
  }
  eventFailures.value = [...new Set(failures)];
  return applyValues(next, generated);
}
async function submit(ignoreWarnings = false) {
  if (selectionContext.value) {
    status.value = "请先完成或取消数据选择";
    return;
  }
  if (uploadingFiles.value) {
    status.value = "请等待文件上传完成";
    return;
  }
  if (props.schema.settings.allowSubmit === false) return;
  if (
    props.schema.settings.frontendEvents?.some(
      (event) => event.enabled && event.trigger === "submit",
    ) &&
    !(ignoreWarnings && warningFingerprint === validationFingerprint())
  ) {
    const events = applyFrontendEvents(
      props.schema,
      resolved.value,
      runtimeData.value,
      "submit",
    );
    eventFailures.value = events.failures;
    applyValues(events.values, true);
    if (eventFailures.value.length) return;
  }
  submittedCheck = true;
  errors.value = validationErrors();
  formIssues.value = checkFormRules();
  if (
    errors.value.length ||
    formIssues.value.some((issue) => issue.mode === "block")
  ) {
    warningOpen.value = false;
    status.value = errors.value.length
      ? `请检查 ${errors.value.length} 处填写内容`
      : "";
    if (errors.value.length) {
      validationAttempt.value++;
      await nextTick();
      const invalid = content.value?.querySelector<HTMLElement>(
        ".invalid, td:has(> .field-error)",
      );
      const controls =
        invalid?.querySelector(".runtime-field-content") || invalid;
      const input =
        controls?.querySelector<HTMLElement>('[contenteditable="true"]') ||
        controls?.querySelector<HTMLElement>(
          "input:not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly]), select:not(:disabled)",
        ) ||
        controls?.querySelector<HTMLElement>("button:not(:disabled)");
      input?.focus({ preventScroll: true });
      invalid?.scrollIntoView?.({ block: "center" });
    }
    return;
  }
  if (
    warningIssues.value.length &&
    !(ignoreWarnings && warningFingerprint === validationFingerprint())
  ) {
    warningFingerprint = validationFingerprint();
    warningOpen.value = true;
    return;
  }
  warningOpen.value = false;
  status.value = "校验通过，预览数据未提交";
}
function saveDraft() {
  if (selectionContext.value) {
    status.value = "请先完成或取消数据选择";
    return;
  }
  if (uploadingFiles.value) {
    status.value = "请等待文件上传完成";
    return;
  }
  if (!props.schema.settings.allowDraft) return;
  status.value = "已模拟保存草稿，预览内容未写入正式数据。";
}
watch(
  () => runtimeData.value.organization.currentUserId,
  () => {
    runtimeKey.value++;
    values.value = initialValues();
    permissionBaseline.value = subformFillingBaseline(
      props.schema.fields,
      runtimeData.value,
      values.value,
    );
    resetValidation();
    status.value = "";
  },
);
</script>
<template>
  <form
    class="form-runtime"
    :aria-busy="uploadingFiles"
    @submit.prevent="submit()"
  >
    <div ref="content" class="runtime-content">
      <p v-if="schema.settings.description" class="runtime-description">
        {{ schema.settings.description }}
      </p>
      <p
        v-if="
          schema.settings.frontendEvents?.some(
            (event) => event.enabled && event.request,
          )
        "
        class="field-hint"
      >
        前端事件使用已配置的模拟返回数据，未连接外部服务器。
      </p>
      <FormFields
        :key="runtimeKey"
        :fields="schema.fields"
        :schema="schema"
        :values="resolved"
        :errors="errors"
        :validation-attempt="validationAttempt"
        :existing-rows="permissionBaseline"
        :ignore-row-permissions="ignoreRowPermissions"
        :device="device"
        @change="change"
        @activate="activate"
      />
    </div>
    <footer class="runtime-footer">
      <ul v-if="eventFailures.length" class="field-error" role="alert">
        <li v-for="failure in eventFailures" :key="failure">{{ failure }}</li>
      </ul>
      <p v-if="changeError" class="field-error" role="alert">
        {{ changeError }}
      </p>
      <p
        v-if="status"
        role="status"
        :class="errors.length ? 'field-error' : 'runtime-success'"
      >
        {{ status }}
      </p>
      <ul v-if="formIssues.length" class="form-validation-issues" role="alert">
        <li
          v-for="issue in formIssues"
          :key="issue.ruleId"
          :class="
            issue.mode === 'block' ? 'field-error' : 'form-validation-warning'
          "
        >
          {{ issue.message }}
        </li>
      </ul>
      <div>
        <button
          v-if="schema.settings.allowSubmit !== false"
          class="button primary"
          type="submit"
          :disabled="uploadingFiles"
        >
          {{
            uploadingFiles
              ? "正在上传文件…"
              : schema.settings.submitLabel || "提交"
          }}</button
        ><button
          v-if="schema.settings.allowDraft"
          type="button"
          class="button"
          :disabled="uploadingFiles"
          @click="saveDraft"
        >
          {{ schema.settings.draftLabel || "保存草稿" }}
        </button>
      </div>
    </footer>
  </form>
  <FrontendSelectionDialog
    v-if="selectionContext"
    :open="true"
    :event="selectionContext.events[selectionContext.index]"
    :field="selectionContext.field"
    :schema="schema"
    :values="selectionContext.values"
    :row="selectionContext.source.row"
    @cancel="selectionContext = undefined"
    @select="selectRecord"
    @lookup="selectLookup"
  />
  <BaseDialog
    :open="warningOpen"
    title="提交提示"
    width="520px"
    @close="warningOpen = false"
  >
    <ul class="form-validation-confirm">
      <li v-for="issue in warningIssues" :key="issue.ruleId">
        {{ issue.message }}
      </li>
    </ul>
    <template #footer
      ><button type="button" class="button" @click="warningOpen = false">
        返回修改</button
      ><button type="button" class="button primary" @click="submit(true)">
        忽略并继续提交
      </button></template
    >
  </BaseDialog>
  <OcrRecognitionDialog
    v-if="ocrContext && ocrField"
    :key="ocrContext.fieldId"
    :field="ocrField"
    :schema="schema"
    :values="resolved"
    :context-key="selectionFingerprint()"
    :disabled="ocrDisabled"
    :apply="commitOcr"
    @close="ocrContext = undefined"
  />
</template>

<style scoped>
.form-validation-issues {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  font-size: 13px;
}
.form-validation-issues li + li {
  margin-top: 6px;
}
.form-validation-warning {
  color: #996518;
}
.form-validation-confirm {
  padding-left: 18px;
  margin: 0;
}
.form-validation-confirm li + li {
  margin-top: 10px;
}
</style>
