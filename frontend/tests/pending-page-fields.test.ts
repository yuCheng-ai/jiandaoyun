// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import PendingPageFields from "../src/features/data/PendingPageFields.vue";
import { platformApi } from "../src/repositories/platformApi";
vi.mock("../src/repositories/platformApi", () => ({ platformApi: vi.fn() }));
let app: ReturnType<typeof createApp> | undefined;
const props = reactive({ definitionId: "object", applicationId: "app", revision: 2 });
const result = { definitionId: "object", pages: [{ id: "page", title: "质检页面", revision: 3, definitionVersion: 1, fields: [{ id: "conclusion", name: "检验结论", kind: "text" }, { id: "note", name: "明细备注", kind: "text", parentId: "lines", parentName: "处理明细" }], warnings: ["数据结构已变化，请检查"] }] };
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
function mount() {
  app = createApp({ render: () => h(PendingPageFields, props) });
  app.component("RouterLink", defineComponent({ props: ["to"], setup(p, { slots }) { return () => h("a", { href: p.to.path + (p.to.query.field ? `?field=${p.to.query.field}` : "") }, slots.default?.()); } }));
  app.mount("#mount"); return settle();
}
beforeEach(() => { props.definitionId = "object"; props.revision = 2; document.body.innerHTML = '<div id="mount"></div>'; vi.mocked(platformApi).mockReset().mockResolvedValue(structuredClone(result)); });
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
it("shows saved page additions separately, preserves ownership and links to the selected source field", async () => {
  await mount(); expect(document.body.textContent).toContain("尚未保存的输入只保留在编辑页面中");
  expect(document.body.textContent).toContain("处理明细 · 明细列"); expect(document.body.textContent).toContain("数据结构已变化");
  expect(document.querySelector('a[href="/applications/app/pages/page/design?field=note"]')?.textContent).toBe("明细备注");
  expect(vi.mocked(platformApi).mock.calls).toEqual([["/data-objects/object/pending-page-fields"]]);
});
it("switching objects ignores a late response and refresh never displays the previous object's fields", async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(platformApi).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await mount(); props.definitionId = "another"; await settle();
  vi.mocked(platformApi).mockResolvedValueOnce({ definitionId: "another", pages: [] });
  props.revision++; await settle();
  resolveOld(structuredClone(result)); await settle();
  expect(document.body.textContent).not.toContain("检验结论"); expect(document.body.textContent).toContain("没有已保存的页面新增字段");
});
it("fetch errors remain explicit and can be retried without any mutation", async () => {
  vi.mocked(platformApi).mockRejectedValueOnce(new Error("暂时无法读取")); await mount();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("暂时无法读取");
  [...document.querySelectorAll("button")].find(button => button.textContent === "重试")!.click(); await settle();
  expect(document.body.textContent).toContain("检验结论");
  expect(vi.mocked(platformApi).mock.calls.every(call => call[1] === undefined)).toBe(true);
});
