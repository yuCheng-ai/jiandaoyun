// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { RecordDetail, RecordRelationGroup } from "@platform/contracts";
import RecordRelations from "../src/features/data/RecordRelations.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("../src/repositories/platformApi", async (original) => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ["open", "title"], setup(props, { slots }) { return () => props.open ? h("section", { "aria-label": props.title }, [slots.default?.(), slots.footer?.()]) : null; } }) }));
const detail = { page: { id: "page", version: 2, title: "业务页" }, definition: { schema: { fields: [] } }, record: { id: "source", revision: 1, values: {}, cellRevisions: { quantity: 1 } } } as unknown as RecordDetail;
const group = { relation: { id: "relation", latestVersion: 3, spec: { title: "业务资料", cardinality: "one" } }, direction: "outgoing", permission: "edit", canLink: true, links: [], columnLabels: {} } as unknown as RecordRelationGroup;
const candidatePage = { relationVersion: 3, nextCursor: null, columnLabels: { price: "金额" }, items: [{ recordId: "target", label: "资料 A", revision: 5, values: { price: 10 }, mappings: [{ fieldId: "quantity", label: "数量", before: 1, value: 10 }] }] };
let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => { vi.mocked(platformApi).mockReset(); document.body.innerHTML = '<div id="mount"></div>'; });
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
function button(name: string) { return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!; }
async function click(name: string) { button(name).click(); await settle(); }
async function mount(unsaved = false) {
  const state = ref(structuredClone(detail));
  app = createApp({ render: () => h(RecordRelations, { detail: state.value, unsaved, onUpdated: result => state.value = result }) });
  app.mount('#mount'); await settle(); return state;
}
it("blocks association while local record edits are unsaved", async () => {
  vi.mocked(platformApi).mockResolvedValue([group]);
  await mount(true);
  expect(button("选择关联记录").disabled).toBe(true);
  expect(document.body.textContent).toContain("请先保存当前字段和明细修改");
  await click("选择关联记录");
  expect(vi.mocked(platformApi).mock.calls).toHaveLength(1);
});
it("previews mappings and retries an uncertain write with the same command identity and page scope", async () => {
  const commands: any[] = [];
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => {
    if (method === "POST") { commands.push(body); throw new PlatformError("连接中断", 0); }
    return path.includes("candidates") ? candidatePage : [group];
  });
  await mount(); await click("选择关联记录");
  document.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); await settle();
  expect(document.body.textContent).toContain("数量：1 → 10");
  await click("确认关联"); await click("确认关联");
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toMatchObject({ pageVersion: 2, expectedRelationVersion: 3, expectedTargetRevision: 5, expectedCells: { quantity: 1 } });
  expect(vi.mocked(platformApi).mock.calls[1]![0]).toContain('/pages/page/records/source/relations/relation/candidates?version=2');
});
it("conflict recovery refreshes the source revision before constructing another association command", async () => {
  const commands: any[] = [], fresh = structuredClone(detail); fresh.record.revision = 2; fresh.record.cellRevisions.quantity = 2;
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => {
    if (method === "POST") { commands.push(body); if (commands.length === 1) throw new PlatformError("回填目标已被修改", 409); return { record: fresh }; }
    if (path.includes("candidates")) return candidatePage;
    if (path.includes("/relations")) return [group];
    return fresh;
  });
  const state = await mount(); await click("选择关联记录"); document.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); await settle(); await click("确认关联");
  await click("重新读取后选择"); expect(state.value.record.revision).toBe(2);
  document.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); await settle(); await click("确认关联");
  expect(commands[1].expectedCells.quantity).toBe(2); expect(commands[1].requestId).not.toBe(commands[0].requestId);
});
