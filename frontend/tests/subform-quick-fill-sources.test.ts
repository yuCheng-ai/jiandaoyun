// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { computed, createApp, h, nextTick, provide, reactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  copy,
  createField,
  emptySchema,
  type FormValues,
} from "../src/domain/form";
import {
  defaultAccess,
  memberContext,
  newAccessGroup,
} from "../src/domain/access";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";
import { runtimeDataKey } from "../src/composables/useRuntimeData";
import FormFields from "../src/features/forms/components/FormFields.vue";

const cleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
});
async function click(name: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent?.trim() === name);
  expect(button, name).toBeTruthy();
  button!.click();
  await nextTick();
  await nextTick();
}
function cell(label: string) {
  const input = document.querySelector<HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  expect(input, label).not.toBeNull();
  return input!;
}
async function mount(granted = false) {
  const data = seedWorkspace();
  const source = newForm("oa", "动态目录", "form");
  source.id = "quick-source";
  source.schema.fields = [
    createField("text", { id: "name" }),
    createField("number", { id: "amount" }),
  ];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-11",
  };
  source.versions = [copy(source.published)];
  data.forms.push(source);
  data.entries.push({
    id: "source-row",
    formId: source.id,
    definitionVersion: 1,
    status: "submitted",
    createdAt: "2026-10-11",
    values: { name: "目录选项", amount: 3 },
    history: [],
  });
  const grant = newAccessGroup(source.schema);
  grant.identities = ["zhang"];
  grant.actions = ["view"];
  data.formAccess = {
    ...data.formAccess,
    [source.id]: {
      ...defaultAccess(),
      membersEnabled: true,
      groups: granted ? [grant] : [],
    },
  };
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
  const pinia = createPinia(),
    owner = useWorkspaceStore(pinia),
    other = useWorkspaceStore(createPinia());
  const schema = emptySchema();
  const choice = createField("select", { id: "choice", label: "分类" });
  choice.choiceSource = {
    ...choice.choiceSource,
    mode: "form",
    formId: source.id,
    labelFieldId: "name",
    filters: [
      {
        id: "filter",
        sourceFieldId: "amount",
        operator: "equals",
        source: "field",
        value: "qty",
      },
    ],
  };
  const person = createField("member", { id: "person", label: "经办人" });
  person.organization.scope.mode = "fieldDepartment";
  person.organization.scope.fieldId = "dept";
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      subformQuickFill: true,
      children: [
        choice,
        person,
        createField("department", { id: "dept", label: "部门" }),
        createField("number", { id: "qty", label: "数量" }),
        createField("text", { id: "note", label: "备注" }),
      ],
    }),
  ];
  const values = reactive<FormValues>({ lines: [] });
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  const app = createApp({
    setup() {
      provide(
        runtimeDataKey,
        computed(() => memberContext(owner.data, "zhang")),
      );
      return () =>
        h(FormFields, {
          fields: schema.fields,
          schema,
          values,
          onChange: (id: string, value: unknown) => {
            values[id] = value;
          },
        });
    },
  });
  app.use(pinia).use(router).mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  const draft = owner.openForm("employee")!;
  draft.title = "仍未保存的其他表单";
  await click("快速填报");
  const input = cell("第1行 分类");
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "目录选项\t王五\t研发部\t3\t保留说明" },
  });
  input.dispatchEvent(event);
  await nextTick();
  await click("下一步");
  return {
    owner,
    other,
    source,
    grant,
    schema,
    values,
    originalEntries: copy(data.entries),
    draft,
  };
}

it("uses newly granted source access when continuing a staged fill without losing input or unrelated drafts", async () => {
  const f = await mount();
  await click("确定");
  expect(cell("第1行 分类").getAttribute("title")).toContain("选项不匹配");
  expect(f.values.lines).toEqual([]);
  expect(
    await f.other.saveFormAccess(f.source.id, {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [f.grant],
    }),
  ).toBe(true);
  expect(
    memberContext(f.owner.data, "zhang").entries.some(
      (e) => e.id === "source-row",
    ),
  ).toBe(false);
  await click("继续操作");
  expect(f.values.lines).toEqual([
    expect.objectContaining({
      choice: "source-row",
      person: "wang",
      dept: "engineering",
      qty: 3,
      note: "保留说明",
    }),
  ]);
  expect(f.draft.title).toBe("仍未保存的其他表单");
  expect(f.owner.data.entries).toEqual(f.originalEntries);
  expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!).entries).toEqual(
    f.originalEntries,
  );
});

it("rejects a source selection revoked on another page before changing original rows", async () => {
  const f = await mount(true);
  expect(
    await f.other.saveFormAccess(f.source.id, {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [],
    }),
  ).toBe(true);
  await click("确定");
  expect(cell("第1行 分类").getAttribute("aria-invalid")).toBe("true");
  expect(cell("第1行 备注").value).toBe("保留说明");
  expect(f.values.lines).toEqual([]);
  await click("继续操作");
  expect(f.values.lines).toEqual([
    expect.objectContaining({
      choice: "",
      person: "wang",
      dept: "engineering",
      qty: 3,
      note: "保留说明",
    }),
  ]);
  expect(f.owner.data.entries).toEqual(f.originalEntries);
  expect(f.draft.title).toBe("仍未保存的其他表单");
});

it("retains staged cells and original rows when current committed data cannot be read", async () => {
  const f = await mount(true);
  localStorage.setItem(WORKSPACE_KEY, "unreadable data");
  await click("确定");
  expect(document.body.textContent).toContain("无法读取最新表单数据");
  expect(cell("第1行 分类").value).toBe("目录选项");
  expect(cell("第1行 备注").value).toBe("保留说明");
  expect(f.values.lines).toEqual([]);
  expect(f.owner.data.entries).toEqual(f.originalEntries);
  expect(f.draft.title).toBe("仍未保存的其他表单");
  expect(localStorage.getItem(WORKSPACE_KEY)).toBe("unreadable data");
});
