// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import EmployeesView from "../src/features/organization/EmployeesView.vue";
import RolesView from "../src/features/organization/RolesView.vue";
import { useOrganizationStore } from "../src/stores/organization";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import { usePlatformSession } from "../src/stores/platformSession";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
import {
  currentAccountMember,
  withAccountMember,
} from "../src/repositories/memberAccounts";
import { directoryEditContext } from "@platform/contracts";
import { copy } from "../src/domain/form";
import { seedOrganization } from "../src/domain/organization";
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
const account = {
  id: "server-admin",
  name: "登录管理员",
  username: "admin",
  role: "admin" as const,
  active: true,
  revision: 1,
};
let app: ReturnType<typeof createApp>;
const settle = async () => {
  for (let i = 0; i < 40; i++) await nextTick();
};
async function click(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  button!.click();
  await settle();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.mocked(platformApi)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === "/organization/directory") {
        const { currentUserId: _, ...spec } = seedOrganization();
        spec.employees[0]!.name = "服务端成员";
        return {
          directory: {
            namespace: "10000000-0000-4000-8000-000000000001",
            revision: 1,
            spec,
          },
        };
      }
      if (path.startsWith("/organization/member-accounts"))
        return { links: [] };
      if (path === "/organization/role-applications") return [];
      if (path === "/organization")
        return {
          revision: 4,
          users: [account],
          spec: {
            departments: [
              {
                id: "server-dept",
                name: "账号授权部门",
                parentId: null,
                archived: false,
              },
            ],
            roleGroups: [],
            roles: [],
            assignments: [],
          },
        };
      if (path === "/auth/me") return account;
      if (path === "/auth/logout") return {};
      throw new Error(path);
    });
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});
async function mount() {
  const pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<p>工作台登录入口</p>" } },
      { path: "/admin/organization", component: EmployeesView },
      { path: "/admin/members", component: EmployeesView },
      { path: "/admin/roles", component: RolesView },
    ],
  });
  usePlatformSession(pinia).user = account;
  const store = useOrganizationStore(pinia);
  app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(router);
  await router.push("/admin/organization");
  await router.isReady();
  app.mount("#app");
  await vi.waitFor(() => expect(store.ready, store.error).toBe(true));
  await settle();
  return {
    pinia,
    router,
    store,
    before: JSON.stringify(store.organization),
    session: usePlatformSession(pinia),
  };
}
it("loads the server directory into the established department/member/role layout and opens login accounts only explicitly", async () => {
  const legacyKey = "workflow-studio-workspace-v1";
  localStorage.setItem(
    legacyKey,
    "broken legacy workspace kept for explicit recovery",
  );
  localStorage.setItem(
    "business-platform.migration-source.v1",
    "another-browser-namespace",
  );
  const read = vi.spyOn(Storage.prototype, "getItem"),
    write = vi.spyOn(Storage.prototype, "setItem");
  const { pinia, router, store, before } = await mount();
  expect(pinia.state.value.workspace).toBeUndefined();
  expect(
    read.mock.calls.some(([key]) =>
      [legacyKey, "business-platform.migration-source.v1"].includes(key),
    ),
  ).toBe(false);
  expect(write.mock.calls.some(([key]) => key === legacyKey)).toBe(false);
  expect(store.organization.currentUserId).toBe("");
  read.mockRestore();
  write.mockRestore();
  expect(document.querySelector(".department-tree-row")).not.toBeNull();
  expect(document.querySelector(".organization-table")?.textContent).toContain(
    "服务端成员",
  );
  expect(document.body.textContent).not.toContain("当前体验成员");
  expect(
    document.querySelector('[aria-label="用户菜单：登录管理员"]'),
  ).not.toBeNull();
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some(([path]) => path === "/organization/directory"),
  ).toBe(true);
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some(([path]) => path === "/organization"),
  ).toBe(false);
  await click("登录账号");
  const dialog = document.querySelector('dialog[aria-label="登录账号"]')!;
  expect(dialog.textContent).toContain("登录管理员");
  expect(dialog.textContent).toContain("成员的账号关联在通讯录成员行中设置");
  expect(dialog.textContent).not.toContain("张三");
  expect(JSON.stringify(store.organization)).toBe(before);
  (dialog.querySelector(".dialog-footer button") as HTMLButtonElement).click();
  await settle();
  expect(document.querySelector('dialog[aria-label="登录账号"]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[aria-label="编辑王五"]')!.click();
  await settle();
  document
    .querySelector<HTMLButtonElement>('[aria-label="选择成员所属部门"]')!
    .click();
  await settle();
  expect(
    document.querySelector('dialog[aria-label="选择成员所属部门"]')
      ?.textContent,
  ).toContain("研发部");
  expect(pinia.state.value.workspace).toBeUndefined();
  document
    .querySelector<HTMLButtonElement>(
      'dialog[aria-label="选择成员所属部门"] .dialog-footer button',
    )!
    .click();
  await settle();
  await click("取消");
  await click("角色");
  await vi.waitFor(() =>
    expect(router.currentRoute.value.path).toBe("/admin/roles"),
  );
  await settle();
  expect(document.body.textContent).toContain("工作空间管理员");
  expect(document.body.textContent).toContain("系统角色");
  expect(document.body.textContent).not.toContain("账号授权部门");
  expect(JSON.stringify(store.organization)).toBe(before);
});
it("signing out clears server directory state and returns to the login entry", async () => {
  const { store, before, session, router } = await mount();
  document
    .querySelector<HTMLButtonElement>('[aria-label="用户菜单：登录管理员"]')!
    .click();
  await settle();
  expect(document.body.textContent).not.toContain("切换体验成员");
  await click("退出登录");
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/"));
  expect(vi.mocked(platformApi).mock.calls).toContainEqual([
    "/auth/logout",
    "POST",
    {},
  ]);
  expect(session.user).toBeNull();
  expect(store.organization.employees).toEqual([]);
  expect(store.ready).toBe(false);
});

function storeSession() {
  const pinia = createPinia(),
    session = usePlatformSession(pinia);
  session.user = account;
  return { pinia, session, store: useOrganizationStore(pinia) };
}

it("clears the editor recovery copy after the first explicit directory save", async () => {
  vi.mocked(platformApi).mockImplementation(async (path, method, body: any) => {
    if (path.startsWith("/organization/member-accounts")) return { links: [] };
    if (path === "/organization/directory")
      return method === "POST"
        ? { namespace: body.namespace, revision: 1, spec: body.spec }
        : { directory: null };
    throw new Error(path);
  });
  const { store, pinia } = await mount();
  const drafts = useEditorDraftStore(pinia);
  document.querySelector<HTMLButtonElement>('[aria-label="新建部门"]')!.click();
  await settle();
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="部门名称"]',
  )!;
  input.value = "首个部门";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(drafts.entries).toHaveLength(1);
  await click("保存");
  await vi.waitFor(() =>
    expect(store.organization.departments[0]?.name).toBe("首个部门"),
  );
  await settle();
  expect(document.querySelector('[aria-label="部门名称"]')).toBeNull();
  expect(store.namespace).not.toBe("");
  expect(drafts.entries).toHaveLength(0);
});

it("starts empty and creates a server directory only on the first explicit save, without browser locks or local business storage", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("storage disabled");
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("storage disabled");
    });
  vi.mocked(platformApi).mockImplementation(async (_path, method, body: any) =>
    method === "POST"
      ? { namespace: body.namespace, revision: 1, spec: body.spec }
      : { directory: null },
  );
  try {
    const { store, pinia } = storeSession();
    expect(await store.load()).toBe(true);
    expect(store.organization.employees).toEqual([]);
    expect(
      vi.mocked(platformApi).mock.calls.filter((call) => call[1] === "POST"),
    ).toHaveLength(0);
    expect(await store.saveRoleGroup("岗位")).toBe(true);
    const body = vi
      .mocked(platformApi)
      .mock.calls.find((call) => call[1] === "POST")![2] as any;
    expect(body.spec.employees).toEqual([]);
    expect(body.spec.departments).toEqual([]);
    expect(body.spec.roleGroups).toHaveLength(1);
    expect(store.namespace).toBe(body.namespace);
    expect(pinia.state.value.workspace).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});

it("retries an uncertain save with the same command and refreshes conflicts without overwriting the caller's draft", async () => {
  const { store } = storeSession();
  await store.load();
  const baseline = copy(store.snapshot!),
    member = copy(store.organization.employees[0]!);
  const context = directoryEditContext(store.organization, {
    kind: "employee",
    ids: [member.id],
  });
  member.position = "待保存岗位";
  let resolveWrite!: (result: any) => void;
  vi.mocked(platformApi).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
  );
  const pending = store.saveEmployee(member, undefined, context);
  member.position = "点击保存后继续输入";
  expect(await store.saveRoleGroup("重复点击")).toBe(false);
  expect(store.organization.employees[0]!.position).toBe(
    baseline.spec.employees[0]!.position,
  );
  const command = vi.mocked(platformApi).mock.calls.at(-1)![2] as any;
  expect(command.spec.employees[0].position).toBe("待保存岗位");
  resolveWrite({ ...baseline, revision: 2, spec: command.spec });
  expect(await pending).toBe(true);
  const next = copy(store.organization.employees[0]!);
  next.position = "网络重试";
  vi.mocked(platformApi).mockRejectedValueOnce(Error("网络中断"));
  expect(await store.saveEmployee(next)).toBe(false);
  const failed = vi.mocked(platformApi).mock.calls.at(-1)![2];
  vi.mocked(platformApi).mockImplementationOnce(
    async (_path, _method, body: any) => ({
      ...baseline,
      revision: 3,
      spec: body.spec,
    }),
  );
  expect(await store.saveEmployee(next)).toBe(true);
  expect(vi.mocked(platformApi).mock.calls.at(-1)![2]).toEqual(failed);
  const remote = copy(store.snapshot!);
  remote.spec.employees[0]!.position = "其他管理员的新岗位";
  vi.mocked(platformApi)
    .mockRejectedValueOnce(new PlatformError("成员已变化", 409))
    .mockResolvedValueOnce({ directory: remote });
  next.position = "冲突的输入";
  expect(await store.saveEmployee(next)).toBe(false);
  expect(next.position).toBe("冲突的输入");
  expect(store.organization.employees[0]!.position).toBe("其他管理员的新岗位");
});

it("ignores an old account's in-flight directory response and keeps same-account session refreshes stable", async () => {
  const { store, session } = storeSession();
  await store.load();
  const saved = copy(store.snapshot!);
  session.user = { ...account };
  expect(store.ready).toBe(true);
  let finish!: (result: any) => void;
  vi.mocked(platformApi).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.load();
  session.user = null;
  session.user = { ...account, id: "another-admin" };
  finish({ directory: saved });
  expect(await pending).toBe(false);
  expect(store.ready).toBe(false);
  expect(store.organization.employees).toEqual([]);
  expect(await store.saveRoleGroup("越过未加载状态")).toBe(false);
});

it("account linking requires the same server namespace and unchanged member instead of falling back to a local directory", async () => {
  const { store } = storeSession();
  await store.load();
  const member = copy(store.organization.employees[0]!);
  const action = vi.fn(async () => true);
  expect(await withAccountMember(member, store.namespace, action)).toBe(true);
  expect(action).toHaveBeenCalledWith({
    namespace: store.namespace,
    memberId: member.id,
    name: member.name,
    number: member.number,
  });
  action.mockClear();
  await expect(
    currentAccountMember(member.id, "foreign-namespace"),
  ).rejects.toThrow("通讯录已变化");
  const changed = copy(store.snapshot!);
  changed.spec.employees[0]!.number = "new-number";
  vi.mocked(platformApi).mockResolvedValueOnce({ directory: changed });
  await expect(
    withAccountMember(member, store.namespace, action),
  ).rejects.toThrow("成员资料已变化");
  vi.mocked(platformApi).mockResolvedValueOnce({ directory: null });
  await expect(
    withAccountMember(member, store.namespace, action),
  ).rejects.toThrow("通讯录已变化");
  expect(action).not.toHaveBeenCalled();
});

it("does not let an older refresh response replace a newly saved directory", async () => {
  const { store } = storeSession();
  await store.load();
  const before = copy(store.snapshot!);
  const member = copy(store.organization.employees[0]!);
  member.position = "最新保存";
  let finishSave!: (result: any) => void, finishRead!: (result: any) => void;
  vi.mocked(platformApi)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
  const save = store.saveEmployee(member);
  const refresh = store.load();
  const spec = copy(before.spec);
  spec.employees[0]!.position = member.position;
  finishSave({ ...before, revision: before.revision + 1, spec });
  expect(await save).toBe(true);
  finishRead({ directory: before });
  expect(await refresh).toBe(true);
  expect(store.organization.employees[0]!.position).toBe("最新保存");
  expect(store.snapshot!.revision).toBe(before.revision + 1);
});
