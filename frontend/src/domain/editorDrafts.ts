export interface EditorDraft {
  id: string;
  key: string;
  title: string;
  path: string;
  context: string;
  value: unknown;
  updatedAt: string;
}
export const EDITOR_DRAFT_FORMAT = "workflow-studio-editor-drafts-v1";
export const MAX_EDITOR_DRAFTS = 50;
export const MAX_DRAFT_FILE_SIZE = 15_000_000;
export const draftBytes = (text: string) =>
  new TextEncoder().encode(text).byteLength;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Recovery files are untrusted. Reject unsafe keys and bound depth/size before any editor sees them. */
export function checkedDraftValue(value: unknown): unknown {
  let count = 0;
  function check(value: unknown, depth: number): unknown {
    if (++count > 50000 || depth > 35) throw Error("暂存内容过于复杂");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value))
      return value.map((v) => check(v === undefined ? null : v, depth + 1));
    if (!value || typeof value !== "object") throw Error("暂存内容格式无效");
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) throw Error("暂存内容包含不允许的属性");
      if (item !== undefined) result[key] = check(item, depth + 1);
    }
    return result;
  }
  const result = check(value, 0);
  if (draftBytes(JSON.stringify(result)) > 1_000_000)
    throw Error("单份暂存超过 1 MB，请使用原编辑器导出");
  return result;
}

export function parseEditorDrafts(text: string): EditorDraft[] {
  if (draftBytes(text) > MAX_DRAFT_FILE_SIZE)
    throw Error("恢复文件过大，请选择 15 MB 以内的文件");
  const raw = JSON.parse(text);
  const drafts =
    raw?.format === EDITOR_DRAFT_FORMAT
      ? raw.drafts
      : raw?.format === "workflow-studio-recovery-v1"
        ? raw.editorDrafts
        : undefined;
  if (!Array.isArray(drafts) || drafts.length > MAX_EDITOR_DRAFTS)
    throw Error("文件没有有效的编辑暂存内容");
  return drafts.map(checkedEditorDraft);
}
export function checkedEditorDraft(d: any): EditorDraft {
  if (
    !d ||
    typeof d.id !== "string" ||
    !d.id ||
    d.id.length > 100 ||
    typeof d.key !== "string" ||
    !d.key ||
    d.key.length > 500 ||
    typeof d.title !== "string" ||
    d.title.length > 300 ||
    typeof d.path !== "string" ||
    !/^\/(?!\/)/.test(d.path) ||
    d.path.length > 2000 ||
    /[\\\u0000-\u001f]/.test(d.path) ||
    typeof d.context !== "string" ||
    d.context.length > 500_000 ||
    typeof d.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(d.updatedAt))
  )
    throw Error("暂存条目的来源或格式无效");
  return {
    id: d.id,
    key: d.key,
    title: d.title,
    path: d.path,
    context: d.context,
    updatedAt: d.updatedAt,
    value: checkedDraftValue(d.value),
  };
}

export function serializeEditorDrafts(drafts: EditorDraft[]) {
  return JSON.stringify({ format: EDITOR_DRAFT_FORMAT, drafts });
}

export function draftFingerprint(draft: EditorDraft) {
  return JSON.stringify([
    draft.key,
    contextFingerprint(draft.context),
    draft.value,
  ]);
}

/** Repository normalization may reorder object keys without changing the editing context. */
export function contextFingerprint(context: string): string {
  try {
    return JSON.stringify(JSON.parse(context), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
    );
  } catch {
    return context;
  }
}
