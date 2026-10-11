import { computed, ref, shallowRef, type Ref } from "vue";
import { copy } from "../domain/form";
import { copyFormDesign } from "../domain/formCopy";
import type { FormRecord, WorkspaceData } from "../domain/workspace";
import {
  sameWorkspaceValue,
  workspaceReadIsLossless,
} from "../domain/workspaceSync";
import {
  businessSnapshot,
  retainWorkspaceObjects,
  scopeUnchanged,
  type WorkspaceScope,
} from "../domain/workspaceTransactions";
import { useEditorDraftStore } from "./editorDrafts";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
  WorkspaceConflictError,
} from "../repositories/workspaceRepository";

/** Keeps failed transaction snapshots separate from committed data and editable drafts. */
export function workspacePersistence(
  repository: LocalWorkspaceRepository,
  data: Ref<WorkspaceData>,
  drafts: Ref<Record<string, FormRecord>>,
  initialError: string,
  notify: (message: string, type?: string) => void,
  normalize: (workspace: WorkspaceData) => void,
) {
  const editorDrafts = useEditorDraftStore();
  const storageError = ref(initialError);
  const storageConflict = ref(false);
  const recoveryOpen = ref(false);
  const storageChanges = ref<string[]>([]);
  let baseline = copy(data.value);
  const draftBases: Record<string, FormRecord> = {};
  const storageErrorContext = ref("");
  const currentContext = () =>
    typeof location === "undefined" ? "" : location.hash;
  function reportError(message: string) {
    storageError.value = message;
    storageErrorContext.value = currentContext();
  }
  function rememberDraft(id: string) {
    const saved = data.value.forms.find((f) => f.id === id);
    if (saved) draftBases[id] = copy(saved);
  }
  const failedSave = shallowRef<{ at: string; workspace: WorkspaceData }>();
  const recovered = new Map<
    string,
    { fingerprint: string; form: FormRecord }
  >();

  // Storage/focus events are informational. Merely having another tab is not a save failure.
  function checkStorageChanges() {
    try {
      return repository.hasExternalChange();
    } catch {
      return true;
    }
  }

  function latestSnapshot() {
    if (initialError) throw Error(initialError);
    if (!repository.hasExternalChange()) return { next: baseline };
    const raw = repository.latestRaw();
    if (!raw) throw new WorkspaceConflictError();
    const next = parseWorkspace(raw);
    if (!workspaceReadIsLossless(JSON.parse(raw), next))
      throw new WorkspaceConflictError();
    normalize(next);
    if (
      !sameWorkspaceValue(
        businessSnapshot(baseline),
        businessSnapshot(data.value),
      )
    )
      throw new WorkspaceConflictError();
    return { next, raw };
  }
  function adopt(next: WorkspaceData, raw?: string) {
    if (!raw) return;
    repository.adoptSnapshot(raw);
    data.value = retainWorkspaceObjects(data.value, next);
    baseline = copy(next);
  }
  /** Navigation reads current committed content, while existing editor objects retain their baseline. */
  function refreshForRead() {
    try {
      const { next, raw } = latestSnapshot();
      adopt(next, raw);
      // Read-only visits may create a cached design. Only genuinely edited
      // drafts retain their older baseline; clean caches follow saved content.
      for (const [id, draft] of Object.entries(drafts.value)) {
        const base = draftBases[id];
        if (!base || !sameWorkspaceValue(draft, base)) continue;
        const saved = data.value.forms.find((form) => form.id === id);
        if (!saved || sameWorkspaceValue(draft, saved)) continue;
        for (const key of Object.keys(draft))
          if (!(key in saved)) delete (draft as any)[key];
        Object.assign(draft, copy(saved));
        rememberDraft(id);
      }
      // A successful new read finishes the previous save-error context. Editor
      // baselines and failed candidates remain intact for their own retry checks.
      storageError.value = "";
      storageConflict.value = false;
      storageChanges.value = [];
      return true;
    } catch {
      return false;
    }
  }

  function prepareWrite(scope: WorkspaceScope) {
    storageConflict.value = false;
    storageChanges.value = [];
    storageError.value = "";
    try {
      const { next, raw } = latestSnapshot();
      const unchanged = scopeUnchanged(scope, baseline, next, draftBases);
      if (!unchanged) {
        storageChanges.value = [scope.label?.(next) || "当前正在修改的内容"];
        throw new WorkspaceConflictError();
      }
      adopt(next, raw);
    } catch (error) {
      // Keep the action's existing rollback/failed-attempt handling, but disallow its commit.
      storageConflict.value = true;
      reportError(
        error instanceof Error ? error.message : "无法读取最新内容，请重试。",
      );
    }
  }

  function persist() {
    try {
      if (initialError)
        throw Error(
          "原始本地数据无法读取，请先保留副本；当前示例不能覆盖原始数据。",
        );
      if (storageConflict.value) throw new WorkspaceConflictError();
      repository.save(data.value);
      baseline = copy(data.value);
      storageError.value = "";
      failedSave.value = undefined;
      return true;
    } catch (error) {
      if (error instanceof WorkspaceConflictError) storageConflict.value = true;
      // Capture before the caller rolls back record, payment, publish or dialog actions.
      failedSave.value = {
        at: new Date().toISOString(),
        workspace: copy(data.value),
      };
      reportError(
        error instanceof Error ? error.message : "保存未完成，请重试。",
      );
      notify(storageError.value, "warning");
      return false;
    }
  }

  function inspectLatest() {
    try {
      const raw = repository.latestRaw();
      return {
        raw,
        workspace: raw === null ? null : parseWorkspace(raw),
        error: "",
      };
    } catch (error) {
      return {
        raw: undefined,
        workspace: null,
        error: error instanceof Error ? error.message : "无法读取最新数据",
      };
    }
  }

  const recoveryCandidates = computed(() => {
    const candidates: { key: string; source: string; form: FormRecord }[] = [];
    for (const form of Object.values(drafts.value)) {
      const saved = data.value.forms.find((f) => f.id === form.id);
      if (JSON.stringify(form) !== JSON.stringify(saved))
        candidates.push({
          key: `draft:${form.id}`,
          source: "当前设计草稿",
          form,
        });
    }
    for (const form of failedSave.value?.workspace.forms || []) {
      const saved = data.value.forms.find((f) => f.id === form.id);
      if (
        JSON.stringify(form) !== JSON.stringify(saved) &&
        !candidates.some((c) => JSON.stringify(c.form) === JSON.stringify(form))
      )
        candidates.push({
          key: `attempt:${form.id}`,
          source: "最近保存尝试",
          form,
        });
    }
    return candidates;
  });

  function exportRecovery() {
    let latestRaw: string | null | undefined,
      latestReadError = "";
    try {
      latestRaw = repository.latestRaw();
    } catch {
      latestReadError = "导出时无法读取存储；本文件仍保留当前页面内容。";
    }
    return JSON.stringify(
      {
        format: "workflow-studio-recovery-v1",
        exportedAt: new Date().toISOString(),
        note: "恢复副本，不是已提交数据。attempt 中的发布、支付和记录操作均未保存成功。页面表单内尚未尝试保存的输入可能未包含在内。",
        baselineRaw: repository.baselineRaw(),
        latestRaw,
        latestReadError,
        currentWorkspace: data.value,
        formDrafts: drafts.value,
        editorDrafts: editorDrafts.entries,
        attempt: failedSave.value,
      },
      null,
      2,
    );
  }

  function recoverDesign(key: string): FormRecord | undefined {
    const candidate = recoveryCandidates.value.find((c) => c.key === key);
    if (!candidate) return;
    const fingerprint = JSON.stringify(candidate.form);
    const previous = recovered.get(key);
    try {
      // Use a separate fresh baseline. Never rebase the old page or overwrite an existing form.
      const latestRepository = new LocalWorkspaceRepository();
      const latest = latestRepository.load();
      if (!latest) throw Error("本地工作空间已被清除，请先下载本页副本。");
      if (
        previous?.fingerprint === fingerprint &&
        latest.forms.some((f) => f.id === previous.form.id && !f.archived)
      )
        return previous.form;
      if (latest.forms.length >= 500)
        throw Error("工作空间已达到 500 个表单，请先下载副本。");
      const app = latest.apps.find((a) => a.id === candidate.form.appId);
      if (!app)
        throw Error("原应用已不存在，请先下载副本，稍后手动恢复到其他应用。");
      const restored = copyFormDesign(
        candidate.form,
        `${candidate.form.title} · 恢复副本`,
      );
      if (!app.folders.includes(restored.folder)) restored.folder = "";
      latest.forms.unshift(restored);
      latestRepository.save(latest);
      recovered.set(key, { fingerprint, form: restored });
      storageConflict.value = true;
      storageError.value =
        "设计已另存到最新工作空间；本页仍保留旧数据，请在新页面继续。";
      notify("已另存为未发布表单，原表单和业务数据保持不变");
      return restored;
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "另存失败，请先下载副本",
        "warning",
      );
      return;
    }
  }

  return {
    storageError,
    storageErrorContext,
    reportError,
    rememberDraft,
    prepareWrite,
    refreshForRead,
    storageConflict,
    storageChanges,
    recoveryOpen,
    failedSave,
    recoveryCandidates,
    checkStorageChanges,
    persist,
    inspectLatest,
    exportRecovery,
    recoverDesign,
  };
}
