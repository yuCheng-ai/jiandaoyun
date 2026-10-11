import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { PageDraft, PageEditorData, PublishedDataModel, PagePublishImpact } from "@platform/contracts";
import { emptySchema } from "../domain/form";
import { adoptPageModel, pageEditingState, pageUpdate, pageFieldConflicts, type PageEditingState } from "../domain/pageDesigner";
import { platformApi } from "../repositories/platformApi";

export const usePageDesignerStore = defineStore("server-page-designer", () => {
  const data = ref<PageEditorData>();
  const state = ref<PageEditingState>({ title: "", schema: emptySchema() });
  const saved = ref(""), busy = ref(false), error = ref(""), feedback = ref(""), editorEpoch = ref(0);
  const fingerprint = () => JSON.stringify({ state: state.value, version: data.value?.draft.definitionVersion, baseRevision: data.value?.draft.baseDefinitionRevision });
  const dirty = computed(() => !!data.value && fingerprint() !== saved.value);
  const accept = (result: PageEditorData) => {
    data.value = result; state.value = pageEditingState(result); saved.value = fingerprint();
  };
  async function load(id: string) {
    busy.value = true; error.value = ""; feedback.value = ""; data.value = undefined;
    try { accept(await platformApi<PageEditorData>(`/pages/${id}/editor`)); }
    catch (cause) { error.value = (cause as Error).message; }
    finally { busy.value = false; }
  }
  async function save() {
    if (!data.value || busy.value) return false;
    busy.value = true; error.value = "";
    try {
      if (pageFieldConflicts(data.value, state.value).length) throw new Error("存在同名新增字段，请先选择复用已有字段或更名");
      const draft = await platformApi<PageDraft>(`/pages/${data.value.draft.id}`, "PUT", pageUpdate(data.value, state.value));
      data.value.draft = draft; saved.value = fingerprint();
      return true;
    } catch (cause) { error.value = (cause as Error).message; return false; }
    finally { busy.value = false; }
  }
  async function preparePublication() {
    if (!data.value || busy.value) return;
    if (dirty.value && !(await save())) return;
    busy.value = true; error.value = "";
    try { return await platformApi<PagePublishImpact>(`/pages/${data.value.draft.id}/publish-preview`, "POST", { expectedRevision: data.value.draft.revision }); }
    catch (cause) { error.value = (cause as Error).message; }
    finally { busy.value = false; }
  }
  async function discardDraft() {
    if (!data.value || busy.value) return false;
    busy.value = true; error.value = ""; feedback.value = "";
    try {
      accept(await platformApi<PageEditorData>(`/pages/${data.value.draft.id}/discard-draft`, "POST", { expectedRevision: data.value.draft.revision }));
      feedback.value = `已恢复页面 V${data.value.draft.latestVersion}，共享数据和其他页面保持原样。`;
      editorEpoch.value++;
      return true;
    } catch (cause) { error.value = (cause as Error).message; return false; }
    finally { busy.value = false; }
  }
  async function publish(impact: PagePublishImpact) {
    if (!data.value || busy.value) return false;
    if (dirty.value || impact.pageId !== data.value.draft.id || impact.revision !== data.value.draft.revision) { error.value = "页面已变化，请重新检查发布内容"; return false; }
    busy.value = true; error.value = "";
    try {
      await platformApi(`/pages/${data.value.draft.id}/publish`, "POST", { expectedRevision: impact.revision, impactToken: impact.token });
      accept(await platformApi<PageEditorData>(`/pages/${data.value.draft.id}/editor`));
      return true;
    } catch (cause) { error.value = (cause as Error).message; return false; }
    finally { busy.value = false; }
  }
  function adopt(latest: PublishedDataModel) {
    if (!data.value || busy.value) return false;
    error.value = "";
    try {
      const updated = adoptPageModel(data.value, state.value, latest);
      data.value = updated.data; state.value = updated.state; editorEpoch.value++;
      return true;
    } catch (cause) { error.value = (cause as Error).message; return false; }
  }
  return { data, state, busy, error, feedback, dirty, editorEpoch, load, save, preparePublication, publish, adopt, discardDraft };
});
