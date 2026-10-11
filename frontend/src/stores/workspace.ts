import {
  subformRowLimitErrors,
  subformRowIdentityErrors,
  subformOperationErrors,
  isNumericField,
} from "@platform/contracts";
import { copyFormDesign } from "../domain/formCopy";
import { fillingSession } from "../domain/fillingSession";
import { quickFillDesignSchema } from "../domain/quickFill";
import { workspacePersistence } from "./workspacePersistence";
import { paymentActions } from "./paymentActions";
import { quickFillActions } from "./quickFillActions";
import { isPushEvent, type AutomationEvent } from "../domain/events";
import { recordCheckpoint, commitAutomationEntries } from "./recordTransaction";
import { automationStoreActions } from "./automationActions";
import { prepareAutomation } from "../domain/automation";
import { allocateSerialValues, serialPeriod } from "../domain/serial";
import { accessActions } from "./accessActions";
import {
  fillingIssue,
  accessConfig,
  accessFieldImpacts,
  memberContext,
} from "../domain/access";
import { buttonActions } from "./buttonActions";
import { generateWebhookCredential } from "../domain/webhookSecurity";
import { presentationActions } from "./presentationActions";
import { recordActions } from "./recordActions";
import { reminderActions } from "./reminderActions";
import { runReminder } from "../domain/reminders";
import {
  validateFieldConfiguration,
  richTextDefaultErrors,
  validateDynamicValues,
} from "../domain/fieldValidation";
import { blockingFormValidation } from "../domain/formValidation";
import {
  resolveRuntimeValues,
  subformFillingBaseline,
} from "../domain/relations";
import {
  extensionIssues,
  parseExtensions,
  runWebhook,
  runPlugin,
  newInvocation,
  type ExtensionRun,
  type PushEvent,
  type WebhookConfig,
} from "../domain/extensions";
import { createRelationDemo } from "../domain/relationDemo";
import { organizationActions } from "./organizationActions";
import { serverOrganization } from "./serverOrganization";
import { computed, ref, type Ref } from "vue";
import { workspaceScopes } from "../domain/workspaceTransactions";
import { workspaceWrites } from "./workspaceWrites";
import { defineStore } from "pinia";
import { formulaConfigurationErrors } from "../domain/formula";
import {
  copy,
  parseSchema,
  duplicateField,
  flattenFields,
  uid,
  prepareSubmission,
  validateValues,
  type FormValues,
} from "../domain/form";
import {
  newForm,
  formFieldLimitError,
  advanceEntry,
  type FormRecord,
  type WorkspaceApp,
  type FormEntry,
  type WorkspaceData,
} from "../domain/workspace";
import {
  initialWorkspace,
  LocalWorkspaceRepository,
} from "../repositories/workspaceRepository";
import {
  initialDocument,
  parseDocument,
  type FlowDocument,
  type Permission,
} from "../domain/workflow";

export function syncFormWorkflow(form: FormRecord) {
  form.workflow.title = form.title;
  const fields = flattenFields(form.schema.fields).filter(
    (f) => !["divider", "tabs", "button", "subform"].includes(f.type),
  );
  form.workflow.formFields = fields.map((f) => ({ id: f.id, label: f.label }));
  for (const node of form.workflow.nodes) {
    const old = node.data.permissions;
    node.data.permissions = Object.fromEntries(
      fields.map((f) => [
        f.id,
        old[f.id] ||
          old[f.label] ||
          (!f.visible ? "hidden" : !f.editable ? "read" : "edit"),
      ]),
    ) as Record<string, Permission>;
    node.data.briefFields = (node.data.briefFields || [])
      .map((id) => fields.find((f) => f.id === id || f.label === id)?.id)
      .filter((id): id is string => !!id);
  }
}
export const useWorkspaceStore = defineStore("workspace", () => {
  const repository = new LocalWorkspaceRepository();
  const loaded = initialWorkspace(repository);
  const data = ref(loaded.data) as Ref<WorkspaceData>;
  data.value.recentFormIds = repository.recentForms(data.value.recentFormIds);
  const drafts = ref({}) as Ref<Record<string, FormRecord>>;
  const notices = ref<{ id: string; message: string; type: string }[]>([]);
  // Preserve the workflow built before the workspace was introduced.
  if (!localStorage.getItem("workflow-studio-workspace-v1")) {
    try {
      const legacy = localStorage.getItem("vue-workflow-designer-v1");
      if (legacy) {
        const target = data.value.forms.find((f) => f.id === "expense")!;
        target.workflow = parseDocument(legacy);
        target.title = target.workflow.title;
      }
    } catch {
      /* The previous storage remains untouched. */
    }
  }
  data.value.forms.forEach(syncFormWorkflow);
  const activeForms = computed(() =>
    data.value.forms.filter((f) => !f.archived),
  );
  function notify(message: string, type = "success") {
    const id = uid("notice");
    notices.value.push({ id, message, type });
    setTimeout(
      () => (notices.value = notices.value.filter((n) => n.id !== id)),
      4000,
    );
  }
  const persistence = workspacePersistence(
    repository,
    data,
    drafts,
    loaded.error,
    notify,
    (workspace) => workspace.forms.forEach(syncFormWorkflow),
  );
  const { persist } = persistence;
  const directory = serverOrganization(
    data,
    persistence.acceptOrganization,
    notify,
  );
  function openForm(id: string) {
    // Commands already read and validate under the shared write lock. A nested
    // editor lookup must not clear a conflict or rebase that command's input.
    if (!writes.writePending.value) persistence.refreshForRead();
    let draft = drafts.value[id];
    if (!draft) {
      const form = data.value.forms.find((f) => f.id === id && !f.archived);
      if (!form) return;
      draft = copy(form);
      syncFormWorkflow(draft);
      drafts.value[id] = draft;
      persistence.rememberDraft(id);
    }
    if (data.value.recentFormIds[0] !== id) {
      data.value.recentFormIds = repository.rememberForm(
        id,
        data.value.recentFormIds,
      );
    }
    return drafts.value[id];
  }
  function calculationSchema(draft: FormRecord, previous?: FormRecord) {
    const schema = copy(draft.schema);
    const original = new Map(
      flattenFields([
        ...(previous?.schema.fields || []),
        ...(previous?.fieldTrash || []).map((item) => item.field),
      ]).map((field) => [field.id, field]),
    );
    for (const field of flattenFields(schema.fields)) {
      if (field.type !== "calculated") continue;
      const saved = original.get(field.id);
      if (
        saved?.calculationVersion === 1 ||
        saved?.type !== "calculated" ||
        saved.expression !== field.expression
      )
        field.calculationVersion = 1;
    }
    return schema;
  }
  function saveForm(id: string) {
    const draft = drafts.value[id];
    const index = data.value.forms.findIndex((f) => f.id === id);
    if (!draft || index < 0) return false;
    const fieldLimitError = formFieldLimitError(draft, data.value.forms);
    if (fieldLimitError) {
      notify(fieldLimitError, "warning");
      return false;
    }
    const previous = data.value.forms[index]!;
    const defaultError = richTextDefaultErrors(
      draft.schema.fields,
      previous.schema.fields,
    )[0];
    if (defaultError) {
      notify(defaultError, "warning");
      return false;
    }
    const original = flattenFields([
      ...previous.schema.fields,
      ...(previous.fieldTrash || []).map((item) => item.field),
    ]);
    for (const field of flattenFields([
      ...draft.schema.fields,
      ...(draft.fieldTrash || []).map((item) => item.field),
    ])) {
      const saved = original.find((item) => item.id === field.id);
      if (
        saved?.type === "calculated" &&
        field.type === "calculated" &&
        isNumericField(saved) !== isNumericField(field)
      ) {
        notify(`「${field.label}」保存后不能更改计算结果类型`, "error");
        return false;
      }
    }
    const schema = calculationSchema(draft, previous);
    try {
      // Saving an incomplete design is allowed; saving a definition that the
      // shared reader cannot reopen would make unrelated workspace reads fail.
      parseSchema(draft.schema);
      for (const field of flattenFields(schema.fields)) {
        if (field.type !== "calculated") continue;
        if (field.calculationVersion === 1 && field.expression.trim()) {
          const errors = formulaConfigurationErrors(field, schema.fields);
          if (errors.length) throw Error(`「${field.label}」${errors[0]}`);
        }
      }
    } catch (error) {
      notify((error as Error).message, "error");
      return false;
    }
    syncFormWorkflow(draft);
    draft.updatedAt = new Date().toISOString();
    data.value.forms[index] = { ...copy(draft), schema };
    if (!persist()) {
      data.value.forms[index] = previous;
      return false;
    }
    const current = new Set(
      flattenFields(schema.fields)
        .filter((field) => field.calculationVersion === 1)
        .map((field) => field.id),
    );
    for (const field of flattenFields(draft.schema.fields))
      if (current.has(field.id)) field.calculationVersion = 1;
    persistence.rememberDraft(id);
    return true;
  }
  function installRelationDemo(appId: string) {
    if (!data.value.apps.some((a) => a.id === appId)) return;
    const sample = createRelationDemo(appId);
    sample.forms.forEach(syncFormWorkflow);
    data.value.forms.unshift(...sample.forms);
    data.value.entries.push(...sample.entries);
    if (!persist()) {
      data.value.forms = data.value.forms.filter(
        (f) => !sample.forms.some((s) => s.id === f.id),
      );
      data.value.entries = data.value.entries.filter(
        (e) => !sample.entries.some((s) => s.id === e.id),
      );
      return;
    }
    return sample.forms[1];
  }
  function createApp(name: string, color = "#56ae72") {
    const app: WorkspaceApp = {
      id: uid("app"),
      name,
      color,
      icon: "layers",
      folders: ["未分组"],
      description: "",
    };
    data.value.apps.push(app);
    if (!persist()) {
      data.value.apps.pop();
      return;
    }
    return app;
  }
  function createForm(
    appId: string,
    title: string,
    kind: FormRecord["kind"],
    folder = "",
  ) {
    const app = data.value.apps.find((a) => a.id === appId);
    if (!app) {
      notify("应用已不存在，请返回工作台选择应用。", "warning");
      return;
    }
    if (folder && !app.folders.includes(folder)) {
      notify("所选分组已不存在，请重新选择。", "warning");
      return;
    }
    if (!title.trim()) {
      notify("请输入表单名称", "warning");
      return;
    }
    if (data.value.forms.length >= 500) {
      notify("已达到当前工作区的表单数量上限。", "warning");
      return;
    }
    const form = newForm(appId, title.trim(), kind, folder);
    syncFormWorkflow(form);
    data.value.forms.unshift(form);
    if (!persist()) {
      data.value.forms.shift();
      return;
    }
    return form;
  }
  function updateFormMetadata(
    id: string,
    patch: Partial<Pick<FormRecord, "title" | "folder">>,
  ) {
    const form = data.value.forms.find((f) => f.id === id);
    if (!form) return false;
    const previous = copy(form);
    Object.assign(form, patch, { updatedAt: new Date().toISOString() });
    syncFormWorkflow(form);
    if (!persist()) {
      Object.assign(form, previous);
      return false;
    }
    if (drafts.value[id]) {
      Object.assign(drafts.value[id]!, patch);
      persistence.rememberDraft(id);
    }
    return true;
  }
  function renameForm(id: string, title: string) {
    return updateFormMetadata(id, { title });
  }
  function createFolder(appId: string, name: string) {
    const app = data.value.apps.find((a) => a.id === appId);
    if (!app || app.folders.includes(name)) return false;
    app.folders.push(name);
    if (!persist()) {
      app.folders.pop();
      return false;
    }
    return true;
  }
  function duplicateForm(id: string) {
    const original = data.value.forms.find((f) => f.id === id);
    if (!original) return;
    const duplicate = copyFormDesign(original);
    const fieldLimitError = formFieldLimitError(duplicate, data.value.forms);
    if (fieldLimitError) {
      notify(fieldLimitError, "warning");
      return;
    }
    data.value.forms.unshift(duplicate);
    if (!persist()) {
      data.value.forms.shift();
      return;
    }
    return duplicate;
  }
  function archiveForm(id: string, archived = true) {
    const form = data.value.forms.find((f) => f.id === id);
    if (form) {
      const previous = form.archived;
      form.archived = archived;
      if (!persist()) {
        form.archived = previous;
        return false;
      }
      delete drafts.value[id];
      return true;
    }
    return false;
  }
  function publishForm(id: string) {
    const draft = openForm(id);
    if (!draft) return false;
    syncFormWorkflow(draft);
    const schema = calculationSchema(
      draft,
      data.value.forms.find((form) => form.id === id),
    );
    const errors = [
      ...validateFieldConfiguration(
        schema,
        data.value,
        data.value.forms.find((form) => form.id === id)?.schema.fields,
      ),
      ...accessFieldImpacts(
        accessConfig(data.value, id),
        accessConfig(data.value, id)
          .groups.flatMap((g) => g.filters.map((f) => f.sourceFieldId))
          .filter(
            (fieldId) =>
              !flattenFields(draft.schema.fields).some((f) => f.id === fieldId),
          ),
      ).map((name) => `${name}引用的字段已删除，请先调整发布设置`),
      ...extensionIssues(
        draft,
        data.value.webhookCredentials || [],
        data.value,
      ).map((i) => i.message),
    ];
    if (errors.length) {
      notify(errors[0]!, "warning");
      return false;
    }
    const previousPublished = draft.published;
    const previousVersions = draft.versions;
    draft.published = {
      version: (draft.published?.version || 0) + 1,
      title: draft.title,
      schema,
      workflow: copy(draft.workflow),
      extensions: copy(draft.extensions || { webhooks: [] }),
      publishedAt: new Date().toISOString(),
    };
    draft.versions = [...(draft.versions || []), copy(draft.published)];
    if (saveForm(id)) return true;
    draft.published = previousPublished;
    draft.versions = previousVersions;
    return false;
  }
  function appendRun(
    run: ExtensionRun,
    formId: string,
    origin: ExtensionRun["origin"] = "trial",
  ) {
    run.formId = formId;
    run.origin = origin;
    data.value.extensionRuns = [
      copy(run),
      ...(data.value.extensionRuns || []),
    ].slice(0, 200);
    return run;
  }
  function recordExtensionRun(run: ExtensionRun, formId: string) {
    const previous = data.value.extensionRuns;
    appendRun(run, formId);
    if (!persist()) {
      data.value.extensionRuns = previous;
      return false;
    }
    return true;
  }
  function createWebhookCredential() {
    const previous = data.value.webhookCredentials;
    const credential = generateWebhookCredential();
    data.value.webhookCredentials = [...(previous || []), credential];
    if (!persist()) {
      data.value.webhookCredentials = previous;
      return;
    }
    return credential;
  }
  function saveWebhook(formId: string, config: WebhookConfig) {
    const draft = openForm(formId);
    if (!draft) return false;
    const previous = copy(draft.extensions || { webhooks: [] });
    draft.extensions = parseExtensions(draft.extensions);
    const index = draft.extensions.webhooks.findIndex(
      (c) => c.id === config.id,
    );
    if (index < 0) draft.extensions.webhooks.push(copy(config));
    else draft.extensions.webhooks[index] = copy(config);
    if (!saveForm(formId)) {
      draft.extensions = previous;
      return false;
    }
    return true;
  }
  function emitDataEvent(
    form: FormRecord,
    entry: FormEntry,
    event: AutomationEvent,
    previousValues?: FormValues,
    actorId = data.value.organization.currentUserId,
  ) {
    const definition =
      form.versions.find((v) => v.version === entry.definitionVersion) ||
      form.published;
    if (!definition) return;
    // Workflow navigation with unchanged values is not a data-change trigger.
    const changed =
      event !== "data_update" ||
      JSON.stringify(previousValues) !== JSON.stringify(entry.values);
    const sourceValues = copy(entry.values);
    const eventData: WorkspaceData = {
      ...data.value,
      organization: { ...data.value.organization, currentUserId: actorId },
    };
    if (changed)
      for (const config of definition.extensions?.automations || []) {
        if (
          !config.enabled ||
          config.archived ||
          !config.events.includes(event)
        )
          continue;
        const prepared = prepareAutomation(
          config,
          definition.schema,
          sourceValues,
          event,
          eventData,
          { formId: form.id, entryId: entry.id, actorId },
        );
        if (prepared.run.status === "success") {
          commitAutomationEntries(data.value, prepared.entries);
          data.value.serialCounters = prepared.serialCounters;
          eventData.serialCounters = prepared.serialCounters;
          prepared.run.output.committed = true;
          const last = prepared.run.steps.at(-1);
          if (last)
            last.detail = `${prepared.entries.length} 条目标记录已随本次操作整组保存`;
        }
        // Derived writes do not recursively emit events; prevents cross-form automation loops.
        appendRun(prepared.run, form.id, "record");
        if (prepared.run.status === "failed")
          notify(
            `智能助手「${config.name}」未完成：${prepared.run.error?.message}`,
            "warning",
          );
      }
    // Payment results have dedicated triggers; do not also fire generic data-update rules.
    if (!isPushEvent(event)) return;
    for (const config of definition.extensions?.reminders || []) {
      if (
        config.enabled &&
        !config.archived &&
        config.trigger === "event" &&
        config.events.includes(event)
      )
        appendRun(
          runReminder(config, definition.schema, sourceValues, data.value, {
            event,
            entryId: entry.id,
          }),
          form.id,
          "record",
        );
    }
    for (const config of definition.extensions?.webhooks || []) {
      if (!config.enabled || config.archived || !config.events.includes(event))
        continue;
      const run = runWebhook(
        config,
        definition.schema,
        sourceValues,
        event,
        data.value,
        false,
        entry.id,
      );
      appendRun(run, form.id, "record");
    }
  }
  function pluginExecutor(form: FormRecord, entry: FormEntry) {
    const definition =
      form.versions.find((v) => v.version === entry.definitionVersion) ||
      form.published!;
    return (
      node: import("../domain/workflow").FlowNode,
      values: FormValues,
    ) => {
      const run = runPlugin(
        node.data.pluginConfig || newInvocation(node.data.plugin),
        definition.schema,
        values,
        data.value,
        false,
        node.id,
      );
      run.entryId = entry.id;
      if (run.status === "success") {
        const mappingStep = run.steps.find((step) => step.label === "结果回填");
        if (mappingStep)
          mappingStep.detail = Object.keys(run.mappedValues).length
            ? `${Object.keys(run.mappedValues).length} 个字段用于当前记录流转`
            : "无需回填，继续下一节点";
      }
      return appendRun(run, form.id, "record");
    };
  }
  function retryEntryPlugin(id: string) {
    const entry = data.value.entries.find((e) => e.id === id),
      form = data.value.forms.find((f) => f.id === entry?.formId);
    if (
      !entry ||
      entry.deletedAt ||
      !form ||
      !entry.pluginError ||
      entry.status !== "submitted"
    )
      return false;
    const definition =
      form.versions.find((v) => v.version === entry.definitionVersion) ||
      form.published;
    if (
      !definition ||
      !definition.workflow.nodes.some(
        (n) => n.id === entry.currentNodeId && n.data.kind === "plugin",
      )
    )
      return false;
    const previousValues = copy(entry.values),
      rollback = recordCheckpoint(data.value);
    advanceEntry(
      entry,
      definition.workflow,
      "retry",
      pluginExecutor(form, entry),
    );
    emitDataEvent(form, entry, "data_update", previousValues);
    if (!persist()) {
      rollback();
      return false;
    }
    return !entry.pluginError;
  }
  function submitEntry(
    formId: string,
    values: FormValues,
    status: FormEntry["status"] = "submitted",
    draftId?: string,
    actor = data.value.organization.currentUserId,
  ) {
    const form = data.value.forms.find((f) => f.id === formId);
    if (!form?.published) return;
    const restriction = fillingIssue(data.value, formId, actor);
    if (restriction) {
      notify(restriction, "warning");
      return;
    }
    const session = fillingSession(data.value, formId, draftId, actor);
    if (session.issue || !session.definition) {
      notify(session.issue || "无法读取填写版本", "warning");
      return;
    }
    const previousDraft = session.draft,
      definition = session.definition;
    const rowIssue = [
      ...subformRowLimitErrors(
        definition.schema.fields,
        values,
        status === "draft" ? previousDraft?.values : undefined,
      ),
      ...subformRowIdentityErrors(definition.schema.fields, values),
    ][0];
    if (rowIssue) {
      notify(rowIssue.message, "warning");
      return;
    }
    if (form.kind !== "workflow") {
      const baseline = subformFillingBaseline(
        definition.schema.fields,
        actor === data.value.organization.currentUserId
          ? data.value
          : memberContext(data.value, actor),
        values,
      );
      const issue = subformOperationErrors(
        definition.schema.fields,
        baseline,
        values,
        baseline,
      )[0];
      if (issue) {
        notify(issue.message, "warning");
        return;
      }
    }
    const hasCounter = flattenFields(definition.schema.fields).some(
      (f) => f.type === "serial" && f.serial,
    );
    // Generated values cannot be supplied by a caller or retained from an unsubmitted draft.
    if (hasCounter) {
      values = copy(values);
      for (const field of flattenFields(definition.schema.fields))
        if (field.type === "serial" && field.serial) values[field.id] = "";
    }
    if (status !== "draft" && form.kind !== "workflow")
      values = prepareSubmission(
        definition.schema,
        resolveRuntimeValues(definition.schema, values, data.value),
        undefined,
        true,
      );
    if (status !== "draft" && form.kind !== "workflow") {
      const issue = blockingFormValidation(definition.schema, values, {
        data: data.value,
      })[0];
      if (issue) {
        notify(issue, "warning");
        return;
      }
    }
    if (status !== "draft" && (hasCounter || form.kind !== "workflow")) {
      const validationContext =
        actor === data.value.organization.currentUserId
          ? data.value
          : memberContext(data.value, actor);
      const validationSchema =
        form.kind === "workflow"
          ? quickFillDesignSchema({
              schema: definition.schema,
              workflow: definition.workflow,
              kind: form.kind,
            })
          : definition.schema;
      const others = data.value.entries
        .filter(
          (e) => e.formId === formId && !e.deletedAt && e.status !== "draft",
        )
        .map((e) => e.values);
      const issue = [
        ...validateValues(validationSchema, values, others),
        ...validateDynamicValues(validationSchema, values, validationContext),
      ][0];
      if (issue) {
        notify(issue.message, "warning");
        return;
      }
    }
    const now = new Date().toISOString();
    let allocation: ReturnType<typeof allocateSerialValues> | undefined;
    if (status !== "draft") {
      try {
        allocation = allocateSerialValues(
          definition.schema,
          values,
          data.value,
          formId,
          new Date(now),
        );
      } catch (error) {
        notify(
          error instanceof Error ? error.message : "流水号生成失败",
          "warning",
        );
        return;
      }
      values = allocation.values;
    }
    const entry: FormEntry = {
      id: previousDraft?.id || uid("entry"),
      createdBy: previousDraft?.createdBy || actor,
      createdDepartmentIds: previousDraft?.createdDepartmentIds || [
        ...(data.value.organization.employees.find((e) => e.id === actor)
          ?.departmentIds || []),
      ],
      formId,
      definitionVersion: definition.version,
      values: copy(values),
      createdAt: previousDraft?.createdAt || now,
      status,
      history: copy(previousDraft?.history || []),
    };
    const flow = definition.workflow;
    const start = flow.nodes.find((n) => n.data.kind === "start");
    entry.currentNodeId = flow.edges.find(
      (e) => e.source === start?.id,
    )?.target;
    entry.history.push({
      label: form.kind === "workflow" ? "流程发起节点" : "填写表单",
      action:
        status === "draft"
          ? "保存草稿"
          : form.kind === "workflow"
            ? "提交申请"
            : "提交数据",
      time: now,
    });
    const rollback = recordCheckpoint(data.value);
    if (allocation) data.value.serialCounters = allocation.counters;
    if (form.kind === "workflow" && status !== "draft")
      advanceEntry(entry, flow, "start", pluginExecutor(form, entry));
    data.value.entries = data.value.entries.filter((e) => e.id !== entry.id);
    data.value.entries.unshift(entry);
    if (status !== "draft")
      emitDataEvent(form, entry, "data_create", undefined, actor);
    if (!persist()) {
      rollback();
      return;
    }
    return entry;
  }
  function resetSerialCounter(formId: string, fieldId: string) {
    const form = data.value.forms.find((f) => f.id === formId && !f.archived);
    const field =
      form?.published &&
      flattenFields(form.published.schema.fields).find(
        (f) => f.id === fieldId && f.type === "serial",
      );
    if (!field?.serial) {
      notify("请先保存并发布流水号规则", "warning");
      return false;
    }
    const s = field.serial,
      previous = data.value.serialCounters;
    data.value.serialCounters = {
      ...previous,
      [formId]: {
        ...previous?.[formId],
        [fieldId]: {
          ...previous?.[formId]?.[fieldId],
          [s.reset]: {
            period: serialPeriod(s.reset, new Date()),
            next: s.initial,
          },
        },
      },
    };
    if (!persist()) {
      data.value.serialCounters = previous;
      return false;
    }
    return true;
  }
  function processEntry(id: string, action: "approved" | "rejected") {
    const entry = data.value.entries.find((e) => e.id === id);
    const form = data.value.forms.find((f) => f.id === entry?.formId);
    if (!entry || entry.deletedAt || !form || entry.status !== "submitted")
      return false;
    const definition =
      form.versions.find((v) => v.version === entry.definitionVersion) ||
      form.published;
    if (!definition) return false;
    if (
      entry.pluginError ||
      definition.workflow.nodes.find((n) => n.id === entry.currentNodeId)?.data
        .kind === "plugin"
    )
      return false;
    const previousValues = copy(entry.values),
      rollback = recordCheckpoint(data.value);
    advanceEntry(
      entry,
      definition.workflow,
      action,
      pluginExecutor(form, entry),
    );
    emitDataEvent(form, entry, "data_update", previousValues);
    if (!persist()) {
      rollback();
      return false;
    }
    return true;
  }
  const records = recordActions(
    data,
    persist,
    notify,
    emitDataEvent,
    (form, entry) =>
      advanceEntry(
        entry,
        form.published!.workflow,
        "start",
        pluginExecutor(form, entry),
      ),
  );
  const buttons = buttonActions(data, openForm, saveForm, notify);
  const commands = {
    ...quickFillActions(openForm, saveForm, notify),
    ...paymentActions(
      data,
      openForm,
      saveForm,
      persist,
      notify,
      (entry, event, actorId) => {
        const form = data.value.forms.find((f) => f.id === entry.formId);
        if (form) emitDataEvent(form, entry, event, undefined, actorId);
      },
    ),
    ...accessActions(
      data,
      persist,
      notify,
      submitEntry,
      records.updateEntry,
      records.recycleEntries,
    ),
    saveButton: buttons.saveButton,
    ...automationStoreActions(data, openForm, saveForm, notify),
    ...reminderActions(data, openForm, saveForm, persist, notify, appendRun),
    ...records,
    setCurrentUser: organizationActions(data, persist, notify).setCurrentUser,
    ...presentationActions(openForm, saveForm, notify, () => data.value),
    createWebhookCredential,
    recordExtensionRun,
    saveWebhook,
    retryEntryPlugin,
    processEntry,
    updateFormMetadata,
    createFolder,
    persist,
    saveForm,
    installRelationDemo,
    createApp,
    createForm,
    renameForm,
    duplicateForm,
    archiveForm,
    publishForm,
    submitEntry,
    resetSerialCounter,
    recoverDesign: persistence.recoverDesign,
  };
  const writes = workspaceWrites(
    commands,
    (message) => {
      persistence.reportError(message);
      notify(message, "warning");
    },
    (name, args) => {
      // Every command declares an edit scope; reread all other dependencies under the lock.
      if (name !== "recoverDesign")
        persistence.prepareWrite(workspaceScopes[name](args));
    },
  );
  return {
    data,
    drafts,
    ...persistence,
    ...writes.guarded,
    ...directory.actions,
    loadDirectory: directory.load,
    directoryLoading: directory.loading,
    directoryError: directory.error,
    directoryReady: computed(
      () => !!directory.snapshot.value && !directory.error.value,
    ),
    writePending: writes.writePending,
    activeForms,
    notices,
    notify,
    openForm,
    queuePrefill: buttons.queuePrefill,
    consumePrefill: buttons.consumePrefill,
  };
});
