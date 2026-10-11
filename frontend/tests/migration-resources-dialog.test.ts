// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import MigrationResourcesDialog from "../src/features/collaboration/MigrationResourcesDialog.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
import { readMigrationIdentities } from "../src/repositories/migrationIdentities";
import { readMigrationResources } from "../src/repositories/migrationResources";
vi.mock("vue-router", () => ({ onBeforeRouteLeave: vi.fn() }));
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import("../src/repositories/platformApi")>(), platformApi: vi.fn() }));
vi.mock("../src/repositories/migrationIdentities", () => ({ readMigrationIdentities: vi.fn() }));
vi.mock("../src/repositories/migrationResources", () => ({ readMigrationResources: vi.fn() }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ["open", "title"], setup(props, { slots }) { return () => props.open ? h("section", [slots.default?.(), slots.footer?.()]) : null; } }) }));
let app: ReturnType<typeof createApp> | undefined, saved: any, source: any, batch: any;
const result = () => ({ id: "snapshot", revision: 1, batchId: "batch", batchRevision: 2, sourceFingerprint: "a", current: true, identityConfirmed: false, importAvailable: false, totals: { forms: 1, archivedForms: 1, versions: 2, records: 1, deletedRecords: 1, rows: 1, historyEvents: 2 }, forms: [{ sourceId: "old-form", title: "历史表单", archived: true, draftChecked: true, definitionId: "new-object", pageId: "new-page", versions: [{ sourceVersion: 1, targetVersion: 1, variants: 1, checked: true }, { sourceVersion: 2, targetVersion: 2, variants: 1, checked: true }] }], records: [{ sourceId: "old-record", formId: "old-form", targetId: "new-record", version: 1, status: "approved", deleted: true, checked: true, rows: [{ fieldId: "lines", index: 0, targetId: "new-row" }] }], issues: [{ formId: "old-form", version: "V1", kind: "unsupported", message: "原流程仍待转换" }] });
async function settle() { for (let i = 0; i < 25; i++) await nextTick(); }
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name)!;
async function click(name: string) { button(name).click(); await settle(); }
async function mount() { app = createApp({ render: () => h(MigrationResourcesDialog, { appId: "oa", batchId: "batch" }) }); app.mount("#mount"); await settle(); }
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>'; saved = null; source = { fingerprint: "a", applicationId: "oa", records: "本应用原值" }; batch = { revision: 2, source: { fingerprint: "a", applicationId: "oa", applicationName: "旧应用" } };
  vi.mocked(readMigrationIdentities).mockReset().mockImplementation(async () => ({ fingerprint: source.fingerprint }) as any);
  vi.mocked(readMigrationResources).mockReset().mockImplementation(async () => structuredClone(source));
  vi.mocked(platformApi).mockReset().mockImplementation(async (path, method) => { if (method === "POST") { saved = result(); return structuredClone(saved); } return path.endsWith("/resources") ? { plan: saved && structuredClone(saved) } : structuredClone(batch); });
});
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
it("opening never uploads values; explicit snapshot checking sends source and revision guards", async () => {
  await mount(); expect(readMigrationResources).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("尚未保存历史数据快照");
  await click("保存快照并检查"); const call = vi.mocked(platformApi).mock.calls.find(call => call[1] === "POST")!;
  expect(call[2]).toMatchObject({ expectedBatchRevision: 2, expectedResourceRevision: 0, source }); expect(document.body.textContent).toContain("未创建业务应用、记录或权限");
  await click("表单与版本"); expect(document.body.textContent).toContain("原 V1 → 目标 V1");
  await click("记录与明细"); expect(document.body.textContent).toContain("原已删除"); expect(document.body.textContent).toContain("old-record"); expect(document.body.textContent).not.toContain("本应用原值");
});
it("a changed local source prevents upload and leaves the prior result visibly stale", async () => {
  saved = result(); await mount(); source.fingerprint = "b"; await click("保存快照并检查");
  expect(vi.mocked(platformApi).mock.calls.some(call => call[1] === "POST")).toBe(false); expect(document.body.textContent).toContain("以下是上次检查结果"); expect(button("保存快照并检查").disabled).toBe(true);
});
it("failed checks keep prior results and retries reuse command identity", async () => {
  saved = result(); await mount(); const original = vi.mocked(platformApi).getMockImplementation()!; let first = true;
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => { if (method === "POST" && first) { first = false; throw new PlatformError("网络中断", 0); } return original(path, method, body); });
  await click("保存快照并检查"); expect(document.body.textContent).toContain("网络中断"); expect(document.body.textContent).toContain("检查第 1 版");
  await click("保存快照并检查"); const calls = vi.mocked(platformApi).mock.calls.filter(call => call[1] === "POST"); expect(calls[0][2]).toEqual(calls[1][2]);
});
it("concurrent identity changes require rereading the server batch", async () => {
  await mount(); const original = vi.mocked(platformApi).getMockImplementation()!;
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => { if (method === "POST") throw new PlatformError("迁移批次或资源检查已更新", 409); return original(path, method, body); });
  await click("保存快照并检查"); expect(document.body.textContent).toContain("已更新"); batch.revision = 3; await click("重新读取检查"); await click("保存快照并检查");
  const calls = vi.mocked(platformApi).mock.calls.filter(call => call[1] === "POST"); expect(calls.at(-1)![2]).toMatchObject({ expectedBatchRevision: 3 });
});

const accessResult = () => ({ formId: "old-form", checked: false, membersEnabled: true, publicEnabled: false, allowMerged: false, filling: { enabled: false, startsAt: "2025-01-01T08:00", endsAt: "", limit: 8, allowRepeat: false }, executionReady: false, groups: [
  { id: "export-group", name: "仓库导出组", enabled: true, archived: false, checked: false, actions: ["view", "export"], scope: "department", subjects: 2, mappedSubjects: 1, historicalSubjects: 1, fields: 4, filters: 1 },
  { id: "create-group", name: "原仅添加组", enabled: false, archived: true, checked: true, actions: ["create"], scope: "all", subjects: 1, mappedSubjects: 1, historicalSubjects: 0, fields: 0, filters: 0 },
] });
it("shows distinct group actions and collection controls without claiming execution, and locates group issues", async () => {
  saved = { ...result(), access: [accessResult()] }; saved.issues.push({ formId: "old-form", version: "访问权限", kind: "invalid", groupId: "export-group", fieldId: "missing", message: "权限字段需核对" });
  await mount(); await click("权限与收集");
  expect(document.body.textContent).toContain("选择一个权限组，不叠加多个组"); expect(document.body.textContent).toContain("原公开入口：关闭");
  expect(document.body.textContent).toContain("上限：8"); expect(document.body.textContent).toContain("重复填写：不允许"); expect(document.body.textContent).toContain("尚未接入执行");
  expect(document.body.textContent).toContain("仓库导出组"); expect(document.body.textContent).toContain("操作：查看、导出"); expect(document.body.textContent).toContain("记录创建部门");
  expect(document.body.textContent).toContain("操作：添加"); expect(document.body.textContent).toContain("历史身份只保留来源");
  await click("查看本组待处理项"); expect(document.body.textContent).toContain("权限字段需核对"); expect(document.body.textContent).toContain("仓库导出组"); expect(document.body.textContent).not.toContain("原流程仍待转换");
  expect(document.querySelector<HTMLInputElement>('input[aria-label="搜索历史数据检查"]')!.value).toBe("");
  expect(document.body.textContent).toContain("权限组：仓库导出组");
  await click("取消权限组筛选"); expect(document.body.textContent).toContain("原流程仍待转换");
  expect(readMigrationResources).not.toHaveBeenCalled();
});
it("old snapshots explicitly require a new check and malformed settings never look enabled or unrestricted", async () => {
  saved = result(); await mount(); await click("权限与收集"); expect(document.body.textContent).toContain("这份历史检查尚未包含权限组转换");
  saved.access = [{ ...accessResult(), membersEnabled: null, publicEnabled: null, allowMerged: null, filling: null, groups: [] }]; await click("重新读取检查");
  expect(document.body.textContent).toContain("原成员入口：需核对"); expect(document.body.textContent).toContain("合并规则需核对"); expect(document.body.textContent).toContain("未按默认规则放行");
  expect(vi.mocked(platformApi).mock.calls.some(call => call[1] === "POST")).toBe(false);
});
it("large group inventories paginate by group and support name searching without losing archived groups", async () => {
  const item = accessResult(); item.groups = Array.from({ length: 20 }, (_, i) => ({ ...item.groups[1], id: `g-${i}`, name: `归档组${String(i).padStart(2, '0')}` })); saved = { ...result(), access: [item] };
  await mount(); await click("权限与收集"); expect(document.body.textContent).toContain("共 21 项"); expect(document.body.textContent).not.toContain("归档组19");
  await click("下一页"); expect(document.body.textContent).toContain("归档组19");
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索历史数据检查"]')!; input.value = "归档组01"; input.dispatchEvent(new Event("input")); await settle();
  expect(document.body.textContent).toContain("共 1 项"); expect(document.body.textContent).toContain("原归档：是"); expect(document.body.textContent).not.toContain("归档组19");
});
