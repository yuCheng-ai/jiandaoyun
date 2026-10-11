// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import ApplicationHome from "../src/features/workspace/ApplicationHomeView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { createField } from "../src/domain/form";
vi.mock("../src/features/forms/components/FormFields.vue", () => ({
  default: defineComponent({
    props: ["fields", "values", "disabled"],
    emits: ["change"],
    setup:
      (props, { emit }) =>
      () =>
        h(
          "section",
          props.fields.map((field: any) =>
            h("input", {
              "aria-label": field.label,
              value: props.values[field.id],
              disabled: props.disabled,
              onInput: (event: any) =>
                emit("change", field.id, event.target.value),
            }),
          ),
        ),
  }),
}));
vi.mock("../src/components/AppIcon.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/shared/UserMenu.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/features/payments/RecordPayment.vue", () => ({
  default: { render: () => null },
}));
let mounted: ReturnType<typeof createApp>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = "";
});
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
function button(name: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent?.trim() === name);
  if (!found) throw Error(`Missing button: ${name}`);
  return found;
}
function fill(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="申请说明"]',
  )!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function fixture(cache = false) {
  const pinia = createPinia(),
    store = useWorkspaceStore(pinia);
  const saved = (await store.createForm("oa", "申请单", "form", "人事类"))!;
  const draft = store.openForm(saved.id)!;
  draft.schema.fields = [
    createField("text", { id: "note", label: "申请说明" }),
  ];
  draft.schema.settings.cacheDraft = cache;
  await store.publishForm(saved.id);
  const unpublished = (await store.createForm("oa", "未发布单", "form"))!;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/apps/:appId", component: ApplicationHome },
      {
        path: "/apps/:appId/manage",
        redirect: (to) => ({
          path: `/apps/${to.params.appId}`,
          query: to.query,
        }),
      },
      {
        path: "/apps/:appId/forms/:formId/design",
        component: { render: () => h("h1", "表单设计") },
      },
    ],
  });
  await router.push({ path: "/apps/oa", query: { form: saved.id } });
  await router.isReady();
  mounted = createApp({
    render: () =>
      h(
        RouterView,
        {},
        {
          default: ({ Component, route }: any) =>
            h(Component, { key: route.fullPath }),
        },
      ),
  });
  mounted.use(pinia).use(router).mount("#app");
  await settle();
  return { store, router, form: saved, unpublished };
}
it("opens the selected published form directly; filtering never replaces its current inputs", async () => {
  const { router, unpublished } = await fixture();
  expect(document.querySelector(".application-home-main h1")?.textContent).toBe(
    "申请单",
  );
  expect(document.querySelector(".external-form.themed")).toBeNull();
  fill("保留输入");
  const search = document.querySelector<HTMLInputElement>(
    '[aria-label="搜索应用表单"]',
  )!;
  search.value = "未发布";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="申请说明"]')!.value,
  ).toBe("保留输入");
  expect(button("未发布单")).toBeTruthy();
  await router.push({ path: "/apps/oa", query: { form: unpublished.id } });
  expect(document.body.textContent).toContain("填写内容尚未保存");
  button("继续填写").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="申请说明"]')!.value,
  ).toBe("保留输入");
});
it("saves a draft, keeps its route identity and submits one record through the existing command", async () => {
  const { store, router, form } = await fixture();
  await router.push("/apps/oa");
  await settle();
  expect(router.currentRoute.value.query.form).toBe(form.id);
  fill("待提交");
  await settle();
  button("保存草稿").click();
  await vi.waitFor(() =>
    expect(router.currentRoute.value.query.draft).toBeTruthy(),
  );
  const id = String(router.currentRoute.value.query.draft);
  await settle();
  expect(router.currentRoute.value.query.form).toBe(form.id);
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="申请说明"]')!.value,
  ).toBe("待提交");
  fill("正式提交");
  await settle();
  document
    .querySelector("form.form-runtime")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(store.data.entries.find((entry) => entry.id === id)?.status).toBe(
      "submitted",
    ),
  );
  expect(
    store.data.entries.filter((entry) => entry.formId === form.id),
  ).toHaveLength(1);
  expect(store.data.entries.find((entry) => entry.id === id)?.values.note).toBe(
    "正式提交",
  );
  await settle();
  button("继续填写").click();
  await settle();
  expect(router.currentRoute.value.query.form).toBe(form.id);
  expect(router.currentRoute.value.query.draft).toBeUndefined();
});
it("requires an explicit discard when navigating away without automatic retention", async () => {
  const { router, form } = await fixture();
  fill("未保存内容");
  await settle();
  await router.push(`/apps/oa/forms/${form.id}/design`);
  await settle();
  expect(router.currentRoute.value.path).toBe("/apps/oa");
  button("放弃填写并离开").click();
  await settle();
  expect(router.currentRoute.value.path).toBe(
    `/apps/oa/forms/${form.id}/design`,
  );
});
it("can leave after automatic retention without converting another form update into a save failure", async () => {
  const { router, form } = await fixture(true);
  fill("自动保留");
  await settle();
  await router.push(`/apps/oa/forms/${form.id}/design`);
  await settle();
  expect(router.currentRoute.value.path).toBe(
    `/apps/oa/forms/${form.id}/design`,
  );
  expect(document.querySelector('[aria-label="离开当前表单？"]')).toBeNull();
});
it("shows unpublished or foreign form links as unavailable rather than accepting a draft preview submission", async () => {
  const { router, unpublished } = await fixture();
  await router.push({ path: "/apps/oa", query: { form: unpublished.id } });
  await settle();
  expect(document.body.textContent).toContain("表单尚未发布");
  expect(document.querySelector("form.form-runtime")).toBeNull();
  await router.push({ path: "/apps/oa", query: { form: "other-app-form" } });
  await settle();
  expect(document.body.textContent).toContain("表单不存在或已停用");
  expect(document.querySelector("form.form-runtime")).toBeNull();
});

function clickLabel(label: string) {
  const control = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.getAttribute("aria-label") === label);
  if (!control) throw Error(`Missing control: ${label}`);
  control.click();
}
async function fieldValue(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(
    new Event(input.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await settle();
}
async function archiveFromHome() {
  clickLabel("更多表单操作");
  await settle();
  button("移入回收站").click();
  await settle();
  button("确定").click();
  await settle();
}
it("keeps creation, rename and group moves in the current home without dropping filling inputs", async () => {
  const { store, form } = await fixture();
  fill("管理时保留");
  const published = JSON.stringify(
    store.data.forms.find((item) => item.id === form.id)!.published,
  );
  button("新建分组").click();
  await settle();
  await fieldValue("#new-folder-name", "人事类");
  button("创建").click();
  await settle();
  expect(document.body.textContent).toContain("分组名称已存在");
  await fieldValue("#new-folder-name", "采购类");
  button("创建").click();
  await settle();
  expect(store.data.apps.find((item) => item.id === "oa")!.folders).toContain(
    "采购类",
  );
  clickLabel("更多表单操作");
  await settle();
  button("重命名").click();
  await settle();
  await fieldValue("#rename-form", "采购申请");
  button("确定").click();
  await settle();
  expect(document.querySelector(".application-home-main h1")!.textContent).toBe(
    "采购申请",
  );
  clickLabel("更多表单操作");
  await settle();
  button("移动到分组").click();
  await settle();
  await fieldValue("#move-form", "采购类");
  button("确定").click();
  await settle();
  expect(store.data.forms.find((item) => item.id === form.id)!.folder).toBe(
    "采购类",
  );
  expect(
    JSON.stringify(
      store.data.forms.find((item) => item.id === form.id)!.published,
    ),
  ).toBe(published);
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="申请说明"]')!.value,
  ).toBe("管理时保留");
  expect(document.body.textContent).not.toContain("应用后台");
});
it("copies, archives with an explicit unsaved choice and restores through the same app home", async () => {
  const { store, form, router } = await fixture();
  const entry = await store.submitEntry(form.id, { note: "已保存的历史内容" });
  const original = JSON.stringify(
    store.data.forms.find((item) => item.id === form.id)!.published,
  );
  clickLabel("更多表单操作");
  await settle();
  button("复制表单").click();
  await settle();
  expect(
    store.activeForms.filter((item) => item.title.startsWith("申请单")),
  ).toHaveLength(2);
  expect(router.currentRoute.value.query.form).toBe(form.id);
  fill("尚未提交");
  await archiveFromHome();
  expect(document.body.textContent).toContain("填写内容尚未保存");
  button("继续填写").click();
  await settle();
  expect(store.activeForms.some((item) => item.id === form.id)).toBe(true);
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="申请说明"]')!.value,
  ).toBe("尚未提交");
  await archiveFromHome();
  button("放弃填写并离开").click();
  await settle();
  expect(store.data.forms.find((item) => item.id === form.id)!.archived).toBe(
    true,
  );
  button("回收站").click();
  await settle();
  clickLabel("恢复 申请单");
  await settle();
  expect(store.activeForms.some((item) => item.id === form.id)).toBe(true);
  expect(
    JSON.stringify(
      store.data.forms.find((item) => item.id === form.id)!.published,
    ),
  ).toBe(original);
  expect(
    store.data.entries.find((item) => item.id === entry!.id)?.values.note,
  ).toBe("已保存的历史内容");
});
it("keeps unsaved filling values and their guard when archiving fails", async () => {
  const { store, router, form } = await fixture();
  const failure = vi.spyOn(store, "archiveForm").mockResolvedValue(false);
  fill("失败后仍可保存");
  await archiveFromHome();
  button("放弃填写并离开").click();
  await settle();
  expect(failure).toHaveBeenCalledOnce();
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="申请说明"]')!.value,
  ).toBe("失败后仍可保存");
  await router.push(`/apps/oa/forms/${form.id}/design`);
  await settle();
  expect(document.body.textContent).toContain("填写内容尚未保存");
  failure.mockRestore();
});
it("redirects the former management address to the same home with the selected form preserved", async () => {
  const { router, form } = await fixture();
  await router.push({ path: "/apps/oa/manage", query: { form: form.id } });
  await settle();
  expect(router.currentRoute.value.path).toBe("/apps/oa");
  expect(router.currentRoute.value.query.form).toBe(form.id);
  expect(document.querySelector(".application-home-main h1")!.textContent).toBe(
    "申请单",
  );
});
