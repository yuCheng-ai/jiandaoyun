import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import {
  defaultAccess,
  newAccessGroup,
  parseAccess,
} from "../src/domain/access";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
import { seedWorkspace } from "../src/domain/workspace";
import {
  memberImportColumns,
  prepareImportRows,
  recordImportModes,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import type { ExcelValue } from "../src/services/excel";
let memory: Map<string, string>,
  failSave = false;
beforeEach(() => {
  failSave = false;
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failSave) throw Error("quota");
      memory.set(k, v);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
async function fixture(kind: "form" | "workflow" = "form") {
  const store = useWorkspaceStore(createPinia()),
    draft = store.openForm(
      (await store.createForm("oa", "成员导入", kind))!.id,
    )!;
  draft.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: true,
    }),
    createField("number", { id: "amount", label: "数量", min: 0, max: 10 }),
    createField("text", { id: "private", label: "内部说明" }),
    createField("number", { id: "default", defaultValue: 9 }),
    createField("calculated", { id: "calc", expression: "{{amount}}*2" }),
    createField("serial", {
      id: "serial",
      serial: {
        digits: 3,
        fixed: true,
        reset: "none",
        initial: 1,
        rules: [{ id: "count", type: "counter" }],
      },
    }),
  ];
  await store.publishForm(draft.id);
  const mine = (await store.submitEntry(
    draft.id,
    { name: "本人", amount: 2, private: "原内部值" },
    "submitted",
    undefined,
    "zhang",
  ))!;
  const other = (await store.submitEntry(
    draft.id,
    { name: "别人", amount: 3, private: "另一条" },
    "submitted",
    undefined,
    "li",
  ))!;
  const form = store.data.forms.find((f) => f.id === draft.id)!;
  const group = newAccessGroup(form.published!.schema, "self");
  group.id = "import-group";
  group.identities = ["zhang"];
  group.actions = ["view", "edit", "import"];
  group.fields.private = "hidden";
  group.fields.serial = "read";
  group.fields.default = "read";
  const access = { ...defaultAccess(), membersEnabled: true, groups: [group] };
  expect(await store.saveFormAccess(form.id, access)).toBe(true);
  const member = { actorId: "zhang", selection: group.id };
  const request = (
    rows: ExcelValue[][],
    fields: string[],
    extra: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => ({
    member,
    mode: "create",
    validate: false,
    triggerWorkflow: false,
    definitionVersion: form.published!.version,
    firstRow: 2,
    rows,
    mapping: fields.map((fieldId, column) => ({
      column,
      fieldId,
      type:
        fieldId === "data_id"
          ? "data_id"
          : form.published!.schema.fields.find((f) => f.id === fieldId)!.type,
    })),
    targets: [mine, other].map(({ id, definitionVersion, values }) => ({
      id,
      definitionVersion,
      values: copy(values),
    })),
    ...extra,
  });
  return { store, form, mine, other, group, access, member, request };
}
it("preserves independent import rights without granting them to previously saved groups", () => {
  const old = parseAccess({
    membersEnabled: true,
    groups: [
      {
        id: "g",
        actions: ["view", "create", "edit", "export"],
        identities: ["zhang"],
      },
    ],
  });
  expect(old.groups[0]!.actions).not.toContain("import");
  expect(
    parseAccess({
      ...old,
      groups: [{ ...old.groups[0], actions: ["view", "import"] }],
    }).groups[0]!.actions,
  ).toEqual(["view", "import"]);
});
it("creates with import but no add right, always validates, skips required/default/formula filling and records selected actor", async () => {
  const f = await fixture();
  f.access.groups[0]!.actions = ["view", "import"];
  await f.store.saveFormAccess(f.form.id, f.access);
  await f.store.setCurrentUser("li");
  const result = await f.store.importEntries(
    f.form.id,
    f.request(
      [
        ["导入", 0],
        ["超范围", 11],
      ],
      ["name", "amount"],
    ),
  );
  expect(result).toMatchObject({ created: 1, updated: 0 });
  const entry = f.store.data.entries.find((e) => e.values.name === "导入")!;
  expect(entry.values).toEqual({ name: "导入", amount: 0, serial: "003" });
  expect(entry.createdBy).toBe("zhang");
  expect(entry.createdDepartmentIds).toEqual(
    f.store.data.organization.employees.find((e) => e.id === "zhang")!
      .departmentIds,
  );
  expect(entry.history[0]!.label).toBe("张三");
  expect(result && result.rows[1]!.kind).toBe("error");
});
it("updates only the same group's records, retains protected values and treats out-of-scope and unknown IDs alike", async () => {
  const f = await fixture(),
    before = copy(f.mine.values),
    other = copy(f.other.values);
  const r = await f.store.importEntries(
    f.form.id,
    f.request(
      [
        [f.mine.id, 0],
        [f.other.id, 6],
        ["unknown", 7],
        [f.mine.id, 8],
      ],
      ["data_id", "amount"],
      { mode: "update" },
    ),
  );
  expect(r).toMatchObject({ created: 0, updated: 1 });
  expect(f.mine.values).toEqual({ ...before, amount: 0 });
  expect(f.other.values).toEqual(other);
  expect(r && r.rows[1]!.message).toBe(r && r.rows[2]!.message);
  expect(r && r.rows[3]!.kind).toBe("skip");
});
it("rejects forged readonly/hidden/serial mappings, mixed mode, and edit rights borrowed from another group", async () => {
  const f = await fixture();
  for (const id of ["private", "default", "serial"])
    expect(() =>
      prepareImportRows(
        f.form,
        f.request([[f.mine.id, "改"]], ["data_id", id], { mode: "update" }),
        f.store.data,
      ),
    ).toThrow("导入权限");
  expect(() =>
    prepareImportRows(
      f.form,
      f.request([["改"]], ["name"], { mode: "both" }),
      f.store.data,
    ),
  ).toThrow("导入权限");
  f.access.groups[0]!.actions = ["view", "import"];
  f.access.groups.push({
    ...copy(f.group),
    id: "other-edit",
    actions: ["view", "edit"],
  });
  await f.store.saveFormAccess(f.form.id, f.access);
  expect(recordImportModes(f.form, f.store.data, f.member)).toEqual(["create"]);
  expect(
    recordImportModes(f.form, f.store.data, { ...f.member, selection: "*" }),
  ).toEqual(["create"]);
  expect(
    await f.store.importEntries(
      f.form.id,
      f.request([[f.mine.id, 0]], ["data_id", "amount"], { mode: "update" }),
    ),
  ).toBe(false);
});
it("member updates bypass required and full form calculations, and blank cells retain their original values", async () => {
  const f = await fixture(),
    before = copy(f.mine.values);
  const r = await f.store.importEntries(
    f.form.id,
    f.request([[f.mine.id, ""]], ["data_id", "amount"], { mode: "update" }),
  );
  expect(r).toMatchObject({ updated: 1 });
  expect(f.mine.values).toEqual(before);
  const empty = await f.store.importEntries(
    f.form.id,
    f.request([[0]], ["amount"]),
  );
  expect(empty).toMatchObject({ created: 1 });
  expect(
    f.store.data.entries.find((e) => e.id !== f.mine.id && e.id !== f.other.id)
      ?.values,
  ).toEqual({ amount: 0, serial: "003" });
});
it("enforces 10,000 physical rows and uniqueness across records the member cannot view", async () => {
  const f = await fixture();
  expect(() =>
    prepareImportRows(
      f.form,
      f.request(
        Array.from({ length: 10001 }, () => [0]),
        ["amount"],
      ),
      f.store.data,
    ),
  ).toThrow("1 万行");
  const r = await f.store.importEntries(
    f.form.id,
    f.request([["别人"]], ["name"]),
  );
  expect(r).toMatchObject({ created: 0 });
  expect(r && r.rows[0]!.message).toContain("不能重复");
});
it("rechecks revoked import/field permissions and inactive members under the shared write lock", async () => {
  for (const revoke of ["import", "field", "actor"]) {
    const f = await fixture(),
      request = f.request([[f.mine.id, 0]], ["data_id", "amount"], {
        mode: "update",
      }),
      before = copy(f.mine.values);
    const other = useWorkspaceStore(createPinia());
    if (revoke === "actor") {
      expect(await other.setCurrentUser("li")).toBe(true);
      const actor = copy(
        other.data.organization.employees.find((e) => e.id === "zhang")!,
      );
      actor.status = "inactive";
      expect(await other.saveEmployee(actor)).toBe(true);
    } else {
      const access = copy(f.access);
      if (revoke === "import") access.groups[0]!.actions = ["view", "edit"];
      else access.groups[0]!.fields.amount = "read";
      expect(await other.saveFormAccess(f.form.id, access)).toBe(true);
    }
    expect(await f.store.importEntries(f.form.id, request)).toBe(false);
    expect(
      new LocalWorkspaceRepository()
        .load()!
        .entries.find((e) => e.id === f.mine.id)!.values,
    ).toEqual(before);
    expect(f.store.storageConflict).toBe(false);
  }
});
it("does not block on another form's edit and preserves a failed save's values and serial counter for retry", async () => {
  const f = await fixture(),
    request = f.request([["重试", 0]], ["name", "amount"]),
    counter = copy(f.store.data.serialCounters);
  await useWorkspaceStore(createPinia()).createForm("oa", "另一张表", "form");
  failSave = true;
  expect(await f.store.importEntries(f.form.id, request)).toBe(false);
  expect(f.store.data.serialCounters).toEqual(counter);
  expect(f.store.data.entries).toHaveLength(2);
  failSave = false;
  expect(await f.store.importEntries(f.form.id, request)).toMatchObject({
    created: 1,
  });
  expect(f.store.storageConflict).toBe(false);
});
it("keeps historical readonly fields unchanged and excludes them from validation while updating editable fields", async () => {
  const f = await fixture();
  const old = copy(f.form.versions[0]!);
  old.schema.fields.find((x) => x.id === "amount")!.editable = false;
  f.form.versions[0] = old;
  const rows = prepareImportRows(
    f.form,
    f.request([[f.mine.id, 11, "新名称"]], ["data_id", "amount", "name"], {
      mode: "update",
    }),
    f.store.data,
  );
  expect(rows[0]!.kind).toBe("update");
  expect(rows[0]!.values).toEqual({ ...f.mine.values, name: "新名称" });
  expect(
    memberImportColumns(f.form, "update", f.store.data, f.member).map(
      (c) => c.field.id,
    ),
  ).not.toContain("private");
});
it("reuses workflow start permissions and the existing importer without allowing protected creation fields", async () => {
  const f = await fixture("workflow");
  f.form.published!.workflow.nodes.find(
    (n) => n.data.kind === "start",
  )!.data.permissions.amount = "read";
  expect(
    memberImportColumns(f.form, "create", f.store.data, f.member).map(
      (c) => c.field.id,
    ),
  ).not.toContain("amount");
  expect(() =>
    prepareImportRows(f.form, f.request([[0]], ["amount"]), f.store.data),
  ).toThrow("导入权限");
  expect(() =>
    prepareImportRows(
      f.form,
      f.request(
        Array.from({ length: 301 }, () => [0]),
        ["default"],
        { triggerWorkflow: true },
      ),
      f.store.data,
    ),
  ).toThrow("300");
});
it("does not expose hidden/read-only container children after flattening tabs for a creation template", async () => {
  const f = await fixture();
  f.form.published!.schema.fields = [
    createField("tabs", {
      id: "tab",
      visible: false,
      children: [createField("text", { id: "child" })],
    }),
    createField("subform", {
      id: "lines",
      editable: false,
      children: [
        createField("text", { id: "line" }),
        createField("number", { id: "qty" }),
      ],
    }),
  ];
  expect(memberImportColumns(f.form, "create", f.store.data, f.member)).toEqual(
    [],
  );
});
it("matches only readable related source records and never uses a hidden source field as an import key", async () => {
  const f = await fixture(),
    source = (await f.store.createForm("oa", "客户", "form"))!,
    draft = f.store.openForm(source.id)!;
  draft.schema.fields = [
    createField("text", { id: "client", label: "客户编号" }),
    createField("text", { id: "secret", label: "内部编号" }),
  ];
  await f.store.publishForm(source.id);
  const mine = (await f.store.submitEntry(
    source.id,
    { client: "C-A", secret: "S-A" },
    "submitted",
    undefined,
    "zhang",
  ))!;
  await f.store.submitEntry(
    source.id,
    { client: "C-B", secret: "S-B" },
    "submitted",
    undefined,
    "li",
  );
  const group = newAccessGroup(draft.schema, "self");
  group.identities = ["zhang"];
  group.actions = ["view"];
  group.fields.secret = "hidden";
  await f.store.saveFormAccess(source.id, {
    ...defaultAccess(),
    membersEnabled: true,
    groups: [group],
  });
  const relation = createField("relation", {
    id: "customer",
    referenceFormId: source.id,
  });
  f.form.published!.schema.fields.push(relation);
  f.form.versions[0]!.schema.fields.push(copy(relation));
  const request = f.request([["C-A"], ["C-B"]], ["customer"]);
  request.mapping[0]!.matchFieldId = "client";
  const rows = prepareImportRows(f.form, request, f.store.data);
  expect(rows[0]!.values?.customer).toBe(mine.id);
  expect(rows[1]!.kind).toBe("error");
  request.mapping[0]!.matchFieldId = "secret";
  expect(() => prepareImportRows(f.form, request, f.store.data)).toThrow(
    "匹配字段",
  );
});
