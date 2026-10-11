import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { copy, uid } from "../domain/form";
import {
  checkedDraftValue,
  checkedEditorDraft,
  draftBytes,
  MAX_DRAFT_FILE_SIZE,
  draftFingerprint,
  contextFingerprint,
  MAX_EDITOR_DRAFTS,
  parseEditorDrafts,
  serializeEditorDrafts,
  type EditorDraft,
} from "../domain/editorDrafts";
import { EditorDraftRepository } from "../repositories/editorDraftRepository";

export interface DraftEditor {
  draftId?: () => string;
  flush?: () => void;
  active: () => boolean;
  key: () => string;
  context: () => string;
  value: () => unknown;
  restore: (value: unknown, draft?: EditorDraft) => void;
}
export interface DraftRestoreTicket {
  id: string;
  draft: string;
  current: string;
}
export const useEditorDraftStore = defineStore("editor-drafts", () => {
  const repository = new EditorDraftRepository();
  const entries = shallowRef<EditorDraft[]>([]),
    error = ref(""),
    loadError = ref(""),
    issues = ref<Record<string, string>>({}),
    selectedId = ref("");
  const editors = new Map<symbol, DraftEditor>();
  const revision = ref(0);
  let checkpoints: EditorDraft[] = [];
  try {
    checkpoints = repository.load();
    entries.value = copy(checkpoints);
  } catch (e) {
    error.value = (e as Error).message;
    loadError.value = error.value;
  }

  function register(editor: DraftEditor) {
    const id = Symbol();
    editors.set(id, editor);
    revision.value++;
    return () => {
      editors.delete(id);
      revision.value++;
    };
  }
  function changed() {
    revision.value++;
  }
  function capture(draft: EditorDraft) {
    try {
      const checked = checkedEditorDraft(draft);
      const previous = entries.value.find((d) => d.id === draft.id);
      if (previous && draftFingerprint(previous) === draftFingerprint(draft))
        return true;
      if (!previous && entries.value.length >= MAX_EDITOR_DRAFTS)
        throw Error("已有 50 份编辑暂存，请下载副本后整理");
      const next = [checked, ...entries.value.filter((d) => d.id !== draft.id)];
      if (draftBytes(serializeEditorDrafts(next)) > MAX_DRAFT_FILE_SIZE)
        throw Error("编辑暂存总量已达 15 MB，请先下载并整理已有暂存");
      entries.value = next;
      error.value = "";
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      issues.value[draft.key] = error.value;
      return false;
    }
  }
  function checkpoint(id: string) {
    const draft = entries.value.find((d) => d.id === id);
    if (!draft) return false;
    if (isCheckpoint(draft)) {
      delete issues.value[draft.key];
      return true;
    }
    try {
      const next = [copy(draft), ...checkpoints.filter((d) => d.id !== id)];
      repository.save(next);
      checkpoints = next;
      error.value = "";
      delete issues.value[draft.key];
      revision.value++;
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      issues.value[draft.key] = error.value;
      return false;
    }
  }
  function remove(id: string, sourceKey?: string) {
    const draft = entries.value.find((d) => d.id === id);
    if (
      !entries.value.some((d) => d.id === id) &&
      !checkpoints.some((d) => d.id === id)
    ) {
      if (sourceKey) delete issues.value[sourceKey];
      return true;
    }
    try {
      if (checkpoints.some((d) => d.id === id)) {
        const next = checkpoints.filter((d) => d.id !== id);
        repository.save(next);
        checkpoints = next;
      }
      entries.value = entries.value.filter((d) => d.id !== id);
      error.value = "";
      if (draft) delete issues.value[draft.key];
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      if (draft) issues.value[draft.key] = error.value;
      return false;
    }
  }
  function isCheckpoint(draft: EditorDraft) {
    void revision.value;
    return checkpoints.some(
      (d) =>
        d.id === draft.id && draftFingerprint(d) === draftFingerprint(draft),
    );
  }
  function editorFor(draft: EditorDraft) {
    void revision.value;
    return [...editors.values()].find(
      (e) =>
        e.active() &&
        e.key() === draft.key &&
        contextFingerprint(e.context()) === contextFingerprint(draft.context),
    );
  }
  function recoverable(key: string) {
    void revision.value;
    const current = new Set(
      [...editors.values()].filter((e) => e.active()).map((e) => e.draftId?.()),
    );
    return entries.value.filter((d) => d.key === key && !current.has(d.id));
  }
  function retryCapture(key: string) {
    for (const editor of editors.values())
      if (editor.active() && editor.key() === key) editor.flush?.();
  }
  function availability(draft: EditorDraft) {
    const editor = editorFor(draft);
    if (editor)
      return { ready: true, message: "可放回当前编辑器，保存前仍可修改" };
    const same = [...editors.values()].some(
      (e) => e.active() && e.key() === draft.key,
    );
    return {
      ready: false,
      message: same
        ? "表单结构、原配置或当前成员已变化，请下载内容对照处理"
        : "请先打开来源页面及对应编辑器，再返回这里恢复",
    };
  }
  function prepareRestore(id: string): DraftRestoreTicket | undefined {
    const draft = entries.value.find((d) => d.id === id);
    if (!draft) return;
    const editor = editorFor(draft);
    if (!editor) {
      error.value = availability(draft).message;
      return;
    }
    return {
      id,
      draft: draftFingerprint(draft),
      current: JSON.stringify(editor.value()),
    };
  }
  function restore(ticket: DraftRestoreTicket) {
    const draft = entries.value.find((d) => d.id === ticket.id);
    if (!draft) return false;
    const editor = editorFor(draft);
    if (!editor) {
      error.value = availability(draft).message;
      return false;
    }
    try {
      if (
        draftFingerprint(draft) !== ticket.draft ||
        JSON.stringify(editor.value()) !== ticket.current
      )
        throw Error("确认期间内容已变化，请重新选择暂存后确认");
      editor.restore(checkedDraftValue(draft.value), draft);
      error.value = "";
      revision.value++;
      return true;
    } catch (e) {
      error.value = (e as Error).message || "内容不适用于当前编辑器";
      return false;
    }
  }
  function importDrafts(text: string) {
    try {
      const incoming = parseEditorDrafts(text),
        seen = new Set(entries.value.map(draftFingerprint));
      const added = incoming
        .filter((d) => {
          const f = draftFingerprint(d);
          if (seen.has(f)) return false;
          seen.add(f);
          return true;
        })
        .map((d) => ({ ...d, id: uid("draft") }));
      if (entries.value.length + added.length > MAX_EDITOR_DRAFTS)
        throw Error("导入后超过 50 份暂存，请先整理已有内容");
      const next = [...added, ...entries.value];
      if (draftBytes(serializeEditorDrafts(next)) > MAX_DRAFT_FILE_SIZE)
        throw Error("导入后超过 15 MB，请先下载并整理已有暂存");
      entries.value = next;
      error.value = "";
      return added.length;
    } catch (e) {
      error.value = (e as Error).message;
      return undefined;
    }
  }
  function exportDrafts() {
    return serializeEditorDrafts(entries.value);
  }
  return {
    entries,
    error,
    loadError,
    issues,
    selectedId,
    register,
    changed,
    capture,
    checkpoint,
    remove,
    isCheckpoint,
    availability,
    recoverable,
    retryCapture,
    prepareRestore,
    restore,
    importDrafts,
    exportDrafts,
  };
});
