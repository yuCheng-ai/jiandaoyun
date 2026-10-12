import type { FormRecord, WorkspaceData } from "./workspace";
import { sameWorkspaceValue } from "./workspaceSync";

/** A command protects the objects the user edited. Other data is reread before validation. */
export type WorkspaceScope = {
  select: (data: WorkspaceData) => unknown;
  label?: (data: WorkspaceData) => string;
  draftId?: string;
};
type ScopeFactory = (args: any[]) => WorkspaceScope;
const fresh: ScopeFactory = () => ({ select: () => null });
const form = (data: WorkspaceData, id: string) =>
  data.forms.find((f) => f.id === id);
const runtimeForm = (data: WorkspaceData, id: string) => {
  const value = form(data, id);
  return (
    value && {
      id: value.id,
      appId: value.appId,
      kind: value.kind,
      archived: value.archived,
      published: value.published,
      versions: value.versions,
    }
  );
};
const formScope: ScopeFactory = ([id]) => ({
  select: (data) => form(data, id),
  label: (data) => `表单「${form(data, id)?.title || "当前设计"}」`,
});
const design: ScopeFactory = ([id]) => ({ ...formScope([id]), draftId: id });
const record = (data: WorkspaceData, id: string) => {
  const entry = data.entries.find((e) => e.id === id);
  return {
    entry,
    form: runtimeForm(data, entry?.formId || ""),
    actor: data.organization.currentUserId,
  };
};
const recordScope: ScopeFactory = ([id]) => ({
  select: (data) => record(data, id),
  label: (data) =>
    `「${form(data, data.entries.find((e) => e.id === id)?.formId || "")?.title || "当前表单"}」中的这条记录`,
});
/** Explicit, exhaustive at the store boundary. New commands must declare their edit scope. */
export const workspaceScopes = {
  createApp: fresh,
  createForm: fresh,
  createFolder: fresh,
  installRelationDemo: fresh,
  createWebhookCredential: fresh,
  checkDueReminders: fresh,
  recordExtensionRun: fresh,
  saveForm: design,
  publishForm: design,
  saveWebhook: design,
  saveQuickFill: design,
  savePayment: design,
  saveButton: design,
  saveAutomation: design,
  saveReminder: design,
  savePrintTemplate: design,
  saveDetailSettings: design,
  saveCollaboration: design,
  renameForm: design,
  updateFormMetadata: design,
  archiveForm: formScope,
  duplicateForm: formScope,
  saveFormAccess: ([id]) => ({
    label: (data) => `「${form(data, id)?.title || "当前表单"}」的访问设置`,
    select: (data) => {
      const current = form(data, id);
      return {
        form: current && {
          id: current.id,
          appId: current.appId,
          archived: current.archived,
        },
        access: data.formAccess?.[id],
        actor: data.organization.currentUserId,
      };
    },
  }),
  saveRecordView: ([id]) => ({
    label: (data) => `「${form(data, id)?.title || "当前表单"}」的数据视图`,
    select: (data) => ({ form: form(data, id), view: data.recordViews?.[id] }),
  }),
  submitEntry: ([id, , , draftId, actor]) => ({
    label: (data) => `「${form(data, id)?.title || "当前表单"}」的填写内容`,
    select: (data) => ({
      form: runtimeForm(data, id),
      draft: data.entries.find((e) => e.id === draftId),
      actor: actor || data.organization.currentUserId,
    }),
  }),
  resetSerialCounter: ([id, fieldId]) => ({
    label: (data) => `「${form(data, id)?.title || "当前表单"}」的流水号`,
    select: (data) => ({
      form: runtimeForm(data, id),
      counter: data.serialCounters?.[id]?.[fieldId],
      actor: data.organization.currentUserId,
    }),
  }),
  memberSubmit: ([id]) => ({
    ...formScope([id]),
    select: (data) => runtimeForm(data, id),
  }),
  updateEntry: recordScope,
  updateEntryField: recordScope,
  batchUpdateEntries: ([id, selection]) => ({
    label: () => "选中的记录",
    select: (data) => {
      const ids = new Set(selection.map((item: { id: string }) => item.id));
      return {
        form: runtimeForm(data, id),
        entries: data.entries.filter((entry) => ids.has(entry.id)),
        actor: data.organization.currentUserId,
      };
    },
  }),
  importEntries: ([id, request]) => ({
    label: () => "待导入的表单和记录",
    select: (data) => {
      const column = request.mapping.find(
        (m: { fieldId: string }) => m.fieldId === "data_id",
      )?.column;
      const ids = new Set(
        request.mode === "create" || column === undefined
          ? []
          : request.rows
              .map((row: unknown[]) => String(row[column] ?? "").trim())
              .filter(Boolean),
      );
      return {
        form: runtimeForm(data, id),
        entries: data.entries.filter(
          (entry) => entry.formId === id && ids.has(entry.id),
        ),
        actor: request.member?.actorId || data.organization.currentUserId,
      };
    },
  }),
  memberUpdate: recordScope,
  memberDelete: recordScope,
  processEntry: recordScope,
  retryEntryPlugin: recordScope,
  recycleEntries: ([ids]) => ({
    label: () => "选中的记录",
    select: (data) => ids.map((id: string) => record(data, id)),
  }),
  setCurrentUser: fresh,
  persist: () => ({ select: businessSnapshot }),
} satisfies Record<string, ScopeFactory>;

export function businessSnapshot({ recentFormIds: _, ...data }: WorkspaceData) {
  return {
    ...data,
    webhookCredentials: data.webhookCredentials || [],
    extensionRuns: data.extensionRuns || [],
  };
}

export function scopeUnchanged(
  scope: WorkspaceScope,
  base: WorkspaceData,
  next: WorkspaceData,
  draftBases: Record<string, FormRecord>,
) {
  const expected = scope.draftId
    ? draftBases[scope.draftId] || form(base, scope.draftId)
    : scope.select(base);
  return sameWorkspaceValue(expected, scope.select(next));
}

/** Reuse unchanged objects so a background update cannot reset an open control. */
export function retainWorkspaceObjects(
  current: WorkspaceData,
  next: WorkspaceData,
): WorkspaceData {
  for (const key of Object.keys(next) as (keyof WorkspaceData)[]) {
    const before = current[key],
      after = next[key];
    if (sameWorkspaceValue(before, after)) (next as any)[key] = before;
    else if (Array.isArray(before) && Array.isArray(after)) {
      const byId = new Map(
        before.filter((v: any) => v?.id).map((v: any) => [v.id, v]),
      );
      (next as any)[key] = after.map((v: any) =>
        byId.has(v?.id) && sameWorkspaceValue(byId.get(v.id), v)
          ? byId.get(v.id)
          : v,
      );
    }
  }
  next.recentFormIds = current.recentFormIds;
  return next;
}
