// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { separateFormSchema } from "@platform/contracts";
import { createField, emptySchema } from "../src/domain/form";
import DataObjectEditor from "../src/features/data/DataObjectEditor.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: defineComponent({
    setup(_, { slots }) {
      return () => h("a", slots.default?.());
    },
  }),
}));
vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: () => ({
    activeForms: [
      { id: "local-form", title: "本地表单", schema: emptySchema() },
    ],
  }),
}));
vi.mock("../src/stores/platformSession", () => ({
  usePlatformSession: () => ({
    user: { id: "admin", role: "admin", name: "管理员" },
    restore: vi.fn(),
  }),
}));
vi.mock("../src/features/processes/ProcessWorkspace.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
vi.mock("../src/components/BaseDialog.vue", () => ({
  default: defineComponent({
    props: ["open", "title"],
    setup(props, { slots }) {
      return () =>
        props.open
          ? h("section", { "aria-label": props.title }, [
              slots.default?.(),
              slots.footer?.(),
            ])
          : null;
    },
  }),
}));
const original = {
  id: "object",
  title: "业务对象",
  revision: 3,
  latestVersion: 1,
  model: separateFormSchema({
    ...emptySchema(),
    fields: [createField("text", { id: "name", label: "名称" })],
  }).model,
};
let app: ReturnType<typeof createApp> | undefined, saved: any, impact: any;
const emitted = vi.fn();
async function settle() {
  for (let i = 0; i < 15; i++) await nextTick();
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  )!;
async function click(text: string) {
  button(text).click();
  await settle();
}
async function rename(text: string) {
  const input = document.querySelector<HTMLInputElement>(
    ".collab-field input",
  )!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
async function mount() {
  app = createApp({
    render: () =>
      h(DataObjectEditor, {
        object: structuredClone(original),
        onSaved: emitted,
      }),
  });
  app.mount("#mount");
  await settle();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  saved = structuredClone(original);
  emitted.mockReset();
  impact = {
    token: "reviewed",
    definitionId: "object",
    title: "业务对象",
    revision: 3,
    fromVersion: 1,
    toVersion: 2,
    titleChanged: false,
    changes: { added: [], removed: [], changed: [], renamed: [] },
    references: [],
    records: [],
    tasks: [],
    blockers: [],
  };
  vi.mocked(platformApi).mockReset();
  vi.mocked(platformApi).mockImplementation(async (path, method, body: any) => {
    if (method === "PUT") {
      saved = JSON.parse(
        JSON.stringify({ ...saved, ...body, revision: saved.revision + 1 }),
      );
      delete saved.expectedRevision;
      return structuredClone(saved);
    }
    if (path.endsWith("/publish-preview"))
      return { ...structuredClone(impact), revision: saved.revision };
    if (path.endsWith("/publish"))
      return {
        ...structuredClone(saved),
        revision: saved.revision + 1,
        latestVersion: 2,
      };
    if (path.endsWith("/discard-draft"))
      return { ...structuredClone(original), revision: saved.revision + 1 };
    return structuredClone(saved);
  });
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
it("checking publication saves a draft only, and explicit confirmation submits its review token", async () => {
  await mount();
  await rename("业务新版");
  await click("检查并发布");
  expect(vi.mocked(platformApi).mock.calls.map((call) => call[0])).toEqual([
    "/data-objects/object",
    "/data-objects/object/publish-preview",
  ]);
  expect(emitted).not.toHaveBeenCalled();
  await click("确认发布数据");
  expect(vi.mocked(platformApi).mock.calls.at(-1)?.[2]).toEqual({
    expectedRevision: 4,
    impactToken: "reviewed",
  });
  expect(emitted.mock.calls[0]?.[0].latestVersion).toBe(2);
});
it("blocking references prevent confirmation; returning to edit retains the pending removal", async () => {
  impact.blockers = ["登记页仍引用名称"];
  impact.changes.removed = [{ id: "name", name: "名称", details: [] }];
  await mount();
  await click("移除字段");
  await click("检查并发布");
  expect(button("确认发布数据").disabled).toBe(true);
  expect(document.body.textContent).toContain("登记页仍引用名称");
  await click("继续编辑");
  expect(document.querySelector(".model-fields-table tbody tr")).toBeNull();
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some((call) => call[0].endsWith("/publish")),
  ).toBe(false);
});
it("a stale review retains the saved draft and requires a fresh preview before retry", async () => {
  await mount();
  await rename("保留我的名称");
  await click("检查并发布");
  vi.mocked(platformApi).mockRejectedValueOnce(
    new PlatformError("使用情况已变化", 409),
  );
  await click("确认发布数据");
  expect(button("确认发布数据").disabled).toBe(true);
  expect(document.body.textContent).toContain("使用情况已变化");
  expect(
    (document.querySelector(".collab-field input") as HTMLInputElement).value,
  ).toBe("保留我的名称");
  await click("重新检查");
  expect(button("确认发布数据").disabled).toBe(false);
  expect(
    vi.mocked(platformApi).mock.calls.filter((call) => call[1] === "PUT"),
  ).toHaveLength(1);
});
it("discarding a saved draft requires a separate decision, uses CAS and does not save unsaved edits first", async () => {
  await mount();
  await rename("未保存输入");
  await click("放弃已保存草稿");
  expect(vi.mocked(platformApi)).not.toHaveBeenCalled();
  await click("继续编辑");
  expect(
    (document.querySelector(".collab-field input") as HTMLInputElement).value,
  ).toBe("未保存输入");
  await click("放弃已保存草稿");
  await click("确认放弃数据草稿");
  expect(vi.mocked(platformApi).mock.calls).toEqual([
    ["/data-objects/object/discard-draft", "POST", { expectedRevision: 3 }],
  ]);
  expect(
    (document.querySelector(".collab-field input") as HTMLInputElement).value,
  ).toBe("业务对象");
  expect(document.body.textContent).toContain("已放弃数据草稿");
});
it("save conflicts keep input, and reading a newer draft requires an explicit discard decision", async () => {
  await mount();
  await rename("本地修改");
  vi.mocked(platformApi).mockRejectedValueOnce(
    new PlatformError("数据草稿已修改", 409),
  );
  await click("保存草稿");
  await click("重新读取数据草稿");
  expect(vi.mocked(platformApi)).toHaveBeenCalledTimes(1);
  await click("继续编辑");
  expect(
    (document.querySelector(".collab-field input") as HTMLInputElement).value,
  ).toBe("本地修改");
  saved.title = "服务器最新";
  await click("重新读取数据草稿");
  await click("放弃当前修改并读取");
  expect(
    (document.querySelector(".collab-field input") as HTMLInputElement).value,
  ).toBe("服务器最新");
});
it("reviewing shared field changes lists consuming forms and does not publish their layouts", async () => {
  impact.references = ["登记表单", "核对表单"].map((title, index) => ({
    kind: "page",
    id: `page-${index}`,
    title,
    state: "published",
    version: 1,
    fields: [],
    effect: "retained",
    detail: "保留已发布版本",
  }));
  impact.defaultPageWillPublish = false;
  await mount();
  await rename("核对名称");
  await click("检查并发布");
  expect(document.body.textContent).toContain("登记表单");
  expect(document.body.textContent).toContain("核对表单");
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some((call) => call[0].endsWith("/publish")),
  ).toBe(false);
  await click("确认发布数据");
  expect(vi.mocked(platformApi).mock.calls.at(-1)?.[2]).toEqual({
    expectedRevision: 4,
    impactToken: "reviewed",
  });
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.every((call) => call[0].startsWith("/data-objects/object")),
  ).toBe(true);
});
