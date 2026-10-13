import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  PageDraft,
  PageEditorData,
  PublishedDataModel,
  PagePublishImpact,
} from "@platform/contracts";
import { copy, emptySchema } from "../domain/form";
import {
  adoptPageModel,
  pageEditingState,
  pageUpdate,
  pageFieldConflicts,
  type PageEditingState,
} from "../domain/pageDesigner";
import { platformApi } from "../repositories/platformApi";

export const usePageDesignerStore = defineStore("server-page-designer", () => {
  const data = ref<PageEditorData>();
  const state = ref<PageEditingState>({ title: "", schema: emptySchema() });
  const saved = ref("");
  const busy = ref(false);
  const error = ref("");
  const feedback = ref("");
  const editorEpoch = ref(0);
  let requestId = 0;

  function fingerprint(editingState: PageEditingState, draft: PageDraft) {
    return JSON.stringify({
      state: editingState,
      version: draft.definitionVersion,
      baseRevision: draft.baseDefinitionRevision,
    });
  }

  const dirty = computed(() => {
    if (!data.value) return false;
    return fingerprint(state.value, data.value.draft) !== saved.value;
  });

  function accept(result: PageEditorData) {
    // 先完成解析再替换页面，避免解析失败时留下半更新的编辑状态。
    const editingState = pageEditingState(result);
    data.value = result;
    state.value = editingState;
    saved.value = fingerprint(editingState, result.draft);
  }

  async function load(id: string) {
    // 切换页面后，旧请求的结果、错误和 busy 状态都不再属于当前编辑器。
    const currentRequest = ++requestId;
    busy.value = true;
    error.value = "";
    feedback.value = "";
    data.value = undefined;
    try {
      const result = await platformApi<PageEditorData>(`/pages/${id}/editor`);
      if (currentRequest !== requestId) return;
      accept(result);
    } catch (cause) {
      if (currentRequest === requestId) error.value = (cause as Error).message;
    } finally {
      if (currentRequest === requestId) busy.value = false;
    }
  }

  async function save() {
    const page = data.value;
    if (!page || busy.value) return false;
    const currentRequest = ++requestId;
    const submittedState = copy(state.value);
    busy.value = true;
    error.value = "";
    try {
      if (pageFieldConflicts(page, submittedState).length) {
        throw new Error("存在同名新增字段，请先选择复用已有字段或更名");
      }
      const draft = await platformApi<PageDraft>(
        `/pages/${page.draft.id}`,
        "PUT",
        pageUpdate(page, submittedState),
      );
      if (currentRequest !== requestId) return false;
      page.draft = draft;
      // 只将实际提交的内容标记为已保存，请求期间的新修改仍属于未保存内容。
      saved.value = fingerprint(submittedState, draft);
      return true;
    } catch (cause) {
      if (currentRequest === requestId) error.value = (cause as Error).message;
      return false;
    } finally {
      if (currentRequest === requestId) busy.value = false;
    }
  }

  async function preparePublication() {
    const page = data.value;
    if (!page || busy.value) return;
    if (dirty.value && !(await save())) return;
    if (data.value !== page || busy.value) return;
    if (dirty.value) {
      error.value = "页面已变化，请重新检查发布内容";
      return;
    }
    const currentRequest = ++requestId;
    busy.value = true;
    error.value = "";
    try {
      const impact = await platformApi<PagePublishImpact>(
        `/pages/${page.draft.id}/publish-preview`,
        "POST",
        { expectedRevision: page.draft.revision },
      );
      if (currentRequest !== requestId) return;
      return impact;
    } catch (cause) {
      if (currentRequest === requestId) error.value = (cause as Error).message;
    } finally {
      if (currentRequest === requestId) busy.value = false;
    }
  }

  async function discardDraft() {
    const page = data.value;
    if (!page || busy.value) return false;
    const currentRequest = ++requestId;
    busy.value = true;
    error.value = "";
    feedback.value = "";
    try {
      const result = await platformApi<PageEditorData>(
        `/pages/${page.draft.id}/discard-draft`,
        "POST",
        { expectedRevision: page.draft.revision },
      );
      if (currentRequest !== requestId) return false;
      accept(result);
      feedback.value = `已恢复表单 V${result.draft.latestVersion}，已有记录保持原样。`;
      editorEpoch.value++;
      return true;
    } catch (cause) {
      if (currentRequest === requestId) error.value = (cause as Error).message;
      return false;
    } finally {
      if (currentRequest === requestId) busy.value = false;
    }
  }

  async function publish(impact: PagePublishImpact) {
    const page = data.value;
    if (!page || busy.value) return false;
    if (
      dirty.value ||
      impact.pageId !== page.draft.id ||
      impact.revision !== page.draft.revision
    ) {
      error.value = "页面已变化，请重新检查发布内容";
      return false;
    }
    const currentRequest = ++requestId;
    busy.value = true;
    error.value = "";
    try {
      await platformApi(`/pages/${page.draft.id}/publish`, "POST", {
        expectedRevision: impact.revision,
        impactToken: impact.token,
      });
      if (currentRequest !== requestId) return false;
      const result = await platformApi<PageEditorData>(
        `/pages/${page.draft.id}/editor`,
      );
      if (currentRequest !== requestId) return false;
      accept(result);
      return true;
    } catch (cause) {
      if (currentRequest === requestId) error.value = (cause as Error).message;
      return false;
    } finally {
      if (currentRequest === requestId) busy.value = false;
    }
  }

  function adopt(latest: PublishedDataModel) {
    if (!data.value || busy.value) return false;
    error.value = "";
    try {
      const updated = adoptPageModel(data.value, state.value, latest);
      data.value = updated.data;
      state.value = updated.state;
      editorEpoch.value++;
      return true;
    } catch (cause) {
      error.value = (cause as Error).message;
      return false;
    }
  }

  return {
    data,
    state,
    busy,
    error,
    feedback,
    dirty,
    editorEpoch,
    load,
    save,
    preparePublication,
    publish,
    adopt,
    discardDraft,
  };
});
