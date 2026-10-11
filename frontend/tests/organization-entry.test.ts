// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import EmployeesView from "../src/features/organization/EmployeesView.vue";
import RolesView from "../src/features/organization/RolesView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { usePlatformSession } from "../src/stores/platformSession";
import { platformApi } from "../src/repositories/platformApi";
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
  const store = useWorkspaceStore(pinia);
  const before = JSON.stringify(store.data);
  app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(router);
  await router.push("/admin/organization");
  await router.isReady();
  app.mount("#app");
  await settle();
  return { router, store, before, session: usePlatformSession(pinia) };
}
it("keeps the established department/member/role views on their original data and opens login accounts only explicitly", async () => {
  const { router, store, before } = await mount();
  expect(document.querySelector(".department-tree-row")).not.toBeNull();
  expect(document.querySelector(".organization-table")?.textContent).toContain(
    "张三",
  );
  expect(document.body.textContent).not.toContain("当前体验成员");
  expect(
    document.querySelector('[aria-label="用户菜单：登录管理员"]'),
  ).not.toBeNull();
  expect(vi.mocked(platformApi)).not.toHaveBeenCalled();
  await click("登录账号");
  const dialog = document.querySelector('dialog[aria-label="登录账号"]')!;
  expect(dialog.textContent).toContain("登录管理员");
  expect(dialog.textContent).toContain("通讯录成员的账号关联尚未完成");
  expect(dialog.textContent).not.toContain("张三");
  expect(JSON.stringify(store.data)).toBe(before);
  (dialog.querySelector(".dialog-footer button") as HTMLButtonElement).click();
  await settle();
  expect(document.querySelector('dialog[aria-label="登录账号"]')).toBeNull();
  await click("角色");
  await vi.waitFor(() =>
    expect(router.currentRoute.value.path).toBe("/admin/roles"),
  );
  await settle();
  expect(document.body.textContent).toContain("工作空间管理员");
  expect(document.body.textContent).toContain("系统角色");
  expect(document.body.textContent).not.toContain("账号授权部门");
  expect(JSON.stringify(store.data)).toBe(before);
});
it("the restored administration header signs out the real session without replacing the directory identity", async () => {
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
  expect(JSON.stringify(store.data)).toBe(before);
});
