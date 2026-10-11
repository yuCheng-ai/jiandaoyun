import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "../src/stores/workspace";
import { createField, copy, flattenFields } from "../src/domain/form";
import {
  defaultAccess,
  newAccessGroup,
  parseAccess,
  accessIssues,
  eligibleGroups,
  groupsForEntry,
  memberSchema,
  visibleValues,
  canEntry,
  memberContext,
  fillingIssue,
  prepareMemberUpdate,
  creationSchema,
  entryAccessSchema,
  accessFieldImpacts,
  prepareMemberCreate,
} from "../src/domain/access";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
} from "../src/repositories/workspaceRepository";
import { createRelationDemo } from "../src/domain/relationDemo";
import { emptySchema } from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
it("creation cannot inject subform rows through hidden or readonly tab containers", () => {
  for (const flags of [{ editable: false }, { visible: false }]) {
    const schema = emptySchema();
    schema.fields = [
      createField("tabs", {
        id: "tabs",
        ...flags,
        children: [
          createField("subform", {
            id: "rows",
            children: [createField("text", { id: "sku" })],
          }),
        ],
      }),
      createField("text", { id: "outside" }),
    ];
    const result = prepareMemberCreate(
      schema,
      { rows: [{ sku: "未授权商品" }], outside: "可写" },
      seedWorkspace(),
    );
    expect(result.rows).toEqual([]);
    expect(result.outside).toBe("可写");
  }
});
beforeEach(() => {
  const memory = new Map();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  });
  setActivePinia(createPinia());
});
async function setup() {
  const store = useWorkspaceStore(),
    form = store.openForm(
      (await store.createForm("oa", "权限测试", "form"))!.id,
    )!;
  form.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: true,
    }),
    createField("number", { id: "amount", label: "金额", min: 0 }),
    createField("text", { id: "private", label: "内部备注" }),
    createField("member", { id: "owner", label: "负责人" }),
    createField("calculated", {
      id: "total",
      label: "双倍",
      expression: "{{amount}}*2",
    }),
  ];
  await store.publishForm(form.id);
  const mine = (await store.submitEntry(
      form.id,
      { name: "本人", amount: 2, private: "机密", owner: "zhang", total: 4 },
      "submitted",
      undefined,
      "zhang",
    ))!,
    other = (await store.submitEntry(
      form.id,
      { name: "他人", amount: 3, private: "隐藏", owner: "wang", total: 6 },
      "submitted",
      undefined,
      "wang",
    ))!;
  const self = newAccessGroup(form.schema, "self");
  self.identities = ["zhang"];
  self.fields.private = "hidden";
  const config = { ...defaultAccess(), membersEnabled: true, groups: [self] };
  expect(await store.saveFormAccess(form.id, config)).toBe(true);
  return { store, form, mine, other, self, config };
}
describe("member publication and runtime access", () => {
  it("migrates optional access settings and owner metadata without guessing old record owners", async () => {
    const { store, form, mine } = await setup();
    const parsed = parseWorkspace(JSON.stringify(store.data));
    expect(parsed.formAccess![form.id]!.groups).toHaveLength(1);
    expect(parsed.entries.find((e) => e.id === mine.id)!.createdBy).toBe(
      "zhang",
    );
    delete mine.createdBy;
    delete mine.createdDepartmentIds;
    expect(groupsForEntry(store.data, mine, "zhang")).toEqual([]);
    expect(parseAccess(undefined)).toEqual(defaultAccess());
  });
  it("validates group membership, actions, condition references and collection windows", async () => {
    const { store, form, config, self } = await setup();
    self.identities = [];
    self.actions = ["edit"];
    self.scope = "custom";
    self.filters = [];
    config.filling.startsAt = "2026-10-10T09:00";
    config.filling.endsAt = "2026-10-09T09:00";
    expect(
      accessIssues(config, form, store.data).length,
    ).toBeGreaterThanOrEqual(4);
    expect(() => parseAccess({ ...config, groups: [self, self] })).toThrow();
  });
  it("resolves departments and roles dynamically and removes inactive members", async () => {
    const { store, form, config, self } = await setup();
    self.identities = ["product"];
    await store.saveFormAccess(form.id, config);
    expect(eligibleGroups(store.data, form.id, "li")).toHaveLength(1);
    store.data.organization.employees.find((e) => e.id === "li")!.status =
      "inactive";
    expect(eligibleGroups(store.data, form.id, "li")).toEqual([]);
    self.identities = [store.data.organization.roles[0]!.id];
    await store.saveFormAccess(form.id, config);
    expect(resolveCount()).toBeGreaterThan(0);
    function resolveCount() {
      return store.data.organization.employees.filter(
        (e) => eligibleGroups(store.data, form.id, e.id).length,
      ).length;
    }
  });
  it("keeps view-all and edit-self grants attached to the eligible record when merged", async () => {
    const { store, form, config, mine, other } = await setup();
    const read = newAccessGroup(form.schema, "read");
    read.identities = ["zhang"];
    config.groups.push(read);
    await store.saveFormAccess(form.id, config);
    expect(canEntry(store.data, other, "zhang", "view")).toBe(true);
    expect(canEntry(store.data, other, "zhang", "edit")).toBe(false);
    expect(canEntry(store.data, mine, "zhang", "edit")).toBe(true);
    expect(
      memberSchema(
        form.schema,
        groupsForEntry(store.data, other, "zhang"),
        true,
      ).fields.every((f) => !f.editable),
    ).toBe(true);
  });
  it("supports group switching, disabled merge, immediate revocation and archive", async () => {
    const { store, form, config, self, mine } = await setup();
    const read = newAccessGroup(form.schema, "read");
    read.identities = ["zhang"];
    config.groups.push(read);
    config.allowMerged = false;
    await store.saveFormAccess(form.id, config);
    expect(eligibleGroups(store.data, form.id, "zhang")).toEqual([]);
    expect(canEntry(store.data, mine, "zhang", "edit", self.id)).toBe(true);
    self.enabled = false;
    await store.saveFormAccess(form.id, config);
    expect(canEntry(store.data, mine, "zhang", "edit", self.id)).toBe(false);
    read.archived = true;
    await store.saveFormAccess(form.id, config);
    expect(eligibleGroups(store.data, form.id, "zhang", "")).toEqual([]);
  });
  it("uses ownership department snapshots and actor-dependent filter values", async () => {
    const { store, form, config, self, mine, other } = await setup();
    self.scope = "department";
    await store.saveFormAccess(form.id, config);
    expect(canEntry(store.data, mine, "zhang", "view")).toBe(true);
    expect(canEntry(store.data, other, "zhang", "view")).toBe(false);
    self.scope = "custom";
    self.filters = [
      {
        id: "f",
        sourceFieldId: "owner",
        source: "currentUser",
        operator: "equals",
        value: "",
      },
    ];
    self.identities = ["zhang", "wang"];
    await store.saveFormAccess(form.id, config);
    expect(canEntry(store.data, other, "wang", "view")).toBe(true);
    expect(canEntry(store.data, mine, "wang", "view")).toBe(false);
  });
  it("masks hidden fields in record values and relation contexts and denies new fields by default", async () => {
    const { store, form, self, mine, other } = await setup();
    const schema = memberSchema(form.schema, [self]);
    form.schema.settings.allowSubmit = false;
    expect(memberSchema(form.schema, [self], true).settings.allowSubmit).toBe(
      true,
    );
    expect(visibleValues(schema, mine.values).private).toBeUndefined();
    const context = memberContext(store.data, "zhang");
    expect(context.organization.currentUserId).toBe("zhang");
    expect(context.entries.find((e) => e.id === other.id)).toBeUndefined();
    expect(
      context.entries.find((e) => e.id === mine.id)!.values.private,
    ).toBeUndefined();
    form.schema.fields.push(createField("text", { id: "new" }));
    expect(memberSchema(form.schema, [self], true).fields.at(-1)!.visible).toBe(
      false,
    );
  });
  it("does not combine a parent permission from one group with a child permission from another", async () => {
    const { form, self } = await setup();
    const tabs = createField("tabs", {
      id: "tabs",
      children: [createField("text", { id: "child" })],
    });
    form.schema.fields = [tabs];
    const a = {
        ...copy(self),
        fields: { tabs: "edit" as const, child: "hidden" as const },
      },
      b = {
        ...copy(self),
        fields: { tabs: "hidden" as const, child: "edit" as const },
      };
    expect(
      memberSchema(form.schema, [a, b], true).fields[0]!.children[0]!.visible,
    ).toBe(false);
  });
  it("updates only permitted values, preserves hidden data and records the acting member", async () => {
    const { store, mine } = await setup();
    expect(
      await store.memberUpdate(
        mine.id,
        "zhang",
        "*",
        { ...mine.values, name: "已更名", private: "篡改", amount: 5 },
        copy(mine.values),
      ),
    ).toBe(true);
    expect(mine.values).toMatchObject({
      name: "已更名",
      private: "机密",
      amount: 5,
      total: 10,
    });
    expect(mine.history.at(-1)!.label).toBe("成员 张三");
  });
  it("rejects no-access operations, stale edits and invalid values without partial writes", async () => {
    const { store, mine, other } = await setup();
    const before = copy(mine);
    expect(
      await store.memberUpdate(
        other.id,
        "zhang",
        "*",
        { name: "越权" },
        copy(other.values),
      ),
    ).toBe(false);
    expect(
      await store.memberUpdate(
        mine.id,
        "zhang",
        "*",
        { name: "他人" },
        copy(mine.values),
      ),
    ).toBe(false);
    expect(
      await store.memberUpdate(
        mine.id,
        "zhang",
        "*",
        { amount: -1 },
        copy(mine.values),
      ),
    ).toBe(false);
    expect(
      await store.memberUpdate(mine.id, "zhang", "*", { name: "新的" }, {}),
    ).toBe(false);
    expect(await store.memberDelete(other.id, "zhang", "*")).toBe(false);
    expect(mine).toEqual(before);
  });
  it("handles create-only groups independently from existing-record field permissions", async () => {
    const { store, form, config } = await setup();
    const add = newAccessGroup(form.schema, "create");
    add.identities = ["li"];
    add.fields = {};
    config.groups = [add];
    await store.saveFormAccess(form.id, config);
    const entry = await store.memberSubmit(form.id, "li", "*", {
      name: "新增成员记录",
      amount: 4,
    });
    expect(entry?.createdBy).toBe("li");
    expect(entry?.createdDepartmentIds).toContain("product");
    expect(canEntry(store.data, entry!, "li", "view")).toBe(false);
    expect(
      await store.memberSubmit(form.id, "wang", "*", { name: "无权" }),
    ).toBeUndefined();
  });
  it("enforces stop/start, public settings, date windows, limits and repeated member submissions", async () => {
    const { store, form, config } = await setup();
    config.publicEnabled = false;
    config.filling.enabled = false;
    await store.saveFormAccess(form.id, config);
    expect(await store.submitEntry(form.id, { name: "关闭" })).toBeUndefined();
    config.filling.enabled = true;
    config.filling.limit = 2;
    await store.saveFormAccess(form.id, config);
    expect(fillingIssue(store.data, form.id, "li")).toContain("上限");
    config.filling.limit = 0;
    config.filling.allowRepeat = false;
    await store.saveFormAccess(form.id, config);
    expect(fillingIssue(store.data, form.id, "zhang")).toContain("重复");
    expect(fillingIssue(store.data, form.id, "li")).toBe("");
    config.filling.startsAt = "2026-10-10T00:00";
    config.filling.endsAt = "2026-10-11T00:00";
    await store.saveFormAccess(form.id, config);
    expect(
      fillingIssue(store.data, form.id, "li", Date.parse("2026-10-09T12:00")),
    ).toContain("尚未");
    expect(
      fillingIssue(store.data, form.id, "li", Date.parse("2026-10-11T12:00")),
    ).toContain("结束");
  });
  it("uses workflow start permissions and protects read-only defaults during member creation", async () => {
    const { store, form, config } = await setup();
    form.schema.fields.find((f) => f.id === "private")!.editable = false;
    form.schema.fields.find((f) => f.id === "private")!.defaultValue = "固定";
    await store.publishForm(form.id);
    const entry = await store.memberSubmit(form.id, "zhang", "*", {
      name: "只读创建",
      private: "恶意覆盖",
    });
    expect(entry?.values.private).toBe("固定");
    form.kind = "workflow";
    form.published!.workflow.nodes.find(
      (n) => n.data.kind === "start",
    )!.data.permissions.name = "hidden";
    expect(creationSchema(form).fields[0]!.visible).toBe(false);
  });
  it("keeps access configuration independent of immutable form versions and draft saves", async () => {
    const { store, form, config, self, mine } = await setup();
    const versions = copy(form.versions);
    self.enabled = false;
    await store.saveFormAccess(form.id, config);
    await store.saveForm(form.id);
    expect(form.versions).toEqual(versions);
    expect(canEntry(store.data, mine, "zhang", "view")).toBe(false);
  });
  it("keeps exported and printed fields inside the group granting each operation", async () => {
    const { store, form, config, self, mine } = await setup();
    self.actions.push("export", "print");
    const read = newAccessGroup(form.schema);
    read.identities = ["zhang"];
    config.groups.push(read);
    await store.saveFormAccess(form.id, config);
    expect(
      visibleValues(entryAccessSchema(store.data, mine, "zhang")!, mine.values)
        .private,
    ).toBe("机密");
    for (const action of ["export", "print"] as const)
      expect(
        visibleValues(
          entryAccessSchema(store.data, mine, "zhang", "*", action)!,
          mine.values,
        ).private,
      ).toBeUndefined();
  });
  it("retains sibling edits across tabs and protects readonly subform cells", async () => {
    const { store, form, config, self } = await setup();
    form.schema.fields.push(
      createField("tabs", {
        id: "tabs",
        children: [createField("text", { id: "tabText" })],
      }),
      createField("subform", {
        id: "rows",
        children: [
          createField("number", { id: "qty" }),
          createField("text", { id: "note" }),
        ],
      }),
    );
    expect(await store.publishForm(form.id)).toBe(true);
    self.fields = {
      ...newAccessGroup(form.schema, "manage").fields,
      private: "hidden",
      note: "read",
    };
    await store.saveFormAccess(form.id, config);
    const entry = (await store.submitEntry(form.id, {
      name: "嵌套记录",
      amount: 1,
      private: "机密",
      tabText: "原文",
      rows: [{ qty: 1, note: "保护" }],
    }))!;
    const result = prepareMemberUpdate(store.data, entry, "zhang", "*", {
      name: "修改主表",
      tabText: "修改分页",
      rows: [{ qty: 2, note: "篡改" }],
    });
    expect(result.errors).toEqual([]);
    expect(result.values).toMatchObject({
      name: "修改主表",
      tabText: "修改分页",
      rows: [{ qty: 2, note: "保护" }],
    });
    const removed = prepareMemberUpdate(store.data, entry, "zhang", "*", {
      rows: [],
    });
    expect(removed.errors).toEqual([]);
    expect(removed.values.rows).toEqual([]);
    expect(entry.values.rows).toEqual([{ qty: 1, note: "保护" }]);
  });
  it("cannot update descendants of a rule-hidden container, but can reveal and edit them in one command", async () => {
    const { store, form, config, self } = await setup();
    const tabs = createField("tabs", {
      id: "tabs",
      children: [createField("text", { id: "detail" })],
    });
    form.schema.fields.push(tabs);
    delete form.schema.settings.hiddenValueRules;
    form.schema.settings.rules = [
      {
        id: "show",
        sourceId: "name",
        operator: "equals",
        value: "显示",
        targetIds: [tabs.id],
      },
    ];
    await store.publishForm(form.id);
    self.fields = { ...newAccessGroup(form.schema, "manage").fields };
    await store.saveFormAccess(form.id, config);
    const entry = (await store.submitEntry(form.id, {
      name: "隐藏",
      detail: "原内容",
    }))!;
    const hidden = prepareMemberUpdate(store.data, entry, "zhang", "*", {
      detail: "隐藏时覆盖",
    });
    expect(hidden.errors).toEqual([]);
    expect(hidden.values.detail).toBe("原内容");
    const shown = prepareMemberUpdate(store.data, entry, "zhang", "*", {
      name: "显示",
      detail: "显示后修改",
    });
    expect(shown.errors).toEqual([]);
    expect(shown.values.detail).toBe("显示后修改");
  });
  it("rejects visibility cleanup that would erase protected stored fields", async () => {
    const { store, form, self, config } = await setup();
    form.schema.settings.hiddenValues = "clear";
    form.schema.fields.find((f) => f.id === "private")!.visible = false;
    await store.publishForm(form.id);
    await store.saveFormAccess(form.id, config);
    const entry = (await store.submitEntry(form.id, {
      name: "保留历史值",
      private: "已存储",
    }))!;
    expect(entry.values).not.toHaveProperty("private");
    // A legacy/imported record can still contain a protected value from before submission cleanup.
    entry.values.private = "已存储";
    expect(
      prepareMemberUpdate(store.data, entry, "zhang", "*", {
        name: "新名字",
      }).errors.join(),
    ).toContain("无编辑权限");
  });
  it("warns about access filters and blocks a release removing their fields", async () => {
    const { store, form, self, config } = await setup();
    self.scope = "custom";
    self.filters = [
      {
        id: "filter",
        sourceFieldId: "name",
        source: "constant",
        operator: "equals",
        value: "本人",
      },
    ];
    expect(await store.saveFormAccess(form.id, config)).toBe(true);
    expect(accessFieldImpacts(config, ["name"])[0]).toContain(self.name);
    const version = form.published!.version;
    form.schema.fields = form.schema.fields.filter((f) => f.id !== "name");
    expect(await store.publishForm(form.id)).toBe(false);
    expect(form.published!.version).toBe(version);
    self.archived = true;
    await store.saveFormAccess(form.id, config);
    expect(await store.publishForm(form.id)).toBe(true);
  });
  it("recomputes declared relationship mappings during creation instead of trusting input", async () => {
    const { store } = await setup(),
      demo = createRelationDemo("oa");
    store.data.forms.push(...demo.forms);
    store.data.entries.push(...demo.entries);
    const customer = demo.forms[0]!,
      order = demo.forms[1]!,
      field = (label: string) =>
        order.schema.fields.find((f) => f.label === label)!;
    const read = newAccessGroup(customer.schema);
    read.identities = ["zhang"];
    await store.saveFormAccess(customer.id, {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [read],
    });
    field("联系人").editable = false;
    const result = prepareMemberCreate(
      order.schema,
      {
        [field("业务区域").id]: "east",
        [field("签约客户").id]: demo.entries[0]!.id,
        [field("联系人").id]: "伪造联系人",
      },
      memberContext(store.data, "zhang"),
    );
    expect(result[field("联系人").id]).toBe("林小禾");
    read.fields[customer.schema.fields.find((f) => f.label === "联系人")!.id] =
      "hidden";
    await store.saveFormAccess(customer.id, {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [read],
    });
    const masked = prepareMemberCreate(
      order.schema,
      {
        [field("业务区域").id]: "east",
        [field("签约客户").id]: demo.entries[0]!.id,
      },
      memberContext(store.data, "zhang"),
    );
    expect(masked[field("联系人").id]).not.toBe("林小禾");
  });
  it("does not require changing an unchanged readonly member who has left", async () => {
    const { store, form, config, self, mine } = await setup();
    self.fields.owner = "read";
    await store.saveFormAccess(form.id, config);
    mine.values.owner = "wang";
    store.data.organization.employees.find((e) => e.id === "wang")!.status =
      "inactive";
    const result = prepareMemberUpdate(store.data, mine, "zhang", "*", {
      name: "仅改名称",
    });
    expect(result.errors).toEqual([]);
    expect(result.values.owner).toBe("wang");
  });
  it("accepts a field revealed by an authorized edit in the same submission", async () => {
    const { store, form, self, config } = await setup();
    form.schema.settings.rules = [
      {
        id: "show",
        sourceId: "amount",
        operator: "greater",
        value: "10",
        targetIds: ["private"],
      },
    ];
    await store.publishForm(form.id);
    self.fields.private = "edit";
    await store.saveFormAccess(form.id, config);
    const entry = (await store.submitEntry(form.id, {
      name: "条件编辑",
      amount: 1,
      private: "",
    }))!;
    const result = prepareMemberUpdate(store.data, entry, "zhang", "*", {
      amount: 12,
      private: "已补充",
    });
    expect(result.errors).toEqual([]);
    expect(result.values.private).toBe("已补充");
  });
  it("rolls back access config, member data edits and deletes on persistence failure", async () => {
    const { store, form, config, mine } = await setup();
    const before = copy(mine),
      access = copy(store.data.formAccess);
    const spy = vi
      .spyOn(LocalWorkspaceRepository.prototype, "save")
      .mockImplementation(() => {
        throw Error("disk full");
      });
    config.membersEnabled = false;
    expect(await store.saveFormAccess(form.id, config)).toBe(false);
    expect(store.data.formAccess).toEqual(access);
    expect(
      await store.memberUpdate(
        mine.id,
        "zhang",
        "*",
        { name: "失败" },
        copy(mine.values),
      ),
    ).toBe(false);
    expect(await store.memberDelete(mine.id, "zhang", "*")).toBe(false);
    expect(mine).toEqual(before);
    spy.mockRestore();
  });
});
