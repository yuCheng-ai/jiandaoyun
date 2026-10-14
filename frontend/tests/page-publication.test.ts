import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { separateFormSchema, type PageEditorData, type PagePublishImpact } from "@platform/contracts";
import { createField, emptySchema } from "../src/domain/form";
import { usePageDesignerStore } from "../src/stores/pageDesigner";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
const split = separateFormSchema({ ...emptySchema(), fields: [createField("text", { id: "name", label: "名称" })] });
const source: PageEditorData = { model: split.model, object: { id: "object", title: "业务", revision: 2, latestVersion: 1, model: split.model }, draft: { id: "page", title: "填写页", definitionId: "object", definitionVersion: 1, revision: 1, latestVersion: 1, schema: split.page, additions: [], baseDefinitionRevision: null } };
let saved: PageEditorData;
beforeEach(() => {
  setActivePinia(createPinia()); saved = structuredClone(source); vi.mocked(platformApi).mockReset();
  vi.mocked(platformApi).mockImplementation(async (path, method, body: any) => {
    if (path.endsWith("/editor")) return structuredClone(saved);
    if (method === "PUT") { saved.draft = { ...saved.draft, ...body, revision: saved.draft.revision + 1 }; return structuredClone(saved.draft); }
    if (path.endsWith("/publish-preview")) return { pageId: "page", revision: saved.draft.revision, token: "reviewed" };
    if (path.endsWith("/publish")) { saved.draft.latestVersion++; saved.draft.revision++; return { editor: structuredClone(saved) }; }
    throw new Error(`Unexpected ${path}`);
  });
});
it("preparing review saves the draft only; explicit confirmation sends the reviewed token", async () => {
  const store = usePageDesignerStore(); await store.load("page"); store.state.title = "更新后的页面";
  const impact = await store.preparePublication(); expect(impact?.revision).toBe(2); expect(store.dirty).toBe(false);
  expect(vi.mocked(platformApi).mock.calls.some(call => call[0].endsWith("/publish"))).toBe(false);
  expect(await store.publish(impact!)).toBe(true);
  expect(vi.mocked(platformApi).mock.calls.find(call => call[0].endsWith("/publish"))?.[2]).toEqual({ expectedRevision: 2, impactToken: "reviewed" });
});
it("editing after review cannot publish an unreviewed schema", async () => {
  const store = usePageDesignerStore(); await store.load("page"); const impact = await store.preparePublication();
  store.state.schema.fields[0]!.label = "尚未检查的修改";
  expect(await store.publish(impact!)).toBe(false); expect(store.error).toContain("重新检查");
  expect(vi.mocked(platformApi).mock.calls.some(call => call[0].endsWith("/publish"))).toBe(false);
});
it("name conflicts and server review failures retain local edits and never publish", async () => {
  const store = usePageDesignerStore(); await store.load("page"); store.state.schema.fields.push(createField("text", { id: "duplicate", label: "名称" }));
  expect(await store.preparePublication()).toBeUndefined(); expect(store.error).toContain("同名"); expect(store.state.schema.fields).toHaveLength(2);
  expect(vi.mocked(platformApi).mock.calls).toHaveLength(1);
  store.state.schema.fields.pop();
  vi.mocked(platformApi).mockRejectedValueOnce(new PlatformError("数据模型已更新", 409));
  expect(await store.preparePublication()).toBeUndefined(); expect(store.error).toBe("数据模型已更新");
  expect(saved.draft.latestVersion).toBe(1);
});
it("discarding a saved page draft replaces state and resets editing history without saving current input", async () => {
  const store = usePageDesignerStore(); await store.load("page");
  store.state.title = "未保存名称";
  store.state.schema.fields.push(createField("text", { id: "pending", label: "待放弃" }));
  vi.mocked(platformApi).mockResolvedValueOnce({ ...structuredClone(source), draft: { ...structuredClone(source.draft), revision: 2 } });
  expect(await store.discardDraft()).toBe(true);
  expect(vi.mocked(platformApi).mock.calls.at(-1)).toEqual(["/pages/page/discard-draft", "POST", { expectedRevision: 1 }]);
  expect(vi.mocked(platformApi).mock.calls.some(call => call[1] === "PUT")).toBe(false);
  expect(store.state.title).toBe("填写页"); expect(store.state.schema.fields).toHaveLength(1);
  expect(store.dirty).toBe(false); expect(store.editorEpoch).toBe(1);
});
it("discard conflicts preserve current input and do not reset editing history", async () => {
  const store = usePageDesignerStore(); await store.load("page"); store.state.title = "保留输入";
  vi.mocked(platformApi).mockRejectedValueOnce(new PlatformError("页面草稿已被修改", 409));
  expect(await store.discardDraft()).toBe(false); expect(store.state.title).toBe("保留输入");
  expect(store.dirty).toBe(true); expect(store.editorEpoch).toBe(0); expect(store.error).toContain("已被修改");
});
