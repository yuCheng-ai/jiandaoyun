import { workspaceReadIsLossless } from "../domain/workspaceSync";
import { assertWorkspaceWriteLock } from "./workspaceWriteLock";
import { parseAccess } from "../domain/access";
import { parseWebhookCredentials } from "../domain/webhookSecurity";
import { parseRecordView } from "../domain/records";
import { parseOrganization } from "../domain/organization";
import { parseExtensions } from "../domain/extensions";
import { parseSchema, copy } from "../domain/form";
import { parseSerialCounters } from "../domain/serial";
import { parseVisibilityRules } from "@platform/contracts";
import { parseDocument } from "../domain/workflow";
import {
  seedWorkspace,
  type WorkspaceData,
  type PublishedDefinition,
  type RecycledField,
} from "../domain/workspace";
export interface WorkspaceRepository {
  load(): WorkspaceData | null;
  save(data: WorkspaceData): void;
}
export const WORKSPACE_KEY = "workflow-studio-workspace-v1";
export const RECENT_FORMS_KEY = "workflow-studio-recent-forms-v1";
export class WorkspaceConflictError extends Error {
  constructor() {
    super("其他页面保存了新内容。本页修改仍保留，请查看更新后继续。");
    this.name = "WorkspaceConflictError";
  }
}
function parseFieldTrash(raw: unknown): RecycledField[] {
  if (!Array.isArray(raw)) throw Error("字段回收站配置无效");
  const items: RecycledField[] = raw.map((item) => {
    if (
      !item ||
      (item.parentId !== null &&
        (typeof item.parentId !== "string" || !item.parentId)) ||
      !Array.isArray(item.rules)
    )
      throw Error("字段回收站配置无效");
    return {
      ...item,
      field: parseSchema({ version: 1, fields: [item.field] }).fields[0]!,
    };
  });
  // Archived rules are inactive; their fields may be removed or have no current parent.
  items.forEach((item) => {
    item.rules = parseVisibilityRules(item.rules, [], false);
  });
  return items;
}
function parseVersion(version: any): PublishedDefinition {
  if (
    !Number.isInteger(version?.version) ||
    version.version < 1 ||
    typeof version.title !== "string"
  )
    throw Error("发布版本无效");
  return {
    version: version.version,
    title: version.title,
    publishedAt: String(version.publishedAt || ""),
    schema: parseSchema(version.schema),
    workflow: parseDocument(JSON.stringify(version.workflow)),
    extensions: parseExtensions(version.extensions),
  };
}
export function parseWorkspace(text: string): WorkspaceData {
  const raw = JSON.parse(text);
  if (
    raw?.version !== 1 ||
    !Array.isArray(raw.apps) ||
    !Array.isArray(raw.forms) ||
    !Array.isArray(raw.entries) ||
    raw.forms.length > 500
  )
    throw Error("工作台配置格式无效");
  raw.organization = parseOrganization(raw.organization);
  if (raw.serialCounters !== undefined)
    raw.serialCounters = parseSerialCounters(raw.serialCounters);
  raw.webhookCredentials = parseWebhookCredentials(raw.webhookCredentials);
  const appIds = new Set<string>();
  for (const app of raw.apps) {
    if (
      typeof app?.id !== "string" ||
      appIds.has(app.id) ||
      typeof app.name !== "string" ||
      !Array.isArray(app.folders)
    )
      throw Error("应用配置无效");
    appIds.add(app.id);
  }
  const formIds = new Set<string>();
  raw.forms = raw.forms.map((form: any) => {
    if (
      typeof form?.id !== "string" ||
      formIds.has(form.id) ||
      !appIds.has(form.appId) ||
      typeof form.title !== "string"
    )
      throw Error("表单配置无效");
    formIds.add(form.id);
    const schema = parseSchema(form.schema);
    return {
      ...form,
      schema,
      ...(form.fieldTrash === undefined
        ? {}
        : { fieldTrash: parseFieldTrash(form.fieldTrash) }),
      workflow: parseDocument(JSON.stringify(form.workflow)),
      extensions: parseExtensions(form.extensions),
      versions: (Array.isArray(form.versions)
        ? form.versions
        : form.published
          ? [form.published]
          : []
      ).map(parseVersion),
      published: form.published ? parseVersion(form.published) : undefined,
    };
  });
  if (raw.formAccess && typeof raw.formAccess === "object")
    raw.formAccess = Object.fromEntries(
      Object.entries(raw.formAccess)
        .filter(([id]) => formIds.has(id))
        .map(([id, value]) => [id, parseAccess(value)]),
    );
  raw.entries = raw.entries.filter(
    (entry: any) =>
      typeof entry?.id === "string" &&
      formIds.has(entry.formId) &&
      ["draft", "submitted", "approved", "rejected"].includes(entry.status) &&
      Array.isArray(entry.history) &&
      entry.values &&
      typeof entry.values === "object",
  );
  raw.recentFormIds = Array.isArray(raw.recentFormIds)
    ? raw.recentFormIds.filter((id: string) => formIds.has(id))
    : [];
  if (raw.recordViews && typeof raw.recordViews === "object")
    raw.recordViews = Object.fromEntries(
      Object.entries(raw.recordViews)
        .filter(([id]) => formIds.has(id))
        .map(([id, value]) => [id, parseRecordView(value)]),
    );
  raw.entries.forEach((e: any) => {
    if (typeof e.createdBy !== "string") delete e.createdBy;
    if (e.createdDepartmentIds !== undefined)
      e.createdDepartmentIds = Array.isArray(e.createdDepartmentIds)
        ? e.createdDepartmentIds.filter((id: unknown) => typeof id === "string")
        : [];
    if (e.reminderReceipts !== undefined)
      e.reminderReceipts = Array.isArray(e.reminderReceipts)
        ? [
            ...new Set(
              e.reminderReceipts.filter(
                (id: unknown) => typeof id === "string",
              ),
            ),
          ]
        : [];
    if (
      typeof e.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(e.deletedAt))
    )
      delete e.deletedAt;
  });
  raw.extensionRuns = (
    Array.isArray(raw.extensionRuns) ? raw.extensionRuns : []
  )
    .filter(
      (r: any) =>
        typeof r?.id === "string" &&
        formIds.has(r.formId) &&
        ["webhook", "plugin", "reminder", "automation"].includes(r.kind) &&
        ["success", "failed", "skipped"].includes(r.status) &&
        Array.isArray(r.steps) &&
        r.snapshot?.schema &&
        r.snapshot?.config &&
        r.snapshot?.values,
    )
    .slice(0, 200);
  return raw;
}
export class LocalWorkspaceRepository implements WorkspaceRepository {
  private baseline: string | null | undefined;
  constructor(
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {}
  load() {
    const raw = this.storage.getItem(WORKSPACE_KEY);
    const data = raw === null ? null : parseWorkspace(raw);
    if (raw && !workspaceReadIsLossless(JSON.parse(raw), data))
      throw Error("已保存的内容无法完整读取，原内容已保留，暂时不能覆盖保存。");
    // Parsing must succeed before a snapshot may become the write baseline.
    this.baseline = raw;
    return data;
  }
  baselineRaw() {
    return this.baseline;
  }
  latestRaw() {
    return this.storage.getItem(WORKSPACE_KEY);
  }
  hasExternalChange() {
    return this.baseline !== undefined && this.latestRaw() !== this.baseline;
  }
  adoptSnapshot(raw: string) {
    // A caller may adopt only an inspected snapshot that is still current.
    if (this.baseline === undefined || this.latestRaw() !== raw)
      throw new WorkspaceConflictError();
    this.baseline = raw;
  }
  recentForms(fallback: string[]): string[] {
    try {
      const raw = this.storage.getItem(RECENT_FORMS_KEY);
      const ids: unknown = raw === null ? fallback : JSON.parse(raw);
      return Array.isArray(ids)
        ? [
            ...new Set(
              ids.filter((id): id is string => typeof id === "string"),
            ),
          ].slice(0, 8)
        : fallback;
    } catch {
      return fallback;
    }
  }
  rememberForm(id: string, fallback: string[]) {
    const recent = [
      id,
      ...this.recentForms(fallback).filter((value) => value !== id),
    ].slice(0, 8);
    // This advisory cache must never write or block the business-data snapshot.
    try {
      this.storage.setItem(RECENT_FORMS_KEY, JSON.stringify(recent));
    } catch {
      /* Keep this visit in memory. */
    }
    return recent;
  }
  save(data: WorkspaceData) {
    if (this.baseline === undefined)
      throw Error("尚未成功读取工作空间，不能覆盖本地数据");
    assertWorkspaceWriteLock();
    const serialized = JSON.stringify(data);
    if (this.hasExternalChange()) throw new WorkspaceConflictError();
    // The caller holds the shared Web Lock across comparison and write.
    this.storage.setItem(WORKSPACE_KEY, serialized);
    this.baseline = serialized;
  }
}
export function initialWorkspace(repository: WorkspaceRepository): {
  data: WorkspaceData;
  error: string;
} {
  try {
    return { data: repository.load() || seedWorkspace(), error: "" };
  } catch {
    return {
      data: seedWorkspace(),
      error:
        "本地工作台数据无法读取，已打开示例工作台。原始数据仍保留，保存新数据前请先导出备份。",
    };
  }
}
export function exportWorkspace(data: WorkspaceData): string {
  return JSON.stringify(copy(data), null, 2);
}
