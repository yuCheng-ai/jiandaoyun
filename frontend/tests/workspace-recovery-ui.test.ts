// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import BaseDialog from "../src/components/BaseDialog.vue";
import WorkspaceRecovery from "../src/features/workspace/WorkspaceRecovery.vue";
import WorkspaceStorageNotice from "../src/components/WorkspaceStorageNotice.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
vi.mock("../src/stores/workspace", async () => {
  const { reactive } = await import("vue");
  const store = reactive({
    writePending: false,
    storageError: "有其他页面更新",
    storageErrorContext: "",
    storageConflict: true,
    storageChanges: ["表单「采购申请」"],
    recoveryOpen: true,
    recoveryCandidates: [] as any[],
    checkStorageChanges: vi.fn(),
    inspectLatest: vi.fn(),
    recoverDesign: vi.fn(),
    exportRecovery: vi.fn(() => '{"format":"recovery"}'),
    failedSave: undefined,
    notices: [],
  });
  return { useWorkspaceStore: () => store };
});
vi.mock("vue-router", () => ({
  useRoute: () => ({
    params: { formId: "form-a" },
    fullPath: "/apps/oa/forms/form-a/design",
  }),
  useRouter: () => ({
    resolve: (to: any) => ({
      href:
        typeof to === "string"
          ? `#${to}`
          : to.name === "home"
            ? "#/"
            : `#/apps/${to.params.appId}/forms/${to.params.formId}/design`,
    }),
  }),
}));
vi.mock("../src/features/workspace/EditorDraftRecovery.vue", () => ({
  default: { render: () => h("div", "导入暂存文件 粘贴暂存 JSON") },
}));
vi.mock("../src/components/AppIcon.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/shared/EditorDraftNotice.vue", () => ({
  default: { render: () => null },
}));
let app: ReturnType<typeof createApp>;
const store = useWorkspaceStore();
const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
};
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  Object.assign(store, {
    writePending: false,
    storageError: "有其他页面更新",
    storageErrorContext: "",
    storageConflict: true,
    storageChanges: ["表单「采购申请」"],
    recoveryOpen: false,
    recoveryCandidates: [],
  });
  vi.mocked(store.inspectLatest).mockReturnValue({
    raw: "{}",
    workspace: { forms: [{ id: "form-a", title: "采购申请" }] } as any,
    error: "",
  });
  vi.mocked(store.checkStorageChanges).mockClear();
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
async function mountRecovery() {
  app = createApp({ render: () => h(WorkspaceRecovery) });
  app.mount("#mount");
  store.recoveryOpen = true;
  await settle();
}
it("ordinary dialogs have no workspace-warning dependency", async () => {
  const props = reactive({
    open: true,
    title: "推荐字段",
  });
  app = createApp({
    render: () => h(BaseDialog, props, () => h("button", "申请人")),
  });
  app.mount("#mount");
  await settle();
  expect(document.querySelector(".workspace-storage-notice")).toBeNull();
  expect(document.body.textContent).toContain("申请人");
});
it("does not carry a failed design warning to an unrelated route", async () => {
  store.storageErrorContext = "#/apps/oa/forms/other/design";
  app = createApp({ render: () => h(WorkspaceStorageNotice) });
  app.mount("#mount");
  await settle();
  expect(document.querySelector(".workspace-storage-notice")).toBeNull();
  store.storageErrorContext = "#/apps/oa/forms/form-a/design";
  await settle();
  expect(document.querySelector(".workspace-storage-notice")).not.toBeNull();
});
it("shows named updates and a same-page destination without zero-count or technical recovery tools", async () => {
  await mountRecovery();
  expect(document.body.textContent).toContain("表单「采购申请」");
  expect(document.body.textContent).not.toMatch(
    /JSON|0 份|下载工作副本|本页工作空间/,
  );
  const link = document.querySelector<HTMLAnchorElement>(".dialog-footer a")!;
  expect(link.getAttribute("href")).toBe("#/apps/oa/forms/form-a/design");
  expect(link.target).toBe("_blank");
  const close = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "返回编辑",
  )!;
  close.click();
  await settle();
  expect(store.recoveryOpen).toBe(false);
  expect(store.recoverDesign).not.toHaveBeenCalled();
});
it("opens a retained design through an explicit copy action and keeps the source page intact", async () => {
  Object.assign(store, {
    recoveryCandidates: [
      {
        key: "draft:form-a",
        source: "当前设计草稿",
        form: { id: "form-a", appId: "oa", title: "我的修改" },
      },
    ],
  });
  vi.mocked(store.recoverDesign).mockResolvedValue({
    id: "copy-a",
    appId: "oa",
    title: "我的修改 · 恢复副本",
  } as any);
  await mountRecovery();
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "另存当前设计",
  )!;
  button.click();
  await settle();
  expect(store.recoverDesign).toHaveBeenCalledWith("draft:form-a");
  expect(
    document
      .querySelector<HTMLAnchorElement>(".recovery-design-choice a")!
      .getAttribute("href"),
  ).toBe("#/apps/oa/forms/copy-a/design");
  expect(store.recoveryOpen).toBe(true);
});
it("makes support tools available only after expanding more options", async () => {
  await mountRecovery();
  const details = document.querySelector("details")!;
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await settle();
  expect(document.body.textContent).toContain("下载工作副本");
  expect(document.body.textContent).toContain("粘贴暂存 JSON");
});
it("keeps recovery reachable in an already-open tab without the new change summary", async () => {
  Object.assign(store, { storageChanges: undefined });
  await mountRecovery();
  expect(
    document.querySelector('dialog[aria-label="查看内容更新"]'),
  ).not.toBeNull();
  expect(document.body.textContent).toContain("返回编辑");
});
