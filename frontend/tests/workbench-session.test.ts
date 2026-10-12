// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import WorkbenchView from "../src/features/workspace/WorkbenchView.vue";
import { installSessionGuard } from "../src/router/sessionGuard";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
import App from "../src/App.vue";
import { router as applicationRouter } from "../src/router";
import { usePlatformSession } from "../src/stores/platformSession";
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
vi.mock("../src/features/processes/ProcessWorkspace.vue", () => ({
  default: { template: "<div>已授权任务</div>" },
}));
let app: ReturnType<typeof createApp> | undefined;
let router: ReturnType<typeof createRouter>;
let signedIn = "";
const users = {
  admin: { id: "admin", username: "admin", name: "真实管理员", role: "admin" },
  editor: {
    id: "editor",
    username: "editor",
    name: "真实录入员",
    role: "member",
  },
  reviewer: {
    id: "reviewer",
    username: "reviewer",
    name: "真实核对员",
    role: "member",
  },
};
async function settle() {
  for (let i = 0; i < 50; i++) await nextTick();
}
function input(label: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(label)!;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
async function click(text: string) {
  const el = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((el) => el.textContent?.trim() === text);
  expect(el, text).toBeTruthy();
  el!.click();
  await settle();
}
async function login(name: string) {
  input("[autocomplete=username]", name);
  input("[type=password]", "Synthetic-login-password!");
  await settle();
  document
    .querySelector("form.platform-login")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
async function mount(path = "/") {
  router = createRouter({
    history: createMemoryHistory(),
    routes: applicationRouter.options.routes.map((route) => {
      if (route.name === "home") return { path: route.path, name: route.name, component: WorkbenchView };
      if (route.name === "data-workspace") return { path: route.path, name: route.name, component: { template: "<p>应用记录入口</p>" } };
      if (route.name === "organization") return { path: route.path, name: route.name, component: { template: "<p>组织管理入口</p>" } };
      return route;
    }),
  });
  const pinia = createPinia();
  app = createApp(App);
  app.use(pinia);
  installSessionGuard(router);
  await router.push(path);
  await router.isReady();
  app.use(router);
  app.mount("#app");
  await settle();
  return {
    pinia,
    session: usePlatformSession(pinia),
  };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  signedIn = "";
  document.body.innerHTML = '<div id="app"></div>';
  vi.mocked(platformApi)
    .mockReset()
    .mockImplementation(async (path, method, body) => {
      if (path === "/auth/login") {
        signedIn = (body as { username: string }).username;
        return users[signedIn as keyof typeof users];
      }
      if (path === "/auth/logout") {
        signedIn = "";
        return { ok: true };
      }
      if (path === "/auth/me") {
        if (!signedIn) throw new PlatformError("登录已失效", 401);
        return users[signedIn as keyof typeof users];
      }
      if (path === "/applications" && method === "POST") return { id: "new-server-app", title: (body as { title: string }).title };
      if (path === "/applications" && method !== "POST")
        return [
          {
            id: signedIn + "-app",
            title:
              signedIn === "editor"
                ? "录入业务"
                : signedIn === "reviewer"
                  ? "核对业务"
                  : "管理业务",
          },
        ];
      throw new Error(path);
    });
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

it("root requires real login, shows only the server application list and replaces it when another member logs in", async () => {
  localStorage.setItem("workflow-studio-workspace-v1", "preserved legacy data");
  const read = vi.spyOn(Storage.prototype, "getItem");
  const { pinia } = await mount();
  expect(document.body.textContent).not.toContain("OA审批系统");
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some(([path]) => path === "/applications"),
  ).toBe(false);
  await login("editor");
  expect(document.body.textContent).toContain("录入业务");
  expect(document.body.textContent).not.toContain("本地应用");
  document
    .querySelector<HTMLButtonElement>('[aria-label="用户菜单：真实录入员"]')!
    .click();
  await settle();
  expect(document.body.textContent).not.toContain("切换体验成员");
  expect(document.body.textContent).not.toContain("组织与成员");
  await click("退出登录");
  expect(document.body.textContent).not.toContain("录入业务");
  expect(
    document.querySelector<HTMLInputElement>("[type=password]")?.value,
  ).toBe("");
  await login("reviewer");
  expect(document.body.textContent).toContain("核对业务");
  expect(document.body.textContent).not.toContain("录入业务");
  expect(pinia.state.value.workspace).toBeUndefined();
  expect(read.mock.calls.some(([key]) => key === "workflow-studio-workspace-v1")).toBe(false);
  read.mockRestore();
  expect(localStorage.getItem("workflow-studio-workspace-v1")).toBe("preserved legacy data");
});
it("administrator sees only server applications and can open the existing organization layout", async () => {
  signedIn = "admin";
  const { pinia } = await mount();
  expect(document.body.textContent).toContain("管理业务");
  expect(document.body.textContent).not.toContain("OA审批系统");
  expect(pinia.state.value.workspace).toBeUndefined();
  await click("组织与成员");
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/admin/organization"));
  expect(document.body.textContent).toContain("组织管理入口");
});

it("guards deep links, resumes the exact authorized destination after login, and rejects member access to local administration", async () => {
  await mount("/applications/editor-app?tab=pages");
  expect(router.currentRoute.value.path).toBe("/");
  await login("editor");
  expect(router.currentRoute.value.fullPath).toBe(
    "/applications/editor-app?tab=pages",
  );
  await router.push("/apps/oa");
  await settle();
  expect(router.currentRoute.value.path).toBe("/");
  expect(document.body.textContent).toContain("此旧入口已停用");
  expect(document.body.textContent).not.toContain("原应用管理员入口");
  await router.push("/admin/organization");
  await settle();
  expect(router.currentRoute.value.path).toBe("/");
});
it.each(["/apps/oa", "/apps/oa/forms/expense/design", "/apps/oa/forms/expense/fill", "/apps/oa/forms/expense/flow", "/apps/oa/forms/expense/extensions", "/admin/payments"])("retires %s without guessing server IDs or opening local data", async (path) => {
  const { pinia } = await mount(path);
  expect(router.currentRoute.value.fullPath).toBe("/?notice=legacy-link");
  expect(document.body.textContent).toContain("此旧入口已停用");
  expect(pinia.state.value.workspace).toBeUndefined();
  expect(vi.mocked(platformApi).mock.calls.some(([url]) => url.includes("oa") || url.includes("expense"))).toBe(false);
});

it("focus rechecks revoked sessions and preserves local resources; network failure offers retry", async () => {
  signedIn = "editor";
  await mount();
  signedIn = "";
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(document.body.textContent).not.toContain("录入业务");
  expect(document.body.textContent).toContain("登录");
  vi.mocked(platformApi).mockRejectedValueOnce(
    new PlatformError("无法连接", 0),
  );
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(document.querySelector("[role=alert]")?.textContent).toContain(
    "无法连接",
  );
  await click("重试");
  expect(document.querySelector("[role=alert]")).toBeNull();
});
it("creates an application through the server and opens its returned identity", async () => {
  signedIn = "admin";
  const { pinia } = await mount();
  await click("新建应用"); input("#new-app-name", "采购"); await settle();
  document.querySelector("form#workbench-create-app")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/applications/new-server-app"));
  expect(vi.mocked(platformApi).mock.calls).toContainEqual([
    "/applications", "POST", { title: "采购", requestId: expect.any(String) },
  ]);
  expect(pinia.state.value.workspace).toBeUndefined();
});

it("ignores external and recursive sign-in destinations", async () => {
  await mount("/?next=https://example.com");
  await login("editor");
  expect(router.currentRoute.value.path).toBe("/");
  expect(document.body.textContent).toContain("录入业务");
});
