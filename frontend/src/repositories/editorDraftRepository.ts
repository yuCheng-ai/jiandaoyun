import {
  draftBytes,
  parseEditorDrafts,
  serializeEditorDrafts,
  type EditorDraft,
} from "../domain/editorDrafts";
export const EDITOR_DRAFT_KEY = "workflow-studio-editor-drafts-v1";

/** Per-tab recovery copies; never part of committed workspace data. */
export class EditorDraftRepository {
  private readable = false;
  private storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  private accessError = "";
  constructor(storage?: Pick<Storage, "getItem" | "setItem">) {
    try {
      this.storage =
        storage ||
        (typeof sessionStorage === "undefined" ? undefined : sessionStorage);
    } catch {
      this.accessError = "浏览器未允许读取标签页暂存，当前修改仍可下载保留";
    }
  }
  load(): EditorDraft[] {
    if (this.accessError) throw Error(this.accessError);
    const raw = this.storage?.getItem(EDITOR_DRAFT_KEY);
    const drafts = raw ? parseEditorDrafts(raw) : [];
    this.readable = true;
    return drafts;
  }
  save(drafts: EditorDraft[]) {
    if (!this.readable)
      throw Error("原暂存内容无法读取，不能覆盖；请先导出当前修改");
    if (!this.storage) throw Error("当前环境无法暂存，请下载副本保留修改");
    const text = serializeEditorDrafts(drafts);
    if (draftBytes(text) > 3_000_000)
      throw Error("本页暂存超过 3 MB，请下载副本保留修改");
    this.storage.setItem(EDITOR_DRAFT_KEY, text);
  }
}
