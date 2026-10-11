// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, shallowReactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import PublishAccessSettings from "../src/features/forms/components/PublishAccessSettings.vue";
import FormSectionView from "../src/features/forms/FormSectionView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import { copy, createField } from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
  type WorkspaceData,
} from "../src/domain/workspace";
import {
  defaultAccess,
  newAccessGroup,
  type FormAccess,
  memberSchema,
} from "../src/domain/access";
import {
  restoreAccessGroupDraft,
  restoreAccessSettingsDraft,
} from "../src/domain/accessDraftAdapters";

vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: vi.fn(),
  syncFormWorkflow: vi.fn(),
}));
vi.mock("../src/components/WorkspaceStorageNotice.vue", () => ({
  default: { render: () => null },
}));
const disposers = new Set<() => void>();
let form: FormRecord;
let store: ReturnType<typeof makeStore>;
function makeStore() {
  return shallowReactive({
    data: reactive(seedWorkspace()) as WorkspaceData,
    writePending: false,
    storageError: "",
    notify: vi.fn(),
    saveFormAccess: vi.fn(),
    publishForm: vi.fn(),
    drafts: shallowReactive({} as Record<string, FormRecord>),
    openForm: vi.fn(),
    consumePrefill: vi.fn(),
  });
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  store = makeStore();
  vi.mocked(useWorkspaceStore).mockReturnValue(store as any);
  form = shallowReactive(newForm("oa", "两阶段权限验收"));
  form.id = "access-recovery-form";
  form.schema.fields = [
    createField("text", { id: "name", label: "名称" }),
    createField("subform", {
      id: "rows",
      label: "明细",
      children: [createField("number", { id: "count", label: "数量" })],
    }),
  ];
  const group = newAccessGroup(form.schema);
  group.id = "existing-group";
  group.identities = ["zhang"];
  group.name = "原权限组";
  store.data.formAccess = {
    [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
});
afterEach(() => {
  [...disposers].forEach((fn) => fn());
  vi.restoreAllMocks();
});
const button = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === name,
  )!;
async function click(name: string, scope?: ParentNode) {
  const target = button(name, scope);
  expect(target, name).toBeDefined();
  target.click();
  await nextTick();
}
const input = (label: string) =>
  [...document.querySelectorAll("label")]
    .find((el) => el.textContent?.trim().startsWith(label))!
    .querySelector<HTMLInputElement>("input")!;
async function edit(label: string, value: string) {
  const target = input(label);
  target.value = value;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function restore(scope?: ParentNode) {
  await click("恢复内容", scope);
  await click("确认恢复", scope);
}
async function mount(publication = false) {
  const pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/settings",
        component: { render: () => h(PublishAccessSettings, { form }) },
      },
      {
        path: "/apps/:appId/forms/:formId/:section",
        component: FormSectionView,
      },
      { path: "/other", component: { render: () => h("p", "其他页面") } },
    ],
  });
  await router.push(
    publication ? `/apps/oa/forms/${form.id}/publish` : "/settings",
  );
  const app = createApp({ render: () => h(RouterView) });
  app.use(pinia).use(router).mount(document.getElementById("app")!);
  const unmount = () => {
    app.unmount();
    disposers.delete(unmount);
  };
  disposers.add(unmount);
  await nextTick();
  return { drafts: useEditorDraftStore(pinia), unmount, router };
}
const succeed = () =>
  store.saveFormAccess.mockImplementation(
    async (id: string, config: FormAccess) => {
      store.data.formAccess![id] = copy(config);
      return true;
    },
  );
function publish(version: number, fields = form.schema.fields) {
  form.published = {
    version,
    title: form.title,
    schema: { ...copy(form.schema), fields: copy(fields) },
    workflow: copy(form.workflow),
    publishedAt: "2026-10-09",
  };
  form.versions.push(copy(form.published));
}

it("uses one committed publication for status, history and an open permission editor while keeping the design draft", async () => {
  publish(1);
  store.drafts[form.id] = copy(form);
  store.drafts[form.id]!.title = "保留中的设计";
  store.data.forms.push(copy(form));
  await mount(true);
  await click("编辑");
  await edit("权限组名称", "保留中的权限修改");
  publish(2, [
    ...form.schema.fields,
    createField("text", { id: "new_field", label: "新字段" }),
  ]);
  store.data.forms = store.data.forms.map((f) =>
    f.id === form.id ? copy(form) : f,
  );
  await nextTick();
  expect(document.body.textContent).toContain("当前版本 V2");
  expect(
    document.querySelector(".publish-version-list")!.textContent,
  ).toContain("V2");
  expect(
    document.querySelector(".publish-version-list")!.textContent,
  ).toContain("V1");
  expect(input("权限组名称").value).toBe("保留中的权限修改");
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="新字段权限"]')!
      .value,
  ).toBe("hidden");
  expect(document.querySelector(".access-warning")).toBeNull();
  expect(store.drafts[form.id]!.title).toBe("保留中的设计");
  expect(store.drafts[form.id]!.published!.version).toBe(1);
  const scope = [...document.querySelectorAll("dialog label")]
    .find((el) => el.textContent?.trim().startsWith("可以操作哪些数据"))!
    .querySelector("select")!;
  scope.value = "custom";
  scope.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  await click("添加筛选条件");
  for (const [label, value] of [
    ["条件1来源字段", "name"],
    ["条件1运算符", "notEmpty"],
  ]) {
    const select = document.querySelector<HTMLSelectElement>(
      `[aria-label="${label}"]`,
    )!;
    select.value = value!;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
  }
  await click("应用到设置");
  await edit("收集数量上限", "18");
  store.saveFormAccess.mockImplementation(async () => {
    publish(
      3,
      form.schema.fields.filter((f) => f.id !== "name"),
    );
    store.data.forms = store.data.forms.map((f) =>
      f.id === form.id ? copy(form) : f,
    );
    return false;
  });
  await click("保存发布设置");
  await vi.waitFor(() =>
    expect(document.querySelector(".config-errors")!.textContent).toContain(
      "有效的数据筛选条件",
    ),
  );
  expect(input("收集数量上限").value).toBe("18");
  expect(store.data.formAccess![form.id]!.groups[0]!.scope).toBe("all");
});

it("blocks live saving after a member switch while retaining the current access input", async () => {
  await mount();
  await edit("收集数量上限", "23");
  store.data.organization.currentUserId = "li";
  await nextTick();
  expect(document.querySelector(".access-warning")).not.toBeNull();
  await click("保存发布设置");
  expect(store.saveFormAccess).not.toHaveBeenCalled();
  expect(input("收集数量上限").value).toBe("23");
});

it.each([false, true])(
  "publishing a new schema does not create a settings conflict (edited: %s)",
  async (edited) => {
    publish(1);
    await mount();
    if (edited) await edit("收集数量上限", "17");
    const oldAccess = copy(store.data.formAccess![form.id]!);
    publish(2, [
      ...form.schema.fields,
      createField("text", { id: "new_field", label: "新字段" }),
    ]);
    await nextTick();
    expect(document.querySelector(".access-warning")).toBeNull();
    expect(input("收集数量上限").value).toBe(edited ? "17" : "0");
    expect(store.data.formAccess![form.id]).toEqual(oldAccess);
    expect(form.versions[0]!.schema.fields).toHaveLength(2);
    succeed();
    await click("保存发布设置");
    if (edited)
      await vi.waitFor(() =>
        expect(store.saveFormAccess).toHaveBeenCalledOnce(),
      );
    else {
      expect(button("保存发布设置").disabled).toBe(true);
      expect(store.saveFormAccess).not.toHaveBeenCalled();
    }
    expect(
      memberSchema(
        form.published!.schema,
        store.data.formAccess![form.id]!.groups,
      ).fields.find((f) => f.id === "new_field")!.visible,
    ).toBe(false);
  },
);
it("validates a removed permission-filter field against the new publication and retains pending input", async () => {
  const group = store.data.formAccess![form.id]!.groups[0]!;
  group.scope = "custom";
  group.filters = [
    {
      id: "condition",
      sourceFieldId: "name",
      operator: "notEmpty",
      source: "constant",
      value: "",
    },
  ];
  publish(1);
  await mount();
  await edit("收集数量上限", "18");
  publish(
    2,
    form.schema.fields.filter((f) => f.id !== "name"),
  );
  await nextTick();
  expect(document.querySelector(".access-warning")).toBeNull();
  await click("保存发布设置");
  expect(store.saveFormAccess).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("有效的数据筛选条件");
  expect(input("收集数量上限").value).toBe("18");
});
it("keeps an open group draft across publication and displays new columns as hidden", async () => {
  publish(1);
  await mount();
  await click("编辑");
  await edit("权限组名称", "我的权限修改");
  publish(2, [
    ...form.schema.fields,
    createField("text", { id: "new_field", label: "新字段" }),
  ]);
  await nextTick();
  expect(input("权限组名称").value).toBe("我的权限修改");
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="新字段权限"]')!
      .value,
  ).toBe("hidden");
  await click("应用到设置");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  succeed();
  await click("保存发布设置");
  await vi.waitFor(() => expect(store.saveFormAccess).toHaveBeenCalledOnce());
  expect(
    memberSchema(
      form.published!.schema,
      store.data.formAccess![form.id]!.groups,
    ).fields.find((f) => f.id === "new_field")!.visible,
  ).toBe(false);
});

it("recovers both unfinished layers, transfers the child only to the parent draft, and persists only on parent save", async () => {
  const first = await mount();
  await edit("收集数量上限", "");
  await click("编辑");
  await edit("权限组名称", "跨部门待保存权限");
  const field = document.querySelector<HTMLSelectElement>(
    '[aria-label="数量权限"]',
  )!;
  field.value = "hidden";
  field.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(first.drafts.entries).toHaveLength(2);
  first.unmount();
  const second = await mount();
  expect(input("收集数量上限").value).toBe("0");
  await restore();
  expect(input("收集数量上限").value).toBe("");
  await click("编辑");
  expect(input("权限组名称").value).toBe("原权限组");
  await restore(document.querySelector("dialog")!);
  expect(input("权限组名称").value).toBe("跨部门待保存权限");
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="数量权限"]')!.value,
  ).toBe("hidden");
  await click("应用到设置");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(store.saveFormAccess).not.toHaveBeenCalled();
  expect(store.data.formAccess![form.id]!.groups[0]!.name).toBe("原权限组");
  expect(second.drafts.entries).toHaveLength(1);
  expect(second.drafts.isCheckpoint(second.drafts.entries[0]!)).toBe(true);
  second.unmount();
  const third = await mount();
  await restore();
  expect(document.body.textContent).toContain("跨部门待保存权限");
  await click("保存发布设置");
  expect(store.saveFormAccess).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("收集上限应为非负整数");
  await edit("收集数量上限", "20");
  succeed();
  await click("保存发布设置");
  await vi.waitFor(() => expect(third.drafts.entries).toHaveLength(0));
  expect(store.data.formAccess![form.id]!.groups[0]!.fields.count).toBe(
    "hidden",
  );
  third.unmount();
  const last = await mount();
  expect(last.drafts.entries).toHaveLength(0);
  expect(input("收集数量上限").value).toBe("20");
});

it("keeps failed and pending parent saves, prevents duplicate writes, and retries the same stable group", async () => {
  const current = await mount();
  await click("编辑");
  await edit("权限组名称", "保留输入");
  await click("应用到设置");
  await nextTick();
  let finish!: (result: boolean) => void;
  store.saveFormAccess.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await click("保存发布设置");
  await click("保存发布设置");
  expect(store.saveFormAccess).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("正在保存发布设置");
  await current.router.push("/other");
  expect(current.router.currentRoute.value.path).toBe("/settings");
  finish(false);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("修改已保留"),
  );
  expect(current.drafts.entries).toHaveLength(1);
  store.saveFormAccess.mockRejectedValueOnce(Error("offline"));
  await click("保存发布设置");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("保存失败"),
  );
  expect(document.body.textContent).toContain("保留输入");
  succeed();
  await click("保存发布设置");
  await vi.waitFor(() => expect(current.drafts.entries).toHaveLength(0));
  expect(store.data.formAccess![form.id]!.groups).toHaveLength(1);
  expect(store.data.formAccess![form.id]!.groups[0]!.id).toBe("existing-group");
});

it("does not clear child recovery when the parent checkpoint fails, and acknowledges only after retry", async () => {
  const current = await mount();
  await click("编辑");
  await edit("权限组名称", "交接失败仍保留");
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("quota");
  });
  await click("应用到设置");
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain(
      "暂存未完成",
    ),
  );
  expect(input("权限组名称").value).toBe("交接失败仍保留");
  expect(document.querySelector(".access-settings")?.textContent).not.toContain(
    "交接失败仍保留",
  );
  expect(
    current.drafts.entries.some((entry) => entry.key.includes("access-group")),
  ).toBe(true);
  fail.mockRestore();
  await click("应用到设置");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(current.drafts.entries).toHaveLength(1);
  expect(current.drafts.isCheckpoint(current.drafts.entries[0]!)).toBe(true);
});

it("rejects an invalid child without closing it and discards only that layer", async () => {
  const current = await mount();
  await edit("收集数量上限", "25");
  await click("编辑");
  await edit("权限组名称", "");
  await click("应用到设置");
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain(
      "请填写权限组名称",
    ),
  );
  await click("取消", document.querySelector("dialog")!);
  await click("继续编辑");
  expect(input("权限组名称").value).toBe("");
  await click("取消", document.querySelector("dialog")!);
  await click("放弃修改");
  expect(document.querySelector("dialog")).toBeNull();
  expect(input("收集数量上限").value).toBe("25");
  expect(current.drafts.entries).toHaveLength(1);
  await click("编辑");
  expect(input("权限组名称").value).toBe("原权限组");
  expect(button("恢复内容", document.querySelector("dialog")!)).toBeUndefined();
});

it("requires a leave decision and clears explicitly discarded parent input without recapturing it", async () => {
  const current = await mount();
  await edit("收集数量上限", "8");
  const first = current.router.push("/other");
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain(
      "发布设置尚未保存",
    ),
  );
  await click("继续编辑");
  await first;
  expect(current.router.currentRoute.value.path).toBe("/settings");
  const second = current.router.push("/other");
  await vi.waitFor(() => expect(button("放弃修改")).toBeDefined());
  await click("放弃修改");
  await second;
  expect(current.router.currentRoute.value.path).toBe("/other");
  expect(current.drafts.entries).toHaveLength(0);
  await current.router.push("/settings");
  expect(input("收集数量上限").value).toBe("0");
  expect(current.drafts.entries).toHaveLength(0);
});

it("keeps the leave dialog actionable after save failure and navigates only after success", async () => {
  const current = await mount();
  await edit("收集数量上限", "18");
  const leaving = current.router.push("/other");
  await vi.waitFor(() => expect(button("保存并离开")).toBeDefined());
  store.saveFormAccess.mockResolvedValueOnce(false);
  await click("保存并离开");
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain(
      "修改已保留",
    ),
  );
  expect(current.router.currentRoute.value.path).toBe("/settings");
  expect(current.drafts.entries).toHaveLength(1);
  succeed();
  await click("保存并离开");
  await leaving;
  expect(current.router.currentRoute.value.path).toBe("/other");
  expect(current.drafts.entries).toHaveLength(0);
});

it.each(["member", "schema", "original"])(
  "refuses stale %s recovery and live overwrite, with explicit reload",
  async (kind) => {
    const current = await mount();
    await edit("收集数量上限", "13");
    await click("编辑");
    await edit("权限组名称", "旧来源的输入");
    current.unmount();
    if (kind === "member") store.data.organization.currentUserId = "wang";
    else if (kind === "schema")
      form.schema.fields.push(createField("text", { id: "extra" }));
    else store.data.formAccess![form.id]!.allowMerged = false;
    await mount();
    expect(button("恢复内容").disabled).toBe(true);
    await click("编辑");
    expect(button("恢复内容", document.querySelector("dialog")!).disabled).toBe(
      true,
    );
    await click("取消", document.querySelector("dialog")!);
    await edit("收集数量上限", "15");
    store.data.formAccess![form.id]!.publicEnabled = false;
    await click("保存发布设置");
    expect(store.saveFormAccess).not.toHaveBeenCalled();
    expect(input("收集数量上限").value).toBe("15");
    await click("重新读取发布设置");
    await click("继续编辑");
    expect(input("收集数量上限").value).toBe("15");
    await click("重新读取发布设置");
    await click("放弃并重新读取");
    expect(input("收集数量上限").value).toBe("0");
  },
);

it("validates recovery shapes without converting malformed permissions or unfinished limits", () => {
  const config = copy(store.data.formAccess![form.id]!);
  expect(
    restoreAccessSettingsDraft({
      ...config,
      filling: { ...config.filling, limit: "" },
    }).filling.limit,
  ).toBe("");
  const group = config.groups[0]!;
  expect(
    restoreAccessGroupDraft({
      ...group,
      name: "",
      identities: [],
      actions: [],
      filters: [
        {
          id: "filter",
          sourceFieldId: "",
          operator: "equals",
          source: "constant",
          value: "",
        },
      ],
    }).name,
  ).toBe("");
  expect(() =>
    restoreAccessGroupDraft({ ...group, scope: "unknown" }),
  ).toThrow();
  expect(() =>
    restoreAccessGroupDraft({ ...group, fields: { name: "owner" } }),
  ).toThrow();
  expect(() => restoreAccessGroupDraft(group, "other-id")).toThrow();
  expect(() =>
    restoreAccessSettingsDraft({ ...config, groups: [group, group] }),
  ).toThrow();
});

it("hides disabled member configuration without erasing groups or publishing unsaved switches", async () => {
  publish(1);
  await mount();
  const toggle = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="启用成员访问"]')!;
  expect(button("保存发布设置").disabled).toBe(true);
  toggle().click();
  await nextTick();
  expect(document.querySelector(".access-group-card")).toBeNull();
  expect(document.querySelector('[aria-label="成员入口链接"]')).toBeNull();
  expect(store.data.formAccess![form.id]!.membersEnabled).toBe(true);
  expect(store.saveFormAccess).not.toHaveBeenCalled();
  succeed();
  await click("保存发布设置");
  await vi.waitFor(() =>
    expect(store.data.formAccess![form.id]!.membersEnabled).toBe(false),
  );
  expect(store.data.formAccess![form.id]!.groups[0]!.id).toBe("existing-group");
  toggle().click();
  await nextTick();
  expect(document.querySelector(".access-group-card")!.textContent).toContain(
    "原权限组",
  );
  expect(button("保存发布设置").disabled).toBe(false);
  expect(store.data.formAccess![form.id]!.membersEnabled).toBe(false);
});

it("retains collection limits while paused and opens their controls when validation fails", async () => {
  await mount();
  const details =
    document.querySelector<HTMLDetailsElement>(".access-collection")!;
  expect(details.open).toBe(false);
  await edit("收集数量上限", "20");
  document
    .querySelector<HTMLButtonElement>('[aria-label="允许收集新数据"]')!
    .click();
  await nextTick();
  expect(document.body.textContent).toContain("已暂停新提交");
  expect(input("收集数量上限").value).toBe("20");
  succeed();
  await click("保存发布设置");
  await vi.waitFor(() =>
    expect(store.data.formAccess![form.id]!.filling.enabled).toBe(false),
  );
  expect(store.data.formAccess![form.id]!.filling.limit).toBe(20);
  await edit("收集数量上限", "-1");
  await click("保存发布设置");
  expect(document.body.textContent).toContain("收集上限应为非负整数");
  expect(details.open).toBe(true);
  expect(store.saveFormAccess).toHaveBeenCalledOnce();
});

it("copies the selected entry and leaves a selectable link when clipboard access fails", async () => {
  publish(1);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    await mount();
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((el) => el.textContent?.trim() === "复制链接");
    const fill = document.querySelector<HTMLInputElement>(
      '[aria-label="表单填写链接"]',
    )!;
    const member = document.querySelector<HTMLInputElement>(
      '[aria-label="成员入口链接"]',
    )!;
    buttons[0]!.click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(fill.value),
    );
    buttons[1]!.click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(member.value),
    );
    writeText.mockRejectedValueOnce(Error("denied"));
    buttons[0]!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(fill));
    expect(fill.selectionStart).toBe(0);
    expect(fill.selectionEnd).toBe(fill.value.length);
    expect(store.notify).toHaveBeenLastCalledWith(
      "自动复制未完成，请复制已选中的链接。",
      "warning",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("moves visible groups across archived entries and keeps copies disabled until explicitly enabled", async () => {
  const original = store.data.formAccess![form.id]!.groups[0]!;
  store.data.formAccess![form.id]!.groups.push(
    { ...copy(original), id: "archive", name: "已归档组", archived: true },
    { ...copy(original), id: "second", name: "第二组" },
  );
  await mount();
  const cards = () => [
    ...document.querySelectorAll<HTMLElement>(".access-group-card"),
  ];
  expect(cards()).toHaveLength(2);
  await click("下移", cards()[0]);
  expect(cards().map((el) => el.querySelector("strong")!.textContent)).toEqual([
    "第二组",
    "原权限组",
  ]);
  expect(button("上移", cards()[0]).disabled).toBe(true);
  expect(button("下移", cards()[1]).disabled).toBe(true);
  await click("复制", cards()[0]);
  const copied = cards().at(-1)!;
  expect(copied.textContent).toContain("第二组（副本）");
  expect(copied.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
  await click("归档", copied);
  await click("已归档");
  expect(cards()).toHaveLength(2);
  await click(
    "恢复",
    cards().find((el) => el.textContent!.includes("第二组（副本）"))!,
  );
  await click("返回权限组");
  succeed();
  await click("保存发布设置");
  await vi.waitFor(() => expect(store.saveFormAccess).toHaveBeenCalledOnce());
  expect(
    store.data.formAccess![form.id]!.groups.map((g) => g.id).slice(0, 3),
  ).toEqual(["second", "archive", "existing-group"]);
  expect(store.data.formAccess![form.id]!.groups.at(-1)!.enabled).toBe(false);
});

it("keeps publication pending visible, prevents duplicate requests and offers an actionable failure", async () => {
  publish(1);
  store.drafts[form.id] = copy(form);
  store.data.forms.push(copy(form));
  await mount(true);
  let finish!: (result: boolean) => void;
  store.publishForm.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await click("发布新版本");
  expect(button("正在发布…").disabled).toBe(true);
  await click("正在发布…");
  expect(store.publishForm).toHaveBeenCalledOnce();
  finish(false);
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain(
      "发布未完成",
    ),
  );
  expect(button("重试发布")).toBeDefined();
  expect(
    store.data.forms.find((f) => f.id === form.id)!.published!.version,
  ).toBe(1);
  store.publishForm.mockRejectedValueOnce(Error("offline"));
  await click("重试发布");
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain("发布失败"),
  );
  expect(store.publishForm).toHaveBeenCalledTimes(2);
  store.publishForm.mockResolvedValueOnce(true);
  await click("重试发布");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(store.publishForm).toHaveBeenCalledTimes(3);
});
