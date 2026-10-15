// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import ServerApplicationHome from "../src/features/workspace/ServerApplicationHome.vue";
import AppFeedback from "../src/components/shared/AppFeedback.vue";
import { platformApi } from "../src/repositories/platformApi";
import { accessGroupActor } from "../src/repositories/accessGroupState";
vi.mock("../src/stores/platformSession", () => ({
  usePlatformSession: () => ({
    user: { id: "member", role: "member", name: "登记人" },
    restore: async () => {},
  }),
}));
vi.mock("../src/repositories/platformApi", () => ({ platformApi: vi.fn() }));
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
vi.mock("../src/features/collaboration/RecordEditor.vue", () => ({
  default: defineComponent({
    emits: ["saved"],
    setup(_, { emit, expose }) {
      expose({ runAfterLeave: (action: () => void) => action() });
      return () =>
        h(
          "button",
          {
            onClick: () =>
              emit("saved", {
                accessLost: true,
                record: { id: "created", state: "active" },
              }),
          },
          "提交登记验收",
        );
    },
  }),
}));
let app: ReturnType<typeof createApp>;
const callPaths = () => vi.mocked(platformApi).mock.calls.map((c) => c[0]);
async function settle() {
  for (let i = 0; i < 20; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 10; i++) await nextTick();
}
afterEach(() => {
  app?.unmount();
  vi.resetAllMocks();
  accessGroupActor(null);
  document.body.innerHTML = "";
});
it("using a create-only page stays on own drafts before and after a successful submission receipt", async () => {
  accessGroupActor("member");
  const page = {
    id: "page",
    title: "登记页面",
    definitionId: "object",
    latestVersion: 1,
  };
  vi.mocked(platformApi).mockImplementation(async (path) => {
    if (path === "/applications") return [{ id: "app", title: "登记业务" }];
    if (path === "/data-objects?applicationId=app")
      return [{ id: "object", title: "共享数据" }];
    if (path === "/pages?applicationId=app") return [page];
    if (path.endsWith("/permission-groups/options"))
      return {
        mode: "groups",
        revision: 1,
        allowMerged: false,
        groups: [{ id: "register", name: "登记组", actions: ["create"] }],
      };
    if (path === "/pages/page/form?version=1")
      return {
        page: { id: "page", version: 1 },
        definition: { id: "object", version: 1 },
        access: { read: false, create: true },
      };
    if (path === "/pages/page/record-list?version=1&state=draft&page=1") return { records: [], total: 0, page: 1, pageSize: 20, fields: [], view: { revision: 1, settings: { fieldIds: [], sortField: "$createdAt", descending: true, pageSize: 20 } } };
    throw new Error(`Unexpected request ${path}`);
  });
  document.body.innerHTML = '<div id="mount"></div>';
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/applications/:applicationId", component: ServerApplicationHome },
      { path: "/:pathMatch(.*)*", component: { render: () => null } },
    ],
  });
  await router.push("/applications/app");
  await router.isReady();
  app = createApp({ render: () => h("div", [h(RouterView), h(AppFeedback)]) });
  app.use(router);
  app.use(createPinia());
  app.mount("#mount");
  await settle();
  const click = async (label: string) => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.textContent?.trim() === label)!
      .click();
    await settle();
  };
  await click("数据管理");
  expect(document.body.textContent).toContain("提交后由有查看权限的成员处理");
  expect(document.querySelector('option[value="active"]')).toBeNull();
  expect(callPaths().filter((path) => path.includes("/record-list?"))).toEqual([
    "/pages/page/record-list?version=1&state=draft&page=1",
  ]);
  await click("新增记录");
  await click("提交登记验收");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).toContain(
    "已保存，当前权限不能查看这条记录",
  );
  expect(callPaths().filter((path) => path.includes("/record-list?"))).toEqual([
    "/pages/page/record-list?version=1&state=draft&page=1",
  ]);
});
