// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import ApplicationMigrationDialog from "../src/features/collaboration/ApplicationMigrationDialog.vue";
import { createField } from "../src/domain/form";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";
import {
  newForm,
  seedWorkspace,
  type WorkspaceData,
} from "../src/domain/workspace";

let currentWorkspace: { data: WorkspaceData };
const navigate = vi.fn(),
  close = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({
    push: navigate,
    resolve: (path: string) => ({ href: `#${path}` }),
  }),
}));
vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: () => currentWorkspace,
}));
vi.mock("../src/components/BaseDialog.vue", () => ({
  default: defineComponent({
    props: ["open", "title"],
    setup(props, { slots }) {
      return () =>
        props.open
          ? h("section", { role: "dialog", "aria-label": props.title }, [
              slots.default?.(),
              slots.footer?.(),
            ])
          : null;
    },
  }),
}));
let app: ReturnType<typeof createApp> | undefined;
const props = reactive({ appId: "oa" });
async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
}
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  )!;
async function click(label: string) {
  button(label).click();
  await settle();
}
async function mount() {
  app = createApp({
    render: () => h(ApplicationMigrationDialog, { ...props, onClose: close }),
  });
  app.mount("#mount");
  await settle();
}
beforeEach(() => {
  const data = seedWorkspace(),
    form = newForm("oa", "迁移检查表");
  form.id = "source_form";
  data.forms = [form];
  data.entries = [];
  data.formAccess = {};
  data.recordViews = {};
  data.organization.roles = [];
  form.schema.fields = Array.from({ length: 25 }, (_, i) =>
    createField("file", { id: `file_${i}`, label: `附件 ${i + 1}` }),
  );
  form.workflow.nodes.forEach((node) => {
    node.data.permissions = {};
  });
  currentWorkspace = reactive({ data } as object) as { data: WorkspaceData };
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
  props.appId = "oa";
  navigate.mockReset();
  close.mockReset();
  document.body.innerHTML = '<div id="mount"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Read-only inventory must not upload data");
    }),
  );
});
afterEach(() => {
  app?.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

it("paginates all findings and resets the page when a filter changes without writing or uploading", async () => {
  const before = JSON.stringify(currentWorkspace.data);
  await mount();
  expect(document.body.textContent).toContain("当前为迁移前盘点");
  expect(document.querySelectorAll(".migration-items li")).toHaveLength(20);
  await click("下一页");
  expect(document.body.textContent).toContain("第 2 / 2 页");
  const filter = document.querySelector<HTMLSelectElement>(
    '[aria-label="按问题类别筛选"]',
  )!;
  filter.value = "invalid";
  filter.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(document.body.textContent).toContain("没有符合筛选条件");
  expect(document.body.textContent).toContain("第 1 / 1 页");
  expect(JSON.stringify(currentWorkspace.data)).toBe(before);
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps a stale result visibly marked and navigation disabled until an explicit recheck", async () => {
  await mount();
  currentWorkspace.data.forms[0].schema.fields.push(
    createField("calculated", { id: "new_formula", label: "新增计算" }),
  );
  await settle();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(currentWorkspace.data));
  window.dispatchEvent(new StorageEvent("storage", { key: WORKSPACE_KEY }));
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "应用内容已变化",
  );
  expect(button("查看当前设计").disabled).toBe(true);
  await click("重新检查");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(button("查看当前设计").disabled).toBe(false);
  await click("查看当前设计");
  expect(close).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith("/apps/oa/forms/source_form/design");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not offer editing archived forms and clears old results when the application disappears", async () => {
  currentWorkspace.data.forms[0].archived = true;
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(currentWorkspace.data));
  await mount();
  expect(
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "查看当前设计",
    ),
  ).toBe(false);
  props.appId = "missing";
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "应用不存在",
  );
  expect(document.body.textContent).not.toContain("迁移检查表");
  await click("关闭检查");
  expect(close).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("reads the latest saved snapshot even when the current tab has an older workspace", async () => {
  const saved = JSON.parse(
    JSON.stringify(currentWorkspace.data),
  ) as WorkspaceData;
  saved.forms[0].title = "其他页面刚保存的名称";
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(saved));
  await mount();
  expect(document.body.textContent).toContain("其他页面刚保存的名称");
  expect(currentWorkspace.data.forms[0].title).toBe("迁移检查表");
  expect(fetch).not.toHaveBeenCalled();
});

it("opens an inspected form even when another editor has stale workspace data", async () => {
  (currentWorkspace as any).checkStorageChanges = () => true;
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await mount();
  await click("查看当前设计");
  expect(open).toHaveBeenCalledWith(
    "#/apps/oa/forms/source_form/design",
    "_blank",
    "noopener",
  );
  expect(navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("当前编辑页面已过期");
  open.mockRestore();
});
