import { frontendValueFields as frontendEventFields } from "./frontendEventValues";
export { frontendValueFields as frontendEventFields } from "./frontendEventValues";
import {
  frontendEventSettingsErrors,
  type FrontendEvent,
  type FrontendFieldChange,
} from "@platform/contracts";
import {
  copy,
  uid,
  isFieldVisibleInSchema,
  findField,
  type FormSchema,
  type FormValues,
} from "./form";
import { applyFieldChange } from "./relations";
import {
  bindingReferences,
  runPlugin,
  validateInvocation,
  type ConfigIssue,
  type ExtensionRun,
} from "./extensions";
import {
  newFrontendRequest,
  requestBindings,
  requestIssues,
  runFrontendRequest,
} from "./frontendRequests";
import type { WorkspaceData } from "./workspace";
import {
  selectionIssues,
  selectionLocalReferences,
  runFrontendSelection,
  selectionSourceFields,
} from "./frontendSelections";

const triggerTypes = new Set([
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "location",
  "image",
  "file",
  "signature",
  "member",
  "members",
  "department",
  "departments",
  "button",
]);
export function newFrontendEvent(): FrontendEvent {
  return {
    id: uid("event"),
    name: "",
    description: "",
    enabled: true,
    trigger: "field",
    fieldIds: [],
    request: newFrontendRequest(),
  };
}
export function frontendTriggerFields(schema: FormSchema) {
  return frontendEventFields(schema, true).filter((field) =>
    triggerTypes.has(field.type),
  );
}
export function frontendEventScope(
  schema: FormSchema,
  event: FrontendEvent,
): FormSchema {
  const fields = frontendEventFields(schema);
  const parent =
    event.trigger === "field"
      ? frontendTriggerFields(schema).find(
          (field) => field.id === event.fieldIds[0],
        )?.parentId || ""
      : "";
  return {
    ...schema,
    fields: fields
      .filter((field) => !field.parentId || field.parentId === parent)
      .map((field) => ({ ...field, label: field.pathLabel })),
  };
}
export function frontendEventReferences(event: FrontendEvent): string[] {
  return [
    ...event.fieldIds,
    ...(event.selection ? selectionLocalReferences(event.selection) : []),
    ...(event.request
      ? requestBindings(event.request, true)
      : Object.values(event.plugin?.inputs || {})
    ).flatMap(bindingReferences),
    ...frontendEventOutputIds(event),
  ];
}
export function frontendEventOutputIds(event: FrontendEvent) {
  if (event.selection)
    return event.selection.mappings.map((mapping) => mapping.targetFieldId);
  return (event.request?.outputs || event.plugin!.outputs).map(
    (mapping) => mapping.fieldId,
  );
}
export function frontendEventOutputFields(
  schema: FormSchema,
  event: FrontendEvent,
) {
  const fields = frontendEventFields(schema),
    parent =
      frontendTriggerFields(schema).find(
        (field) => field.id === event.fieldIds[0],
      )?.parentId || "";
  return event.request || event.selection
    ? fields
        .filter((field) => !parent || field.parentId === parent)
        .map((field) => ({ ...field, label: field.pathLabel }))
    : frontendEventScope(schema, event).fields;
}
export function frontendEventIssues(
  event: FrontendEvent,
  schema: FormSchema,
  data?: WorkspaceData,
): ConfigIssue[] {
  const invalid = frontendEventSettingsErrors({
    ...schema.settings,
    frontendEvents: [event],
  });
  if (invalid.length)
    return invalid.map((message) => ({ step: 0, target: "name", message }));
  const fields = frontendTriggerFields(schema);
  const triggers = event.fieldIds.map((id) =>
    fields.find((field) => field.id === id),
  );
  const issues: ConfigIssue[] = [];
  if (
    event.trigger === "field" &&
    (!triggers.length || triggers.some((field) => !field))
  )
    issues.push({
      step: 1,
      target: "trigger",
      message: "请选择有效的触发字段",
    });
  if (
    new Set(triggers.filter(Boolean).map((field) => field!.parentId)).size > 1
  )
    issues.push({
      step: 1,
      target: "trigger",
      message: "触发字段应属于主表或同一个子表单",
    });
  const parent = triggers[0]?.parentId || "";
  if (
    event.selection &&
    parent &&
    data &&
    event.selection.mappings.some((mapping) =>
      selectionSourceFields(data, event.selection!.formId).some(
        (field) => field.id === mapping.sourceFieldId && field.parentId,
      ),
    )
  )
    issues.push({
      step: 1,
      target: "selection-mappings",
      message: "当前明细行请选择来源主表字段",
    });
  if (
    event.selection &&
    (event.trigger !== "field" ||
      triggers.length !== 1 ||
      triggers[0]?.type !== "button")
  )
    issues.push({
      step: 1,
      target: "trigger",
      message: "选择数据填充需要由一个按钮触发",
    });
  if (
    parent &&
    frontendEventOutputIds(event).some(
      (id) =>
        !frontendEventFields(schema).some(
          (field) => field.id === id && field.parentId === parent,
        ),
    )
  )
    issues.push({
      step: 1,
      target: "output-mapping",
      message: "子表字段触发时，请回填同一子表单的字段",
    });
  return [
    ...issues,
    ...(event.selection
      ? selectionIssues(
          event.selection,
          frontendEventScope(schema, event).fields,
          frontendEventFields(schema).filter(
            (field) => !parent || field.parentId === parent,
          ),
          data,
        )
      : event.request
        ? requestIssues(
            event.request,
            frontendEventScope(schema, event),
            frontendEventOutputFields(schema, event),
          )
        : validateInvocation(event.plugin!, frontendEventScope(schema, event))
    ).map((issue) => ({ ...issue, step: 1 })),
  ];
}
export function frontendEventsIssues(
  schema: FormSchema,
  data?: WorkspaceData,
): string[] {
  const malformed = frontendEventSettingsErrors(schema.settings);
  if (malformed.length) return malformed;
  return [
    ...(schema.settings.frontendEvents || [])
      .filter((event) => event.enabled)
      .flatMap((event) =>
        frontendEventIssues(event, schema, data).map(
          (issue) => `前端事件「${event.name}」：${issue.message}`,
        ),
      ),
  ];
}

export function runFrontendEvent(
  event: FrontendEvent,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  row?: FrontendFieldChange["row"],
  forceFailure = false,
  selectedEntryId = "",
): ExtensionRun {
  const scope = frontendEventScope(schema, event);
  const rowValues =
    row && Array.isArray(values[row.subformId])
      ? (values[row.subformId] as FormValues[])[row.index]
      : undefined;
  const inputs = { ...values, ...(rowValues || {}) };
  const fail = (issue: ConfigIssue): ExtensionRun => ({
    id: uid("run"),
    formId: "",
    subjectId: event.id,
    name: event.name,
    kind: "plugin",
    time: new Date().toISOString(),
    status: "failed",
    mode: event.request ? "simulation" : "local",
    origin: "trial",
    input: {},
    output: {},
    mappedValues: {},
    error: issue,
    steps: [{ label: "检查事件", status: "failed", detail: issue.message }],
    snapshot: {
      config: copy(event.selection || event.request || event.plugin!),
      schema: copy(scope),
      values: {},
    },
  });
  const issue = frontendEventIssues(event, schema, data)[0];
  if (issue) return fail(issue);
  if (row && !rowValues)
    return fail({
      step: 1,
      target: "trigger",
      message: "触发行已不存在，请重新填写",
    });
  const readIds = event.selection
    ? selectionLocalReferences(event.selection)
    : (event.request
        ? requestBindings(event.request)
        : Object.values(event.plugin!.inputs)
      ).flatMap(bindingReferences);
  if (
    readIds.some(
      (id) =>
        !scope.fields.some(
          (field) =>
            field.id === id && isFieldVisibleInSchema(field, schema, inputs),
        ),
    )
  )
    return fail({
      step: 1,
      target: "trigger",
      message: "当前无权读取事件所需字段，未执行动作",
    });
  // An event must not widen a member's effective field/column permissions.
  if (
    frontendEventOutputIds(event).some(
      (id) =>
        !frontendEventOutputFields(schema, event).some(
          (field) =>
            field.id === id &&
            field.editable &&
            field.visible &&
            ((event.request || event.selection) &&
            !row &&
            frontendEventFields(schema).find((item) => item.id === id)?.parentId
              ? true
              : isFieldVisibleInSchema(field, schema, inputs)),
        ),
    )
  )
    return fail({
      step: 1,
      target: "output-mapping",
      message: "当前回填字段不可编辑，未回填任何字段",
    });
  const run = event.selection
    ? runFrontendSelection(
        event.selection,
        schema,
        inputs,
        data,
        scope.fields,
        frontendEventFields(schema),
        selectedEntryId,
        row,
      )
    : event.request
      ? runFrontendRequest(
          event.request,
          schema,
          inputs,
          data,
          frontendEventFields(schema),
          row,
          forceFailure,
        )
      : runPlugin(event.plugin!, scope, inputs, data, forceFailure, event.id);
  run.name = event.name;
  return run;
}

/** Only the explicitly edited control triggers events. Returned values never trigger another event. */
export function applyFrontendEvents(
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  trigger: "field" | "submit",
  change?: FrontendFieldChange,
  selectedEntries: Record<string, string> = {},
) {
  let next = copy(values);
  const failures: string[] = [];
  const runs: ExtensionRun[] = [];
  const fields = frontendTriggerFields(schema);
  const changed = fields.find((field) => field.id === change?.fieldId);
  const rowValues =
    change?.row && Array.isArray(values[change.row.subformId])
      ? (values[change.row.subformId] as FormValues[])[change.row.index]
      : undefined;
  if (
    trigger === "field" &&
    (!changed?.editable ||
      changed.parentId !== (change?.row?.subformId || "") ||
      !isFieldVisibleInSchema(changed, schema, {
        ...values,
        ...(rowValues || {}),
      }))
  )
    return { values: next, failures, runs };
  for (const event of schema.settings.frontendEvents || []) {
    if (
      !event.enabled ||
      event.trigger !== trigger ||
      (trigger === "field" && !event.fieldIds.includes(change!.fieldId))
    )
      continue;
    const run = runFrontendEvent(
      event,
      schema,
      values,
      data,
      change?.row,
      false,
      selectedEntries[event.id] || "",
    );
    runs.push(run);
    if (run.status !== "success") {
      failures.push(`${event.name}：${run.error?.message || "执行失败"}`);
      continue;
    }
    // Each event reads the user-edit snapshot; list order resolves overlapping outputs.
    if (change?.row) {
      const rows = copy(next[change.row.subformId] as FormValues[]);
      let target = rows[change.row.index]!;
      const subform = findField(schema.fields, change.row.subformId);
      if (!subform) continue;
      for (const [id, value] of Object.entries(run.mappedValues))
        target = applyFieldChange(
          subform.children,
          target,
          id,
          value,
          data,
          next,
          schema.fields,
        );
      rows[change.row.index] = target;
      next[change.row.subformId] = rows;
    } else
      for (const [id, value] of Object.entries(run.mappedValues))
        next = applyFieldChange(schema.fields, next, id, value, data);
  }
  return { values: next, failures, runs };
}
