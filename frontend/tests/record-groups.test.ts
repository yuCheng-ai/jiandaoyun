// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { createField, emptySchema } from "../src/domain/form";
import RecordGroupDialog from "../src/features/collaboration/RecordGroupDialog.vue";
import RecordGroupSelector from "../src/features/collaboration/RecordGroupSelector.vue";
import ServerApplicationHome from "../src/features/workspace/ServerApplicationHome.vue";
import {
  accessGroupActor,
  accessGroupSelections,
  chooseAccessGroup,
} from "../src/repositories/accessGroupState";
import {
  recordGroupOptions,
  accessGroupReady,
} from "../src/repositories/accessGroupSelection";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("../src/stores/platformSession", () => ({
  usePlatformSession: () => ({
    user: { id: "member", role: "member", name: "办理人" },
    restore: vi.fn(),
  }),
}));
vi.mock("../src/components/shared/UserMenu.vue", () => ({
  default: { render: () => null },
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
const options = () => ({
  mode: "groups" as const,
  revision: 2,
  allowMerged: true,
  groups: [
    { id: "a", name: "登记组", actions: ["view" as const, "edit" as const] },
    { id: "b", name: "复核组", actions: ["view" as const] },
  ],
});
const config = () => ({
  ...options(),
  groups: options().groups.map((g) => ({
    ...g,
    enabled: true,
    archived: false,
    subjects: [{ kind: "member", id: "member" }],
    scope: "all",
    filters: [],
    fields: { name: "read" },
    relations: {},
  })),
});
const definition: any = {
  id: "object",
  title: "业务",
  version: 1,
  schema: {
    ...emptySchema(),
    fields: [
      createField("text", { id: "name", label: "业务名称" }),
      createField("member", { id: "owner", label: "办理人" }),
    ],
  },
};
const org = {
  users: [{ id: "member", name: "办理人", role: "member", active: true }],
  spec: { departments: [], roles: [], roleGroups: [], assignments: [] },
};
let app: ReturnType<typeof createApp> | undefined;
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i++) await nextTick();
}
async function mount(component: any, props: any = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/applications/:applicationId", component, props: () => props },
    ],
  });
  app = createApp({
    render: () =>
      h(RouterView, null, {
        default: ({ Component, route }: any) =>
          h(Component, { key: route.fullPath }),
      }),
  });
  app.use(createPinia());
  await router.push("/applications/app");
  app.use(router);
  await router.isReady();
  app.mount("#mount");
  await settle();
  return router;
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
async function click(text: string) {
  button(text).click();
  await settle();
}
async function input(selector: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(selector)!;
  el.value = value;
  el.dispatchEvent(
    new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
  );
  await settle();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  vi.mocked(platformApi).mockReset();
  accessGroupActor(null);
  accessGroupActor("member");
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
it("reads group options without changing the active selection", async () => {
  vi.mocked(platformApi).mockResolvedValue(options());
  let current = await recordGroupOptions("object");
  expect(accessGroupReady("object", current)).toBe(false);
  expect(accessGroupSelections.value.object).toBeUndefined();
  chooseAccessGroup("object", "*");
  current = await recordGroupOptions("object");
  expect(accessGroupReady("object", current)).toBe(true);
  vi.mocked(platformApi).mockResolvedValue({
    ...options(),
    groups: [options().groups[1]],
  });
  await recordGroupOptions("object");
  expect(accessGroupSelections.value.object).toBe("*");
  chooseAccessGroup("object", "removed-group");
  await recordGroupOptions("object");
  expect(accessGroupSelections.value.object).toBe("removed-group");
  vi.mocked(platformApi).mockResolvedValue(undefined);
  await expect(recordGroupOptions("object")).rejects.toThrow("正确读取");
});
it("never carries the previous account selection into another authenticated account", () => {
  chooseAccessGroup("object", "a");
  accessGroupActor("member");
  expect(accessGroupSelections.value.object).toBe("a");
  accessGroupActor("reviewer");
  expect(accessGroupSelections.value).toEqual({});
});
it("the selection control exposes merge only when enabled and tells the parent to reload", async () => {
  const changed = vi.fn();
  await mount(RecordGroupSelector, {
    definitionId: "object",
    options: options(),
    onChange: changed,
  });
  await input("select", "*");
  expect(changed).toHaveBeenCalledOnce();
  expect(accessGroupSelections.value.object).toBe("*");
});
it("opening a form uses allowed merged groups without an extra permission selection step", async () => {
  vi.mocked(platformApi).mockImplementation(async (path) => {
    if (path === "/applications") return [{ id: "app", title: "业务应用" }];
    if (path === "/data-objects?applicationId=app")
      return [{ id: "object", title: "业务", latestVersion: 1 }];
    if (path === "/pages?applicationId=app")
      return [
        {
          id: "page",
          title: "业务表单",
          definitionId: "object",
          latestVersion: 1,
        },
      ];
    if (path.endsWith("/options")) return options();
    if (path.includes("/record-list?"))
      return {
        records: [],
        total: 0,
        page: 1,
        pageSize: 20,
        fields: [],
        view: {
          revision: 1,
          settings: {
            fieldIds: [],
            sortField: "$createdAt",
            descending: true,
            pageSize: 20,
          },
        },
      };
    if (path === "/pages/page/form?version=1")
      return {
        page: { id: "page", version: 1 },
        definition,
        access: { read: true, create: false },
      };
    throw new Error(`unexpected ${path}`);
  });
  await mount(ServerApplicationHome);

  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some(
        (c) => c[0].includes("/form?") || c[0].includes("/record-list?"),
      ),
  ).toBe(true);
  expect(accessGroupSelections.value.object).toBe("*");
  await input(".record-group-choice select", "a");
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some(
        (c) => c[0] === "/pages/page/record-list?version=1&state=active&page=1&keyword=",
      ),
  ).toBe(true);
  expect(accessGroupSelections.value.object).toBe("a");
  await input(".record-group-choice select", "");
  expect(accessGroupSelections.value.object).toBe("*");
  expect(document.body.textContent).not.toContain(
    "请先选择本次办理使用的权限组",
  );
  expect(
    document.querySelector(".record-state-tab.active")?.textContent?.trim(),
  ).toBe("正式记录");
});
it("group configuration conflicts keep edits and require an explicit discard before rereading", async () => {
  const saved = vi.fn();
  vi.mocked(platformApi).mockImplementation(async (path, method) => {
    if (method === "PUT") throw new PlatformError("权限组已被其他人修改", 409);
    return path === "/organization"
      ? structuredClone(org)
      : path.startsWith("/relations")
        ? []
        : structuredClone(config());
  });
  await mount(RecordGroupDialog, { definition, onSaved: saved });
  await input('input[maxlength="100"]', "我的登记组");
  await click("保存权限组配置");
  expect(saved).not.toHaveBeenCalled();
  expect(
    (document.querySelector('input[maxlength="100"]') as HTMLInputElement)
      .value,
  ).toBe("我的登记组");
  const write = vi.mocked(platformApi).mock.calls.find((c) => c[1] === "PUT")!;
  expect(write[2]).toMatchObject({
    expectedRevision: 2,
    mode: "groups",
    groups: [{ id: "a", name: "我的登记组" }, { id: "b" }],
  });
  await click("重新读取权限组");
  expect(
    (document.querySelector('input[maxlength="100"]') as HTMLInputElement)
      .value,
  ).toBe("我的登记组");
  await click("放弃修改并读取");
  expect(
    (document.querySelector('input[maxlength="100"]') as HTMLInputElement)
      .value,
  ).toBe("登记组");
});
it("closing an edited group uses the shared unsaved-change decision without saving or silently discarding", async () => {
  const closed = vi.fn();
  vi.mocked(platformApi).mockImplementation(async (path) =>
    path === "/organization"
      ? structuredClone(org)
      : path.startsWith("/relations")
        ? []
        : structuredClone(config()),
  );
  await mount(RecordGroupDialog, { definition, onClose: closed });
  await input('input[maxlength="100"]', "未保存配置");
  await click("取消");
  expect(closed).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("有未保存的权限修改");
  await click("继续编辑");
  expect(closed).not.toHaveBeenCalled();
  await click("取消");
  await click("放弃修改");
  expect(closed).toHaveBeenCalledOnce();
  expect(vi.mocked(platformApi).mock.calls.every((c) => c[1] !== "PUT")).toBe(
    true,
  );
});

it("a create-only form opens its own drafts without requesting submitted records, then can switch to a viewing group", async () => {
  chooseAccessGroup("object", "register");
  const allowed = {
    ...options(),
    groups: [
      { id: "register", name: "登记组", actions: ["create"] },
      { id: "review", name: "复核组", actions: ["view"] },
    ],
  };
  vi.mocked(platformApi).mockImplementation(async (path) => {
    if (path === "/applications") return [{ id: "app", title: "登记应用" }];
    if (path === "/data-objects?applicationId=app")
      return [{ id: "object", title: "登记业务", latestVersion: 1 }];
    if (path === "/pages?applicationId=app")
      return [
        {
          id: "page",
          title: "登记表单",
          definitionId: "object",
          latestVersion: 1,
        },
      ];
    if (path.endsWith("/options")) return allowed;
    if (path === "/pages/page/form?version=1")
      return {
        page: { id: "page", version: 1 },
        definition,
        access: {
          create: accessGroupSelections.value.object === "register",
          read: accessGroupSelections.value.object === "review",
          fields: { name: "edit", owner: "hidden" },
          groupSelection: {
            definitionId: "object",
            selection: accessGroupSelections.value.object,
            revision: 1,
          },
        },
      };
    if (path.includes("/record-list?"))
      return {
        records: [],
        total: 0,
        page: 1,
        pageSize: 20,
        fields: [],
        view: {
          revision: 1,
          settings: {
            fieldIds: [],
            sortField: "$createdAt",
            descending: true,
            pageSize: 20,
          },
        },
      };
    throw new Error(path);
  });
  const router = await mount(ServerApplicationHome);
  expect(accessGroupSelections.value.object).toBe("register");
  vi.mocked(platformApi).mockClear();
  await click("数据管理");
  expect(router.currentRoute.value.query).toEqual({
    form: "page",
    view: "records",
  });
  expect(document.body.textContent).toContain("提交后由有查看权限的成员处理");
  expect(button("新增记录")).toBeDefined();
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.filter((c) => c[0].includes("/record-list?"))
      .map((c) => c[0]),
  ).toEqual(["/pages/page/record-list?version=1&state=draft&page=1&keyword="]);
  expect(button("正式记录")).toBeUndefined();
  expect(
    document.querySelector(".record-state-tab.active")?.textContent?.trim(),
  ).toBe("草稿箱");
  await input(".record-group-choice select", "review");
  expect(vi.mocked(platformApi).mock.calls.at(-1)![0]).toBe(
    "/pages/page/record-list?version=1&state=active&page=1&keyword=",
  );
});

it("permission configuration supports only-add without irrelevant record filters and keeps view dependencies consistent", async () => {
  let written: any;
  vi.mocked(platformApi).mockImplementation(async (path, method, body) => {
    if (method === "PUT") {
      written = body;
      return { ...(body as any), revision: 3 };
    }
    return path === "/organization"
      ? structuredClone(org)
      : path.startsWith("/relations")
        ? []
        : structuredClone(config());
  });
  await mount(RecordGroupDialog, { definition });
  const action = (value: string) =>
    document.querySelector<HTMLInputElement>(
      `input[type="checkbox"][value="${value}"]`,
    )!;
  action("create").click();
  await settle();
  action("view").click();
  await settle();
  expect(document.body.textContent).not.toContain("权限组记录范围");
  await click("保存权限组配置");
  expect(written.groups[0].actions).toEqual(["create"]);
  action("edit").click();
  await settle();
  expect(action("view").checked).toBe(true);
  expect(document.body.textContent).toContain("权限组记录范围");
  await click("保存权限组配置");
  expect(written.groups[0].actions).toEqual(["create", "edit", "view"]);
  action("view").click();
  await settle();
  expect(action("edit").checked).toBe(false);
  expect(action("create").checked).toBe(true);
});
