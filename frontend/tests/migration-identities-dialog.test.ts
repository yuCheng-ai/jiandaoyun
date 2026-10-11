// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import type { MigrationBatch, MigrationIdentitySource } from "@platform/contracts";
import MigrationIdentityDialog from "../src/features/collaboration/MigrationIdentityDialog.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
import { readMigrationIdentities } from "../src/repositories/migrationIdentities";
vi.mock("vue-router", () => ({ onBeforeRouteLeave: vi.fn() }));
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import("../src/repositories/platformApi")>(), platformApi: vi.fn() }));
vi.mock("../src/repositories/migrationIdentities", () => ({ readMigrationIdentities: vi.fn() }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ["open", "title"], setup(props, { slots }) { return () => props.open ? h("section", { role: "dialog", "aria-label": props.title }, [slots.default?.(), slots.footer?.()]) : null; } }) }));
let app: ReturnType<typeof createApp> | undefined, current: MigrationBatch | undefined, source: MigrationIdentitySource;
const closed = vi.fn();
const directory = { revision: 1, users: [{ id: "server-a", name: "原成员", username: "admin", active: true }, { id: "server-b", name: "停用成员", username: "old", active: false }], spec: { departments: [], roles: [] } };
const makeBatch = (): MigrationBatch => ({ id: "batch", revision: 1, state: "draft", source: structuredClone(source), choices: [{ kind: "member", sourceId: "old-a", mode: "unresolved" }], updatedAt: "2026-10-09T00:00:00Z", confirmedAt: null });
async function settle() { for (let i = 0; i < 30; i++) await nextTick(); }
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name)!;
async function click(name: string) { button(name).click(); await settle(); }
async function mode(value: string) { const select = document.querySelector<HTMLSelectElement>('[aria-label="原成员对应方式"]')!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); await settle(); }
async function mount() { app = createApp({ render: () => h(MigrationIdentityDialog, { appId: "oa", onClose: closed }) }); app.mount("#mount"); await settle(); }
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>'; closed.mockReset(); vi.mocked(platformApi).mockReset(); vi.mocked(readMigrationIdentities).mockReset();
  source = { namespace: "source", applicationId: "oa", applicationName: "旧应用", fingerprint: "a".repeat(64), identities: [{ kind: "member", sourceId: "old-a", name: "原成员", found: true, active: true }], counts: { forms: 1, versions: 1, records: 2, rows: 0, issues: 1 } };
  current = makeBatch(); vi.mocked(readMigrationIdentities).mockImplementation(async () => structuredClone(source));
  vi.mocked(platformApi).mockImplementation(async (path, method, body: any) => {
    if (path === "/organization") return structuredClone(directory);
    if (path.endsWith("/events")) return [];
    if (path.includes("?namespace=")) return current ? [structuredClone(current)] : [];
    if (method === "PUT") { current = { ...current!, revision: current!.revision + 1, choices: JSON.parse(JSON.stringify(body.choices)) }; return structuredClone(current); }
    if (path.endsWith("/review")) return { token: "review", batchId: "batch", revision: current!.revision, counts: { existing: 0, historical: 1, unresolved: 0 }, items: [], blockers: [], confirmationCurrent: false };
    if (path.endsWith("/confirm-identities")) { current = { ...current!, state: "identities_confirmed", revision: current!.revision + 1 }; return structuredClone(current); }
    if (path.endsWith("/source")) { current = { ...current!, source: structuredClone(body.source), revision: current!.revision + 1 }; return structuredClone(current); }
    if (path === "/migration-batches" && method === "POST") { current = makeBatch(); return structuredClone(current); }
    throw new Error(`Unexpected ${method} ${path}`);
  });
});
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; });
it("opening is read-only; creation is explicit and names never auto-match", async () => {
  current = undefined; await mount();
  expect(vi.mocked(platformApi).mock.calls.every(call => !call[1])).toBe(true);
  await click("建立身份对应草稿"); expect(current!.choices[0].mode).toBe("unresolved");
  expect(document.body.textContent).toContain("同名身份没有自动关联");
});
it("choosing an existing inactive identity requires explicit picker confirmation and can be cancelled", async () => {
  await mount(); await mode("existing"); await click("请选择");
  const radio = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]; radio.click(); await settle();
  await click("取消"); await click("保存对应草稿"); expect(document.body.textContent).toContain("请选择现有身份");
  await click("请选择"); document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click(); await settle(); await click("确定"); await click("保存对应草稿");
  expect(current!.choices[0]).toMatchObject({ mode: "existing", targetId: "server-b" });
  expect(document.body.textContent).toContain("已停用");
});
it("save conflicts retain edits, reload requires discard, and closing prompts for unsaved work", async () => {
  await mount(); await mode("historical"); const original = vi.mocked(platformApi).getMockImplementation()!;
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => { if (method === "PUT") throw new PlatformError("身份对应已被修改", 409); return original(path, method, body); });
  await click("保存对应草稿"); expect(document.body.textContent).toContain("身份对应已被修改");
  await click("关闭"); expect(closed).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("对应决定尚未保存"); await click("继续编辑");
  await click("重新读取"); expect((document.querySelector('[aria-label="原成员对应方式"]') as HTMLSelectElement).value).toBe("historical");
  await click("放弃修改并读取"); expect((document.querySelector('[aria-label="原成员对应方式"]') as HTMLSelectElement).value).toBe("unresolved");
});
it("source changes invalidate confirmation and source refresh is explicit", async () => {
  current!.choices[0].mode = "historical"; await mount(); await click("检查身份对应"); source.fingerprint = "b".repeat(64);
  await click("确认本批次身份对应"); expect(current!.state).toBe("draft"); expect(document.body.textContent).toContain("来源内容已变化");
  expect(vi.mocked(platformApi).mock.calls.some(call => call[0].endsWith("/confirm-identities"))).toBe(false);
  await click("更新来源清单"); expect(current!.source.fingerprint).toBe("a".repeat(64));
  await click("更新来源并重新核对"); expect(current!.source.fingerprint).toBe(source.fingerprint);
});
it("review saves pending choices first and confirmation retries retain the same command identity", async () => {
  await mount(); await mode("historical"); await click("检查身份对应");
  const calls = vi.mocked(platformApi).mock.calls;
  expect(calls.findIndex(call => call[1] === "PUT")).toBeLessThan(calls.findIndex(call => call[0].endsWith("/review")));
  const original = vi.mocked(platformApi).getMockImplementation()!; let fail = true;
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => { if (path.endsWith("/confirm-identities") && fail) { fail = false; throw new PlatformError("连接暂时中断", 0); } return original(path, method, body); });
  await click("确认本批次身份对应"); expect(document.body.textContent).toContain("连接暂时中断"); await click("确认本批次身份对应");
  const confirmed = vi.mocked(platformApi).mock.calls.filter(call => call[0].endsWith("/confirm-identities")); expect(confirmed[0][2]).toEqual(confirmed[1][2]);
  expect(document.body.textContent).toContain("业务数据、权限和流程尚未导入"); expect(current!.state).toBe("identities_confirmed");
});
