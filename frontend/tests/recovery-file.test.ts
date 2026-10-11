// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import EditorDraftRecovery from "../src/features/workspace/EditorDraftRecovery.vue";
import { useEditorDraftStore } from "../src/stores/editorDrafts";

vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: () => ({
    notify: vi.fn(),
    writePending: false,
    recoveryOpen: true,
  }),
}));
const cleanups: (() => void)[] = [];
const draft = {
  id: "imported",
  key: "profile:zhang",
  title: "个人信息",
  path: "/",
  context: "{}",
  value: { name: "恢复内容", email: "", phone: "" },
  updatedAt: "2026-10-09T00:00:00Z",
};
const fileText = JSON.stringify({
  format: "workflow-studio-recovery-v1",
  editorDrafts: [draft],
  currentWorkspace: { mustNotApply: true },
  attempt: { mustNotReplay: true },
});
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
async function mount() {
  const pinia = createPinia(),
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () => null } }],
    });
  await router.push("/");
  const app = createApp(EditorDraftRecovery);
  app.use(pinia).use(router).mount(document.getElementById("app")!);
  cleanups.push(() => app.unmount());
  await nextTick();
  return useEditorDraftStore(pinia);
}
async function upload(text: string, size = text.length) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = { size, text: vi.fn().mockResolvedValue(text) };
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return file;
}
it("keeps the first file import receipt visible after automatic selection and deduplicates repeated files", async () => {
  const drafts = await mount();
  await upload(fileText);
  expect(drafts.entries).toHaveLength(1);
  expect(drafts.entries[0]!.value).toEqual(draft.value);
  expect(document.body.textContent).toContain(
    "已读取 1 份新暂存，尚未写入业务数据",
  );
  expect(document.body.textContent).toContain("此版本仅保留在本页内存中");
  expect(sessionStorage.length).toBe(0);
  await upload(fileText);
  expect(drafts.entries).toHaveLength(1);
  expect(document.body.textContent).toContain("已读取 0 份新暂存");
});
it("rejects invalid and oversized files while preserving existing recovery content", async () => {
  const drafts = await mount();
  await upload(fileText);
  const original = JSON.stringify(drafts.entries);
  await upload('{"format":"unknown"}');
  expect(drafts.error).toContain("没有有效");
  expect(document.body.textContent).not.toContain("已读取 1 份新暂存");
  expect(JSON.stringify(drafts.entries)).toBe(original);
  const large = await upload(fileText, 15_000_001);
  expect(large.text).not.toHaveBeenCalled();
  expect(drafts.error).toContain("超过 15 MB");
  expect(JSON.stringify(drafts.entries)).toBe(original);
});
