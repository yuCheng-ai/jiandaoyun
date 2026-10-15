import { seedWorkspace, newAccessGroup } from "./fixtures/workspace";
import { describe, it, expect } from "vitest";

import { createField, copy } from "../src/domain/form";
import {
  defaultAccess,
  eligibleGroups,
  memberSchema,
  visibleValues,
  memberContext,
} from "../src/domain/access";

import {
  newForm,
  type FormEntry,
} from "../src/domain/workspace";
async function setup() {
  const data = seedWorkspace();
  const form = newForm("oa", "权限测试");
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
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    extensions: copy(form.extensions),
    publishedAt: form.createdAt,
  };
  form.versions = [copy(form.published)];
  data.forms.push(form);
  const mine: FormEntry = {
    id: "mine",
    formId: form.id,
    definitionVersion: 1,
    values: {
      name: "本人",
      amount: 2,
      private: "机密",
      owner: "zhang",
      total: 4,
    },
    createdBy: "zhang",
    createdDepartmentIds: ["product"],
    createdAt: form.createdAt,
    status: "submitted",
    history: [],
  };
  const other: FormEntry = {
    id: "other",
    formId: form.id,
    definitionVersion: 1,
    values: {
      name: "他人",
      amount: 3,
      private: "隐藏",
      owner: "wang",
      total: 6,
    },
    createdBy: "wang",
    createdDepartmentIds: ["engineering"],
    createdAt: form.createdAt,
    status: "submitted",
    history: [],
  };
  data.entries.push(mine, other);
  const self = newAccessGroup(form.schema, "self");
  self.identities = ["zhang"];
  self.fields.private = "hidden";
  const config = { ...defaultAccess(), membersEnabled: true, groups: [self] };
  data.formAccess = { [form.id]: copy(config) };
  return { data, form, mine, other, self, config };
}
describe("member publication and runtime access", () => {
  it("resolves departments and roles dynamically and removes inactive members", async () => {
    const { data, form, config, self } = await setup();
    self.identities = ["product"];
    data.formAccess![form.id] = copy(config);
    expect(eligibleGroups(data, form.id, "li")).toHaveLength(1);
    data.organization.employees.find((e) => e.id === "li")!.status = "inactive";
    expect(eligibleGroups(data, form.id, "li")).toEqual([]);
    self.identities = [data.organization.roles[0]!.id];
    data.formAccess![form.id] = copy(config);
    expect(resolveCount()).toBeGreaterThan(0);
    function resolveCount() {
      return data.organization.employees.filter(
        (e) => eligibleGroups(data, form.id, e.id).length,
      ).length;
    }
  });
  it("masks hidden fields in record values and relation contexts and denies new fields by default", async () => {
    const { data, form, self, mine, other } = await setup();
    const schema = memberSchema(form.schema, [self]);
    form.schema.settings.allowSubmit = false;
    expect(memberSchema(form.schema, [self], true).settings.allowSubmit).toBe(
      true,
    );
    expect(visibleValues(schema, mine.values).private).toBeUndefined();
    const context = memberContext(data, "zhang");
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
});
