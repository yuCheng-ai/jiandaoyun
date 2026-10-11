// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, toRef } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import EmployeesView from "../src/features/organization/EmployeesView.vue";
import RolesView from "../src/features/organization/RolesView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import { organizationActions } from "../src/stores/organizationActions";
import { seedWorkspace } from "../src/domain/workspace";
import { copy } from "../src/domain/form";
import { newEmployee } from "../src/domain/organization";
import {
  organizationEditContext,
  restoreBulkOrganizationDraft,
  restoreDepartmentDraft,
  restoreEmployeeDraft,
  restoreRoleDraft,
  restoreRoleGroupDraft,
} from "../src/domain/organizationDraftAdapters";

vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
vi.mock("../src/features/organization/AdminLayout.vue", () => ({
  default: {
    setup:
      (_: unknown, { slots }: any) =>
      () =>
        h("main", slots.default?.()),
  },
}));
vi.mock("../src/components/WorkspaceStorageNotice.vue", () => ({
  default: { render: () => null },
}));
const disposers = new Set<() => void>();
const actionNames = [
  "saveEmployee",
  "saveDepartment",
  "saveRole",
  "saveRoleGroup",
  "bulkEmployees",
  "removeRoleGroup",
  "archiveDepartment",
  "archiveRole",
] as const;
function makeStore() {
  const source = {
    data: seedWorkspace(),
    activeForms: [] as ReturnType<typeof seedWorkspace>["forms"],
    writePending: false,
    notices: [] as { id: string; type: string; message: string }[],
    notify: vi.fn(),
    ...Object.fromEntries(actionNames.map((name) => [name, vi.fn()])),
  } as {
    data: ReturnType<typeof seedWorkspace>;
    activeForms: ReturnType<typeof seedWorkspace>["forms"];
    writePending: boolean;
    notices: { id: string; type: string; message: string }[];
    notify: ReturnType<typeof vi.fn>;
  } & Record<(typeof actionNames)[number], ReturnType<typeof vi.fn>>;
  return reactive(source) as unknown as typeof source;
}
let store: ReturnType<typeof makeStore>,
  persist: ReturnType<typeof vi.fn>,
  actions: ReturnType<typeof organizationActions>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  store = makeStore();
  store.notify.mockImplementation((message: string, type = "success") =>
    store.notices.push({ id: `notice-${store.notices.length}`, message, type }),
  );
  store.activeForms = store.data.forms.filter((form) => !form.archived);
  persist = vi.fn(() => true);
  actions = organizationActions(toRef(store, "data"), persist, store.notify);
  for (const name of actionNames)
    store[name].mockImplementation(async (...args: any[]) =>
      (actions[name] as (...args: any[]) => boolean)(...args),
    );
  vi.mocked(useWorkspaceStore).mockReturnValue(store as any);
});
afterEach(() => {
  [...disposers].forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
const named = <T extends HTMLElement>(
  label: string,
  scope: ParentNode = document,
) =>
  [...scope.querySelectorAll<T>("[aria-label]")].find(
    (el) => el.getAttribute("aria-label") === label,
  )!;
const button = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === name || el.textContent?.trim() === name,
  )!;
async function click(name: string, scope?: ParentNode) {
  const target = button(name, scope);
  expect(target, name).toBeDefined();
  target.click();
  await nextTick();
}
async function edit(label: string, value: string) {
  const input = named<HTMLInputElement>(label);
  expect(input, label).toBeDefined();
  input.value = value;
  input.dispatchEvent(
    new Event(input.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await nextTick();
}
async function check(label: string, checked = true) {
  const input = named<HTMLInputElement>(label);
  expect(input, label).toBeDefined();
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}
async function restore() {
  await click("恢复内容");
  await click("确认恢复");
}
async function mount(kind: "members" | "roles" = "members") {
  const pinia = createPinia(),
    path = kind === "members" ? "/admin/organization" : "/admin/roles";
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/admin/organization", component: EmployeesView },
      { path: "/admin/roles", component: RolesView },
      { path: "/other", component: { render: () => h("p", "其他页面") } },
    ],
  });
  await router.push(path);
  const app = createApp({ render: () => h(RouterView) });
  app.use(pinia).use(router).mount(document.getElementById("app")!);
  await nextTick();
  const unmount = () => {
    app.unmount();
    disposers.delete(unmount);
  };
  disposers.add(unmount);
  return { unmount, router, drafts: useEditorDraftStore(pinia) };
}

it("recovers an unfinished new employee including role assignments and only clears the copy after successful save", async () => {
  const first = await mount();
  await click("添加成员");
  await edit("成员姓名", "恢复成员");
  await edit("成员工号", "");
  await edit("成员职务", "待保存岗位");
  const roleId = store.data.organization.roles[1]!.id;
  const assigned = document.querySelector<HTMLInputElement>(
    `.role-checkboxes input[value='${roleId}']`,
  )!;
  assigned.checked = true;
  assigned.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  const id = (first.drafts.entries[0]!.value as any).employee.id;
  first.unmount();
  const second = await mount();
  await click("添加成员");
  await restore();
  expect(named<HTMLInputElement>("成员姓名").value).toBe("恢复成员");
  expect(named<HTMLInputElement>("成员工号").value).toBe("");
  expect(named<HTMLInputElement>("成员职务").value).toBe("待保存岗位");
  expect(
    document.querySelector<HTMLInputElement>(
      `.role-checkboxes input[value='${roleId}']`,
    )!.checked,
  ).toBe(true);
  await click("保存");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("保存未完成"),
  );
  expect(
    document.querySelector("dialog [role='alert']")?.textContent,
  ).toContain("请输入工号");
  expect(store.data.organization.employees.some((item) => item.id === id)).toBe(
    false,
  );
  expect(second.drafts.entries).toHaveLength(1);
  await edit("成员工号", "E0042");
  await click("保存");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(
    store.data.organization.employees.find((item) => item.id === id)?.name,
  ).toBe("恢复成员");
  expect(
    store.data.organization.roles.find((role) => role.id === roleId)?.memberIds,
  ).toContain(id);
  expect(second.drafts.entries).toHaveLength(0);
});

it("keeps department input on failed or thrown saves, locks pending writes and retries the same identity", async () => {
  const current = await mount();
  await click("新建部门");
  await edit("部门名称", "恢复部门");
  store.saveDepartment.mockResolvedValueOnce(false);
  await click("保存");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("保存未完成"),
  );
  store.saveDepartment.mockRejectedValueOnce(Error("disk unavailable"));
  await click("保存");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("保存失败"),
  );
  let finish!: (value: boolean) => void;
  store.saveDepartment.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await click("保存");
  expect(document.querySelector("dialog")?.getAttribute("aria-busy")).toBe(
    "true",
  );
  await click("保存");
  await click("关闭", document.querySelector("dialog")!);
  expect(store.saveDepartment).toHaveBeenCalledTimes(3);
  expect(document.querySelector("dialog")).not.toBeNull();
  finish(false);
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.getAttribute("aria-busy")).toBe(
      "false",
    ),
  );
  const id = store.saveDepartment.mock.calls[0]![0].id;
  await click("保存");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(
    store.saveDepartment.mock.calls.every((call) => call[0].id === id),
  ).toBe(true);
  expect(
    store.data.organization.departments.filter((item) => item.id === id),
  ).toHaveLength(1);
  expect(current.drafts.entries).toHaveLength(0);
});

it("restores new role groups with stable identities and explicit cancel/discard decisions", async () => {
  const first = await mount("roles");
  await click("新建分组");
  await edit("角色分组名称", "协作恢复组");
  const id = (first.drafts.entries[0]!.value as any).id;
  await click("取消");
  expect(document.querySelector("dialog")).not.toBeNull();
  await click("继续编辑");
  first.unmount();
  const second = await mount("roles");
  await click("新建分组");
  await restore();
  await click("保存");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(
    store.data.organization.roleGroups.find((group) => group.id === id)?.name,
  ).toBe("协作恢复组");
  expect(second.drafts.entries).toHaveLength(0);
  await click("新建分组");
  await edit("角色分组名称", "放弃此组");
  await click("取消");
  await click("放弃修改");
  expect(second.drafts.entries).toHaveLength(0);
  expect(
    store.data.organization.roleGroups.some(
      (group) => group.name === "放弃此组",
    ),
  ).toBe(false);
});

it("recovers role grants without widening scope or applying them before save", async () => {
  const first = await mount("roles");
  await click("新建角色");
  await edit("角色名称", "复核角色");
  await edit("角色说明", "恢复授权配置");
  await click("权限配置", document.querySelector("dialog")!);
  await click("添加授权");
  await edit("授权1应用", store.data.apps[0]!.id);
  await edit("授权1数据范围", "department");
  await check("授权1 填写提交", false);
  const formId = store.activeForms.find(
    (form) => form.appId === store.data.apps[0]!.id,
  )!.id;
  const grant = first.drafts.entries[0]!.value as any;
  // Use the actual form checkbox rendered by RoleGrantEditor.
  const forms = [
    ...document.querySelectorAll<HTMLInputElement>(".grant-form-select input"),
  ];
  expect(forms.length).toBeGreaterThan(0);
  forms[0]!.checked = true;
  forms[0]!.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  const id = grant.id;
  first.unmount();
  const second = await mount("roles");
  await click("新建角色");
  await restore();
  expect(store.data.organization.roles.some((role) => role.id === id)).toBe(
    false,
  );
  await click("权限配置", document.querySelector("dialog")!);
  expect(named<HTMLSelectElement>("授权1数据范围").value).toBe("department");
  expect(named<HTMLInputElement>("授权1 填写提交").checked).toBe(false);
  await click("保存");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(
    store.data.organization.roles.find((role) => role.id === id)?.grants,
  ).toEqual([
    {
      appId: store.data.apps[0]!.id,
      formIds: [formId],
      actions: ["view"],
      dataScope: "department",
    },
  ]);
  expect(second.drafts.entries).toHaveLength(0);
});

it("blocks restoring or overwriting organization edits after the source or current member changes", async () => {
  const first = await mount();
  await click("编辑王五");
  await edit("成员职务", "旧草稿岗位");
  store.data.organization.employees.find(
    (employee) => employee.id === "wang",
  )!.position = "已更新岗位";
  await click("保存");
  expect(store.saveEmployee).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("组织或授权对象已变化");
  first.unmount();
  const second = await mount();
  await click("编辑王五");
  expect(named<HTMLInputElement>("成员职务").value).toBe("已更新岗位");
  expect(button("恢复内容").disabled).toBe(true);
  expect(second.drafts.entries).toHaveLength(1);
  await click("取消");
  await click("添加成员");
  await edit("成员姓名", "另一成员草稿");
  second.unmount();
  store.data.organization.currentUserId = "li";
  await mount();
  await click("添加成员");
  expect(button("恢复内容").disabled).toBe(true);
});

it("protects route navigation until changes are explicitly discarded", async () => {
  const current = await mount("roles");
  await click("新建角色");
  await edit("角色名称", "未保存角色");
  await current.router.push("/other");
  expect(current.router.currentRoute.value.path).toBe("/admin/roles");
  expect(document.body.textContent).toContain("修改尚未保存");
  await click("继续编辑");
  await current.router.push("/other");
  await click("放弃修改");
  await vi.waitFor(() =>
    expect(current.router.currentRoute.value.path).toBe("/other"),
  );
  expect(current.drafts.entries).toHaveLength(0);
});

it("restores a batch only for the same selected members and retains selection on save failure", async () => {
  const first = await mount();
  await check("选择成员王五");
  await check("选择成员赵六");
  await click("修改状态");
  await edit("批量成员状态", "left");
  first.unmount();
  const second = await mount();
  await check("选择成员赵六");
  await check("选择成员王五");
  await click("修改状态");
  await restore();
  expect(named<HTMLSelectElement>("批量成员状态").value).toBe("left");
  store.bulkEmployees.mockResolvedValueOnce(false);
  await click("保存");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("保存未完成"),
  );
  expect(
    store.data.organization.employees.find(
      (employee) => employee.id === "wang",
    )!.status,
  ).toBe("active");
  await click("保存");
  await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(
    store.data.organization.employees
      .filter((employee) => ["wang", "zhao"].includes(employee.id))
      .every((employee) => employee.status === "left"),
  ).toBe(true);
  expect(second.drafts.entries).toHaveLength(0);
});

it("shows temporary retention failures and can checkpoint the same input after retry", async () => {
  const current = await mount();
  await click("新建部门");
  await edit("部门名称", "暂存重试部门");
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("quota");
    });
  current.drafts.retryCapture(current.drafts.entries[0]!.key);
  await nextTick();
  expect(document.body.textContent).toContain("当前内容暂未自动保留");
  expect(named<HTMLInputElement>("部门名称").value).toBe("暂存重试部门");
  storage.mockRestore();
  await click("重试暂存");
  expect(current.drafts.isCheckpoint(current.drafts.entries[0]!)).toBe(true);
});

it("rechecks the organization baseline inside the persistence action after an asynchronous wait", () => {
  const baseline = organizationEditContext(store.data),
    employee = copy(
      store.data.organization.employees.find(
        (employee) => employee.id === "wang",
      )!,
    );
  employee.position = "陈旧修改";
  store.data.organization.employees.find(
    (employee) => employee.id === "wang",
  )!.position = "另一方的新岗位";
  expect(actions.saveEmployee(employee, [], baseline)).toBe(false);
  expect(persist).not.toHaveBeenCalled();
  expect(
    store.data.organization.employees.find(
      (employee) => employee.id === "wang",
    )!.position,
  ).toBe("另一方的新岗位");
});

it("recovery adapters preserve unfinished values and reject identity collisions, unsafe shapes and broader grants", () => {
  const employee = newEmployee();
  employee.name = "";
  employee.number = "";
  employee.primaryDepartmentId = "";
  expect(restoreEmployeeDraft({ employee, roleIds: [] }).employee).toEqual(
    employee,
  );
  expect(() =>
    restoreEmployeeDraft({ employee, roleIds: [] }, "another-id"),
  ).toThrow("身份");
  expect(() =>
    restoreEmployeeDraft({ employee, roleIds: [] }, undefined, [employee.id]),
  ).toThrow("身份");
  expect(
    restoreDepartmentDraft({
      id: "new",
      name: "",
      parentId: null,
      managerIds: [],
      archived: false,
    }).name,
  ).toBe("");
  expect(restoreRoleGroupDraft({ id: "group-new", name: "" }).name).toBe("");
  const role = copy(store.data.organization.roles[0]!);
  role.grants = [
    { appId: "oa", formIds: [], actions: ["view"], dataScope: "self" },
  ];
  expect(restoreRoleDraft(role, role.id).grants).toEqual(role.grants);
  expect(() =>
    restoreRoleDraft(
      { ...role, grants: [{ ...role.grants[0], actions: ["root"] }] },
      role.id,
    ),
  ).toThrow("授权");
  expect(() =>
    restoreRoleDraft(JSON.parse('{"__proto__":{},"id":"unsafe"}')),
  ).toThrow("不允许");
  expect(() =>
    restoreBulkOrganizationDraft({ ids: ["li"], value: "left" }, ["wang"]),
  ).toThrow("当前选择");
});
