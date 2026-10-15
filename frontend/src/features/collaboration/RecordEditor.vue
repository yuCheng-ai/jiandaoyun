<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from "vue-router";
import RecordEditorSurface from "./RecordEditorSurface.vue";
import SubmissionReceipt from "../../components/shared/SubmissionReceipt.vue";
import type {
  FormField,
  FormValues,
  PublishedAccess,
  RecordDetail,
  RemovedRecordRow,
  CollectionStatus,
  FieldValidationIssue,
} from "@platform/contracts";
import {
  isDepartmentField,
  isOrganizationField,
  organizationIdentityLabel,
  fieldDefaultValue,
} from "@platform/contracts";
import {
  ruleFieldVisible,
  formValidationResults,
  changedValidationRules,
  displayPlainFieldValue,
  resolveCalculations,
  formulaValue,
} from "@platform/contracts";
import ServerFieldControl from "./ServerFieldControl.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import RecordRelations from "../data/RecordRelations.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { useNotices } from "../../stores/notices";
import { provideFileUploads } from "../../composables/useFileUploads";
import {
  canEditField,
  emptyServerRecord,
  recordChanges,
  recordRowChanges,
} from "../../domain/serverRecords";
import { accessGroupSelections } from "../../repositories/accessGroupState";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import {
  maxSubformRows,
  subformRowCountIssue,
  subformPermissions,
} from "@platform/contracts";
const { notify } = useNotices();
const router = useRouter();
const props = defineProps<{
  published: PublishedAccess;
  detail?: RecordDetail;
  embedded?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  saved: [record: RecordDetail];
  updated: [record: RecordDetail];
  continue: [];
}>();
const submission = ref<{
  message: string;
  canContinue: boolean;
  processId?: string;
}>();
function viewProcess(id: string) {
  if (working.value) return;
  void router.push({ name: "home", query: { tab: "started", process: id } });
}
const current = ref(props.detail);
const collection = ref<CollectionStatus | undefined>(
  props.detail?.collection || props.published.collection,
);
const collecting = computed(
  () => !current.value || current.value.record.state === "draft",
);
async function checkCollection() {
  if (busy.value) return;
  busy.value = true;
  try {
    collection.value = await platformApi<CollectionStatus>(
      `/definitions/${active.value.definition.id}/collection-status`,
    );
    error.value = "";
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
const active = computed(() => current.value || props.published);
const title = computed(() => {
  const formTitle = active.value.page?.title || active.value.definition.title;
  if (submission.value) return `提交结果 · ${formTitle}`;
  if (current.value?.task) return current.value.task.title;
  return `${current.value ? "记录详情" : "新增记录"} · ${formTitle}`;
});
const settings = computed(() => active.value.definition.schema.settings ?? {});
const canWrite = computed(() =>
  current.value ? active.value.access.edit : active.value.access.create,
);
// 提交设置只影响填写入口；已提交记录和任务仍按服务端返回的编辑权限保存。
const canSaveDraft = computed(
  () =>
    canWrite.value &&
    collecting.value &&
    !current.value?.task &&
    settings.value.allowDraft !== false,
);
const canSaveRecord = computed(() => {
  if (!canWrite.value) return false;
  if (current.value?.task || !collecting.value) return true;
  return settings.value.allowSubmit !== false;
});
const saveLabel = computed(() => {
  if (current.value?.task || !collecting.value) return "保存修改";
  const custom = settings.value.submitLabel?.trim();
  if (custom && custom !== "提交") return custom;
  return props.embedded ? custom || "提交" : "提交记录";
});
const values = ref<FormValues>(
  JSON.parse(
    JSON.stringify(
      props.detail?.record.values ?? emptyServerRecord(props.published),
    ),
  ),
);
let syncingDefaults = false;
function replaceValues(next: FormValues) {
  syncingDefaults = true;
  try {
    values.value = next;
  } finally {
    syncingDefaults = false;
  }
}
const initialValues = JSON.stringify(values.value);
const busy = ref(false),
  error = ref(""),
  conflict = ref(false),
  reloadPrompt = ref(false);
const { uploading, discardUploads } = provideFileUploads();
const working = computed(() => busy.value || uploading.value);
const {
  dirty,
  requestClose: requestDraftClose,
  confirmLeave,
  confirmDiscard,
  discard,
  markSaved,
} = useDraftDismiss(
  () => true,
  () => values.value,
  () => {
    void discardUploads();
    emit("close");
  },
);
function requestClose() {
  if (!working.value) requestDraftClose();
}
async function runAfterLeave(action: () => void | Promise<void>) {
  if (working.value) return;
  if (!(await confirmLeave()) || working.value) return;
  // 页内操作不会卸载填写区，放弃修改后要恢复已保存内容。
  if (dirty.value) {
    const savedValues = current.value
      ? JSON.stringify(current.value.record.values)
      : initialValues;
    replaceValues(JSON.parse(savedValues));
    removedRows.value = [];
    markSaved();
    void discardUploads();
  }
  await action();
}
defineExpose({ runAfterLeave, save, dirty, busy: working, showValidation });
const confirmRouteLeave = () => !working.value && confirmLeave();
onBeforeRouteLeave(confirmRouteLeave);
onBeforeRouteUpdate(confirmRouteLeave);
const newRow = (row: FormValues) =>
  !current.value || String(row._rowId).startsWith("draft:");
const editable = (field: FormField, parent?: FormField, row?: FormValues) =>
  canEditField(active.value.access, field, parent) &&
  (!parent ||
    !row ||
    newRow(row) ||
    active.value.rowActions?.[parent.id]?.editExisting !== false) &&
  (current.value ? active.value.access.edit : active.value.access.create);
const rows = (id: string) => (values.value[id] || []) as FormValues[];
const visible = (field: FormField, row?: FormValues) =>
  ruleFieldVisible(field, active.value.definition.schema, {
    ...values.value,
    ...row,
  });
watch(
  () => JSON.stringify(values.value),
  (after, before) => {
    if (syncingDefaults || current.value?.task) return;
    const schema = active.value.definition.schema;
    const formulas = schema.fields
      .flatMap((field) => [field, ...field.children])
      .filter((field) => field.defaultFormula);
    if (!formulas.length) return;
    const resolved = resolveCalculations(
      schema.fields,
      JSON.parse(after),
      {},
      {
        defaults: formulas.map((field) => field.id),
        before: JSON.parse(before),
        enabled: (field, context) => {
          const parent = schema.fields.find((item) =>
            item.children.some((child) => child.id === field.id),
          );
          return (
            !current.value ||
            (parent && newRow(context)) ||
            editable(field, parent, parent ? context : undefined)
          );
        },
      },
    );
    if (JSON.stringify(resolved) !== after) replaceValues(resolved);
  },
  { flush: "sync" },
);
const defaultIssues = computed(() => {
  const schema = active.value.definition.schema,
    issues: FieldValidationIssue[] = [];
  for (const field of schema.fields) {
    const check = (item: FormField, data: FormValues, parent?: FormField) => {
      if (
        item.defaultFormula &&
        (data[item.id] == null || data[item.id] === "") &&
        editable(item, parent, parent ? data : undefined) &&
        formulaValue(item, schema.fields, { ...values.value, ...data }).error
      )
        issues.push({
          fieldId: item.id,
          subformId: parent?.id,
          rowId: parent ? String(data._rowId) : undefined,
          message: "默认值未计算完成，请检查相关填写内容。",
        });
    };
    if (field.type === "subform")
      rows(field.id).forEach((row) =>
        field.children.forEach((child) => check(child, row, field)),
      );
    else check(field, values.value);
  }
  return issues;
});
const canAddRow = (field: FormField) =>
  current.value
    ? active.value.rowActions?.[field.id]?.add
    : editable(field) &&
      (active.value.rowActions
        ? active.value.rowActions[field.id]?.add
        : subformPermissions(field.subformPermissions).add);
const canInsertRow = (field: FormField) =>
  current.value
    ? active.value.rowActions?.[field.id]?.insert
    : editable(field) &&
      (active.value.rowActions
        ? active.value.rowActions[field.id]?.insert
        : subformPermissions(field.subformPermissions).insert);
const canRemoveRow = (field: FormField, row?: FormValues) =>
  editable(field) &&
  (row
    ? newRow(row) || active.value.rowActions?.[field.id]?.remove
    : !current.value ||
      active.value.rowActions?.[field.id]?.remove ||
      rows(field.id).some(newRow));
const removing = ref<{ field: FormField; index: number }>();
const removedRows = ref<
  { fieldId: string; index: number; value: FormValues }[]
>([]);
const historyField = ref<FormField>(),
  deletedRows = ref<RemovedRecordRow[]>([]),
  historyError = ref("");
const hasChanges = computed(
  () =>
    !!current.value &&
    JSON.stringify(current.value.record.values) !==
      JSON.stringify(values.value),
);
const currentPath = () =>
  current.value?.task
    ? `/processes/${current.value.task.processId}/tasks/${current.value.task.taskId}/record`
    : active.value.page
      ? `/pages/${active.value.page.id}/records/${current.value!.record.id}`
      : `/records/${current.value!.record.id}`;
async function openDeleted(field: FormField) {
  if (!current.value || hasChanges.value || busy.value) return;
  historyField.value = field;
  deletedRows.value = [];
  historyError.value = "";
  busy.value = true;
  try {
    deletedRows.value = await platformApi<RemovedRecordRow[]>(
      `${currentPath()}/removed-rows${active.value.page ? `?version=${active.value.page.version}` : ""}`,
    );
  } catch (cause) {
    historyError.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function restoreRow(row: RemovedRecordRow) {
  if (!current.value || !row.restorable || busy.value) return;
  const field = active.value.definition.schema.fields.find(
    (field) => field.id === row.subformId,
  );
  const issue = subformRowCountIssue(
    field || { label: "明细" },
    rows(row.subformId).length + 1,
  );
  if (issue) {
    historyError.value = issue;
    return;
  }
  busy.value = true;
  historyError.value = "";
  const payload = {
    rows: [
      {
        action: "restore",
        subformId: row.subformId,
        rowId: row.rowId,
        eventId: row.eventId,
        expectedRevision:
          current.value.record.rowRevisions?.[row.subformId] || 1,
      },
    ],
    changes: [],
  };
  const fingerprint = writeFingerprint(payload);
  if (pendingPayload !== fingerprint) {
    pendingPayload = fingerprint;
    pendingKey = crypto.randomUUID();
  }
  try {
    const result = await platformApi<RecordDetail>(currentPath(), "PATCH", {
      ...payload,
      requestId: pendingKey,
      ...(active.value.page ? { pageVersion: active.value.page.version } : {}),
    });
    current.value = result;
    replaceValues(JSON.parse(JSON.stringify(result.record.values)));
    removedRows.value = [];
    markSaved();
    historyField.value = undefined;
    notify("明细已恢复");
    error.value = "";
  } catch (cause) {
    historyError.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
function removeRow(field: FormField, index: number) {
  const value = rows(field.id)[index]!;
  if (current.value && !String(value._rowId).startsWith("draft:"))
    removedRows.value.push({ fieldId: field.id, index, value });
  rows(field.id).splice(index, 1);
  removing.value = undefined;
}
function undoRemove() {
  const last = removedRows.value.at(-1);
  if (!last) return;
  const field = active.value.definition.schema.fields.find(
    (field) => field.id === last.fieldId,
  );
  const issue = subformRowCountIssue(
    field || { label: "明细" },
    rows(last.fieldId).length + 1,
  );
  if (issue) {
    error.value = issue;
    return;
  }
  removedRows.value.pop();
  rows(last.fieldId).splice(last.index, 0, last.value);
}

function addRow(field: FormField, insertIndex?: number) {
  if (
    rows(field.id).length >= maxSubformRows ||
    (insertIndex === undefined ? !canAddRow(field) : !canInsertRow(field))
  )
    return;
  const now = new Date();
  const value = {
    _rowId: `draft:${crypto.randomUUID()}`,
    ...Object.fromEntries(
      field.children.map((c) => [
        c.id,
        isOrganizationField(c.type) ? undefined : fieldDefaultValue(c, now),
      ]),
    ),
  };
  const next = [...rows(field.id)];
  const initialized = resolveCalculations(field.children, value, values.value, {
    fields: active.value.definition.schema.fields,
    defaults: field.children
      .filter((child) => child.defaultFormula)
      .map((child) => child.id),
  });
  next.splice(insertIndex ?? next.length, 0, initialized);
  values.value[field.id] = next;
}
function organizationRequest(
  field: FormField,
  parent?: FormField,
  row?: FormValues,
) {
  if (!isOrganizationField(field.type)) return undefined;
  const context = Object.fromEntries(
    [
      ...active.value.definition.schema.fields
        .filter((item) => isDepartmentField(item.type) && editable(item))
        .map((item) => [item.id, values.value[item.id]]),
      ...(parent?.children
        .filter(
          (item) => isDepartmentField(item.type) && editable(item, parent, row),
        )
        .map((item) => [item.id, row?.[item.id]]) || []),
    ].filter(([, value]) => value !== undefined),
  );
  const task = current.value?.task;
  const path = task
    ? `/processes/${task.processId}/tasks/${task.taskId}/organization-options`
    : active.value.page
      ? `/pages/${active.value.page.id}/organization-options`
      : `/definitions/${active.value.definition.id}/organization-options`;
  return {
    path,
    body: {
      fieldId: field.id,
      version: active.value.definition.version,
      ...(active.value.page ? { pageVersion: active.value.page.version } : {}),
      ...(current.value ? { recordId: current.value.record.id } : {}),
      ...(parent ? { subformId: parent.id } : {}),
      ...(row?._rowId && !String(row._rowId).startsWith("draft:")
        ? { rowId: row._rowId }
        : {}),
      context,
    },
  };
}
let pendingKey = "",
  pendingPayload = "";
function writeFingerprint(payload: unknown, mode = "restore") {
  return JSON.stringify({
    payload,
    mode,
    definitionId: active.value.definition.id,
    recordId: current.value?.record.id,
    page: active.value.page,
    task: current.value?.task?.taskId,
    selection: accessGroupSelections.value[active.value.definition.id],
  });
}
const checkedSubmission = ref(false),
  touchedRules = ref<string[]>([]);
const warning = ref<{ mode: "active" | "submit"; fingerprint: string }>();
function checkRules(ruleIds?: ReadonlySet<string>) {
  return current.value?.task
    ? []
    : formValidationResults(active.value.definition.schema, values.value, {
        ruleIds,
        display: displayPlainFieldValue,
      });
}
const formIssues = computed(() =>
  checkRules(checkedSubmission.value ? undefined : new Set(touchedRules.value)),
);
const warningIssues = computed(() =>
  formIssues.value.filter((issue) => issue.mode === "warn"),
);
const formBody = ref<HTMLElement>();
const serverIssues = ref<
  { issue: FieldValidationIssue; value: string | undefined }[]
>([]);

function issueValue(issue: FieldValidationIssue) {
  if (!issue.subformId) return JSON.stringify(values.value[issue.fieldId]);
  const detailRows = rows(issue.subformId);
  if (issue.rowId) {
    const row = detailRows.find((item) => item._rowId === issue.rowId);
    return JSON.stringify(row?.[issue.fieldId]);
  }
  return JSON.stringify(detailRows.map((row) => row[issue.fieldId]));
}

function issueVisible(issue: FieldValidationIssue) {
  const parent = active.value.definition.schema.fields.find(
    (field) => field.id === (issue.subformId || issue.fieldId),
  );
  if (!parent || !visible(parent)) return false;
  if (!issue.subformId) return true;
  const field = parent.children.find((child) => child.id === issue.fieldId);
  if (!field) return false;
  if (!issue.rowId) return true;
  const row = rows(parent.id).find((item) => item._rowId === issue.rowId);
  return !!row && visible(field, row);
}

async function focusFirstError() {
  await nextTick();
  const target =
    formBody.value?.querySelector<HTMLElement>(
      '[data-validation-target][aria-invalid="true"]',
    ) ||
    formBody.value?.querySelector<HTMLElement>("[data-validation-summary]");
  if (!target) return;
  target.scrollIntoView({ block: "center", inline: "nearest" });
  const input = target.querySelector<HTMLElement>(
    'input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], button:not(:disabled)',
  );
  (input || target).focus({ preventScroll: true });
}

function showValidation(cause: unknown) {
  if (!(cause instanceof PlatformError) || !cause.issues.length) return false;
  const issues: FieldValidationIssue[] = [];
  for (const item of cause.issues) {
    const issue = { ...item };
    if (issue.subformId) {
      const detailRows = rows(issue.subformId);
      const existingRow = detailRows.find((row) => row._rowId === issue.rowId);
      // 新行尚未获得服务端行 ID，接收时绑定当前行，插入或删除后提示不会串行。
      if (!existingRow && issue.rowIndex !== undefined) {
        const row = detailRows[issue.rowIndex];
        if (!row || !newRow(row)) continue;
        issue.rowId = String(row._rowId);
      }
    }
    if (issueVisible(issue)) issues.push(issue);
  }
  if (!issues.length) return false;
  error.value = "";
  serverIssues.value = issues.map((issue) => ({
    issue,
    value: issueValue(issue),
  }));
  void focusFirstError();
  return true;
}

// 仅清除被修改字段的服务端错误，其他字段与其他明细行继续保留提示。
watch(
  values,
  () => {
    serverIssues.value = serverIssues.value.filter(
      ({ issue, value }) => issueVisible(issue) && issueValue(issue) === value,
    );
  },
  { deep: true },
);

function ruleTargets(ids: string[] = []) {
  const fields = active.value.definition.schema.fields;
  const targets = new Set<string>();
  for (const id of ids) {
    const field = fields.find(
      (item) =>
        item.id === id || item.children.some((child) => child.id === id),
    );
    if (field && visible(field)) targets.add(field.id);
  }
  return [...targets];
}
const globalFormIssues = computed(() =>
  formIssues.value.filter((issue) => !ruleTargets(issue.fieldIds).length),
);
function fieldMessage(
  field: FormField,
  parent?: FormField,
  row?: FormValues,
  mode: "block" | "warn" = "block",
) {
  const matching = (issue: FieldValidationIssue) => {
    if (parent) {
      return (
        issue.subformId === parent.id &&
        issue.fieldId === field.id &&
        issue.rowId === row?._rowId
      );
    }
    return (
      (!issue.subformId && issue.fieldId === field.id) ||
      (issue.subformId === field.id && !issue.rowId)
    );
  };
  const fieldIssues =
    mode === "block"
      ? serverIssues.value.map(({ issue }) => issue)
      : defaultIssues.value;
  const messages = fieldIssues.filter(matching).map((issue) => issue.message);
  // 聚合规则不能定位到某一行，放在相关子表旁，不把整列标成错误。
  if (!parent) {
    for (const issue of formIssues.value) {
      if (
        issue.mode === mode &&
        ruleTargets(issue.fieldIds).includes(field.id)
      ) {
        messages.push(issue.message);
      }
    }
  }
  return [...new Set(messages)].join("；");
}
watch(
  () => JSON.stringify(values.value),
  (after, before) => {
    const changed = changedValidationRules(
      active.value.definition.schema,
      JSON.parse(before),
      JSON.parse(after),
    );
    touchedRules.value = [...new Set([...touchedRules.value, ...changed])];
  },
);
function validationFingerprint(mode: string) {
  return writeFingerprint(
    {
      values: values.value,
      rules: active.value.definition.schema.settings.validations,
    },
    mode,
  );
}
function continueWarning() {
  const pending = warning.value;
  if (pending) void save(pending.mode, pending.fingerprint);
}
async function save(
  mode: "active" | "draft" | "submit" = "active",
  ignoredFingerprint?: string,
): Promise<boolean> {
  if (working.value || submission.value) return false;
  if (mode === "draft" ? !canSaveDraft.value : !canSaveRecord.value)
    return false;
  const validate =
    mode !== "draft" &&
    (mode === "submit" || current.value?.record.state !== "draft") &&
    !current.value?.task;
  if (validate) {
    checkedSubmission.value = true;
    const issues = checkRules();
    const blocked = issues.find((issue) => issue.mode === "block");
    if (blocked) {
      error.value = "";
      warning.value = undefined;
      void focusFirstError();
      return false;
    }
    const fingerprint = validationFingerprint(mode);
    if (
      issues.some((issue) => issue.mode === "warn") &&
      ignoredFingerprint !== fingerprint
    ) {
      warning.value = { mode: mode as "active" | "submit", fingerprint };
      return false;
    }
  }
  warning.value = undefined;
  const submitting = mode === "submit";
  busy.value = true;
  error.value = "";
  conflict.value = false;
  try {
    const payload = current.value
      ? {
          changes: recordChanges(current.value, values.value),
          rows: recordRowChanges(current.value, values.value),
          ...(submitting
            ? { expectedRevision: current.value.record.revision }
            : {}),
        }
      : {
          version: active.value.definition.version,
          values: Object.fromEntries(
            active.value.definition.schema.fields
              .filter((field) => editable(field))
              .map((field) => [
                field.id,
                field.type === "subform"
                  ? rows(field.id).map((row) =>
                      Object.fromEntries(
                        field.children
                          .filter((child) => editable(child, field))
                          .map((child) => [child.id, row[child.id]]),
                      ),
                    )
                  : values.value[field.id],
              ]),
          ),
          ...(mode === "draft" ? { state: "draft" } : {}),
        };
    if (
      !submitting &&
      "changes" in payload &&
      payload.changes &&
      !payload.changes.length &&
      !payload.rows?.length
    ) {
      emit("close");
      return true;
    }
    const fingerprint = writeFingerprint(payload, mode);
    if (fingerprint !== pendingPayload) {
      pendingKey = crypto.randomUUID();
      pendingPayload = fingerprint;
    }
    // 无查看权限时服务端只返回收据，成功提示应沿用本次提交的已发布配置。
    const settings = active.value.definition.schema.settings;
    const receipt = {
      message: settings.successMessage,
      canContinue: settings.allowAnotherSubmission,
    };
    const result = await platformApi<RecordDetail>(
      current.value
        ? `${currentPath()}${submitting ? "/submit" : ""}`
        : active.value.page
          ? `/pages/${active.value.page.id}/records`
          : `/definitions/${active.value.definition.id}/records`,
      current.value && !submitting ? "PATCH" : "POST",
      {
        ...payload,
        requestId: pendingKey,
        ...(active.value.page
          ? { pageVersion: active.value.page.version }
          : {}),
      },
    );
    await discardUploads();
    if (submitting) {
      // 草稿正式提交后同样展示已发布的提交回执，不因是否配置流程而改变体验。
      current.value = result;
      replaceValues(JSON.parse(JSON.stringify(result.record.values)));
      removedRows.value = [];
    }
    serverIssues.value = [];
    markSaved();
    if ((props.embedded && !current.value && mode !== "draft") || submitting) {
      submission.value = { ...receipt, processId: result.processId };
    }
    emit("saved", result);
    return true;
  } catch (cause) {
    if (showValidation(cause)) return false;
    if (
      cause instanceof PlatformError &&
      (cause.status === 0 || cause.status >= 500)
    ) {
      notify(cause.message, "error");
      return false;
    }
    error.value = (cause as Error).message;
    void focusFirstError();
    if (cause instanceof PlatformError && cause.collection)
      collection.value = cause.collection;
    conflict.value =
      cause instanceof PlatformError &&
      cause.status === 409 &&
      !cause.collection;
    return false;
  } finally {
    busy.value = false;
  }
}
async function reload() {
  if (!current.value) return;
  busy.value = true;
  try {
    const fresh = await platformApi<RecordDetail>(
      `${currentPath()}${active.value.page && !current.value.task ? `?version=${active.value.page.version}` : ""}`,
    );
    await discardUploads();
    current.value = fresh;
    replaceValues(JSON.parse(JSON.stringify(fresh.record.values)));
    removedRows.value = [];
    markSaved();
    serverIssues.value = [];
    checkedSubmission.value = false;
    touchedRules.value = [];
    warning.value = undefined;
    reloadPrompt.value = false;
    error.value = "";
    conflict.value = false;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
function relationUpdated(result: RecordDetail) {
  void discardUploads();
  current.value = result;
  replaceValues(JSON.parse(JSON.stringify(result.record.values)));
  removedRows.value = [];
  error.value = "";
  serverIssues.value = [];
  conflict.value = false;
  markSaved();
  // 回填可能完成数据交接；失去查看权限时沿用普通保存的关闭和列表刷新。
  if (result.accessLost) emit("saved", result);
  else emit("updated", result);
}
</script>
<template>
  <RecordEditorSurface
    :embedded="embedded"
    :title="title"
    :busy="working"
    @close="requestClose"
  >
    <SubmissionReceipt
      v-if="submission"
      :message="submission.message"
      :can-continue="submission.canContinue"
      :process-id="submission.processId"
      @continue="emit('continue')"
      @view-process="viewProcess"
    />
    <div v-else ref="formBody">
      <p v-if="current?.task?.rowId" class="collab-notice">
        本次仅处理指定明细行。
      </p>
      <p
        v-if="
          !embedded &&
          current?.processId &&
          !current.task &&
          !current.access.edit
        "
        class="collab-notice"
      >
        此记录已进入流程。
        <button class="text-button" @click="viewProcess(current.processId)">
          查看申请
        </button>
      </p>
      <p v-if="active.access.create && !active.access.read" class="collab-help">
        <template v-if="canSaveDraft">可以保存自己的草稿，</template>
        提交后由有查看权限的成员处理。
      </p>
      <p v-if="current?.record.state === 'draft'" class="collab-notice">
        草稿尚未提交，可以继续填写。
      </p>
      <p
        v-if="collecting && collection && !collection.accepting"
        class="collab-notice"
        role="status"
      >
        {{ collection.reason }}。
        <template v-if="canSaveDraft">可以先保存草稿，</template>
        开放收集后再提交。<button
          class="text-button"
          :disabled="busy"
          @click="checkCollection"
        >
          重新检查收集状态
        </button>
      </p>
      <p v-if="current?.creator" class="collab-help">
        创建人：{{ organizationIdentityLabel(current.creator) }}
      </p>
      <div
        v-if="error"
        class="collab-error"
        role="alert"
        data-validation-summary
        tabindex="-1"
      >
        {{ error
        }}<button
          v-if="conflict"
          class="text-button"
          @click="reloadPrompt = true"
        >
          重新读取
        </button>
      </div>
      <p
        v-for="issue in globalFormIssues"
        :key="issue.ruleId"
        :data-validation-summary="issue.mode === 'block' ? '' : undefined"
        tabindex="-1"
        :class="issue.mode === 'block' ? 'collab-error' : 'collab-notice'"
        :role="issue.mode === 'block' ? 'alert' : 'status'"
      >
        {{ issue.message }}
      </p>
      <div v-if="removedRows.length" class="collab-notice" role="status">
        待删除
        {{ removedRows.length }} 行，保存时统一检查引用和其他成员的修改。<button
          class="text-button"
          @click="undoRemove"
        >
          撤销上一次删除
        </button>
      </div>
      <div v-if="reloadPrompt" class="collab-notice">
        重新读取会放弃当前输入。<button
          class="button"
          @click="reloadPrompt = false"
        >
          保留输入</button
        ><button class="button" @click="reload">放弃修改并读取最新记录</button>
      </div>
      <div
        v-if="confirmDiscard"
        class="config-discard collab-notice"
        tabindex="-1"
      >
        有尚未保存的修改。<button
          class="button"
          @click="confirmDiscard = false"
        >
          继续编辑</button
        ><button class="button" @click="discard">放弃修改</button>
      </div>
      <div class="collab-fields">
        <div
          v-for="field in active.definition.schema.fields"
          :key="field.id"
          class="collab-field"
          v-show="visible(field)"
        >
          <template v-if="field.type !== 'subform'">
            <label :for="`value-${field.id}`"
              >{{ field.label
              }}<span v-if="field.required" class="required"> *</span
              ><small v-if="canWrite && !editable(field)"> 只读</small></label
            >
            <ServerFieldControl
              data-validation-target
              :error="fieldMessage(field)"
              :warning="fieldMessage(field, undefined, undefined, 'warn')"
              :values="values"
              :field="field"
              :organization-request="organizationRequest(field)"
              :identities="active.identities"
              v-model="values[field.id]"
              :input-id="`value-${field.id}`"
              :label="field.label"
              :disabled="!editable(field)"
            />
          </template>
          <template v-else>
            <div class="collab-toolbar">
              <strong>{{ field.label }}</strong
              ><button
                v-if="current && !current.task && canRemoveRow(field)"
                class="text-button"
                :disabled="hasChanges"
                :title="hasChanges ? '保存当前修改后可恢复已删除明细' : ''"
                @click="openDeleted(field)"
              >
                已删除明细</button
              ><button
                v-if="canAddRow(field)"
                class="button"
                :disabled="rows(field.id).length >= maxSubformRows"
                @click="addRow(field)"
              >
                添加明细
              </button>
            </div>
            <p
              v-if="
                fieldMessage(field) ||
                fieldMessage(field, undefined, undefined, 'warn')
              "
              data-validation-target
              :aria-invalid="!!fieldMessage(field) || undefined"
              tabindex="-1"
              class="record-field-feedback"
              :class="{ warning: !fieldMessage(field) }"
              :role="fieldMessage(field) ? 'alert' : 'status'"
            >
              {{
                fieldMessage(field) ||
                fieldMessage(field, undefined, undefined, "warn")
              }}
            </p>
            <div class="collab-table-wrap">
              <table class="collab-table">
                <thead>
                  <tr>
                    <th>序号</th>
                    <th v-for="child in field.children" :key="child.id">
                      {{ child.label
                      }}<small v-if="canWrite && !editable(child, field)">
                        · 只读</small
                      >
                    </th>
                    <th v-if="canRemoveRow(field) || canInsertRow(field)">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, index) in rows(field.id)"
                    :key="String(row._rowId || index)"
                  >
                    <td>{{ index + 1 }}</td>
                    <td v-for="child in field.children" :key="child.id">
                      <ServerFieldControl
                        v-if="visible(child, row)"
                        data-validation-target
                        :error="fieldMessage(child, field, row)"
                        :warning="fieldMessage(child, field, row, 'warn')"
                        :values="{ ...values, ...row }"
                        :field="child"
                        :organization-request="
                          organizationRequest(child, field, row)
                        "
                        :identities="active.identities"
                        v-model="row[child.id]"
                        :input-id="`value-${field.id}-${row._rowId || index}-${child.id}`"
                        :label="`${child.label}，第 ${index + 1} 行`"
                        :disabled="!editable(child, field, row)"
                      />
                    </td>
                    <td v-if="canRemoveRow(field) || canInsertRow(field)">
                      <button
                        v-if="canInsertRow(field)"
                        class="text-button"
                        :aria-label="`在${field.label}第 ${index + 1} 行前插入`"
                        :disabled="rows(field.id).length >= maxSubformRows"
                        @click="addRow(field, index)"
                      >
                        插入
                      </button>
                      <button
                        v-if="canRemoveRow(field, row)"
                        class="text-button"
                        :aria-label="`删除${field.label}第 ${index + 1} 行`"
                        @click="
                          current && !String(row._rowId).startsWith('draft:')
                            ? (removing = { field, index })
                            : removeRow(field, index)
                        "
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!rows(field.id).length" class="collab-help">暂无明细</p>
            <button
              v-if="canInsertRow(field) && !canAddRow(field)"
              class="text-button"
              :disabled="rows(field.id).length >= maxSubformRows"
              @click="addRow(field, rows(field.id).length)"
            >
              在末尾插入
            </button>
          </template>
        </div>
      </div>
      <RecordRelations
        v-if="current && !current.task && current.record.state !== 'draft'"
        :detail="current"
        :unsaved="hasChanges"
        @updated="relationUpdated"
        @busy="busy = $event"
      />
    </div>
    <template v-if="!submission" #footer>
      <button v-if="!embedded" class="button" @click="requestClose">关闭</button
      ><button
        v-if="canSaveDraft"
        class="button"
        :disabled="busy || uploading"
        @click="save('draft')"
      >
        {{ settings.draftLabel?.trim() || "保存草稿" }}</button
      ><button
        v-if="canSaveRecord"
        class="button"
        :class="{ primary: !$slots['footer-actions'] }"
        :disabled="busy || uploading"
        @click="save(current?.record.state === 'draft' ? 'submit' : 'active')"
      >
        {{ saveLabel }}
      </button>
      <slot name="footer-actions" />
    </template>
  </RecordEditorSurface>
  <BaseDialog
    :open="!!warning"
    title="提交前请确认"
    width="480px"
    @close="warning = undefined"
  >
    <ul>
      <li v-for="issue in warningIssues" :key="issue.ruleId">
        {{ issue.message }}
      </li>
    </ul>
    <template #footer
      ><button class="button" @click="warning = undefined">返回修改</button
      ><button class="button primary" @click="continueWarning">
        忽略并继续提交
      </button></template
    >
  </BaseDialog>
  <BaseDialog
    :open="!!removing"
    title="移除明细行"
    @close="removing = undefined"
    ><p>
      将移除「{{ removing?.field.label }}」第
      {{ (removing?.index || 0) + 1 }}
      行。保存前可以撤销，保存后可从“已删除明细”恢复；保存时会检查关系、任务引用及并发修改。
    </p>
    <template #footer
      ><button class="button" @click="removing = undefined">保留明细</button
      ><button
        class="button danger"
        @click="removing && removeRow(removing.field, removing.index)"
      >
        标记删除
      </button></template
    ></BaseDialog
  >
  <BaseDialog
    :open="!!historyField"
    :title="`已删除明细 · ${historyField?.label || ''}`"
    width="780px"
    :busy="busy"
    @close="historyField = undefined"
  >
    <p class="collab-help">
      恢复会立即保存，保留原来的行身份。数据结构和当前权限必须允许恢复。
    </p>
    <p v-if="historyError" class="collab-error" role="alert">
      {{ historyError }}
      <button
        class="text-button"
        @click="
          async () => {
            const field = historyField;
            await reload();
            if (field) await openDeleted(field);
          }
        "
      >
        读取最新记录后检查
      </button>
    </p>
    <div class="collab-table-wrap">
      <table v-if="historyField" class="collab-table">
        <thead>
          <tr>
            <th>删除时间</th>
            <th v-for="child in historyField.children" :key="child.id">
              {{ child.label }}
            </th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in deletedRows.filter(
              (row) => row.subformId === historyField?.id,
            )"
            :key="`${row.eventId}-${row.rowId}`"
          >
            <td>{{ new Date(row.removedAt).toLocaleString("zh-CN") }}</td>
            <td v-for="child in historyField.children" :key="child.id">
              {{ row.values[child.id] }}
            </td>
            <td>
              <button
                class="text-button"
                :disabled="!row.restorable"
                @click="restoreRow(row)"
              >
                恢复此行</button
              ><small v-if="row.reason">{{ row.reason }}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-if="
        !busy && !deletedRows.some((row) => row.subformId === historyField?.id)
      "
      class="collab-help"
    >
      没有可查看的已删除明细。
    </p>
    <template #footer
      ><button class="button" @click="historyField = undefined">
        关闭
      </button></template
    >
  </BaseDialog>
</template>

<style scoped>
.record-field-feedback {
  margin: 0;
  color: #c13c36;
  font-size: 12px;
  line-height: 1.6;
  outline: none;
}
.record-field-feedback.warning {
  color: #a26b16;
}
</style>
