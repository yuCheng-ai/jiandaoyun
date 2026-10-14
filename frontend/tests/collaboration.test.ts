import { describe, it, expect } from "vitest";

import { createField, copy } from "../src/domain/form";
import {
  defaultCollaboration,
  parseCollaboration,
  renderDataTitle,
  entryTitle,
  inlineEditField,
  prepareInlineEdit,
} from "../src/domain/collaboration";
import { parseExtensions } from "../src/domain/extensions";
import { defaultRecordView, filterAndSortRecords } from "../src/domain/records";
import {
  seedWorkspace,
  newForm,
  type FormEntry,
} from "../src/domain/workspace";
async function setup() {
  const data = seedWorkspace();
  const form = newForm("oa", "合同");
  form.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: true,
    }),
    createField("number", { id: "amount", label: "金额", min: 0 }),
    createField("member", { id: "owner", label: "负责人" }),
    createField("department", { id: "dept", label: "部门" }),
    createField("calculated", {
      id: "total",
      label: "双倍金额",
      expression: "{{amount}}*2",
    }),
  ];
  const config = {
    ...defaultCollaboration(),
    inlineEdit: true,
    titleMode: "custom" as const,
    titleParts: [
      { id: "p1", kind: "text" as const, value: "合同 · " },
      { id: "p2", kind: "field" as const, value: "name" },
      { id: "p3", kind: "text" as const, value: " / " },
      { id: "p4", kind: "field" as const, value: "owner" },
    ],
  };
  form.extensions!.collaboration = config;
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
  const entry: FormEntry = {
    id: "contract",
    formId: form.id,
    definitionVersion: 1,
    values: { name: "A", amount: 2, owner: "zhang", dept: "product", total: 4 },
    createdAt: form.createdAt,
    status: "submitted",
    history: [],
  };
  data.entries.push(entry);
  return { data, form, entry, config };
}
describe("data titles and inline editing", () => {
  it("round trips settings without introducing configuration into old extensions", async () => {
    const { data, form, config } = await setup();
    expect(parseCollaboration(config)).toEqual(config);
    expect(parseExtensions(undefined)).toEqual({ webhooks: [] });
    expect(parseExtensions(form.extensions).collaboration).toEqual(config);
    expect(() =>
      parseCollaboration({
        ...config,
        titleParts: [config.titleParts[0], config.titleParts[0]],
      }),
    ).toThrow();
  });
  it("renders ordered field labels, preserves numeric zero and falls back for empty titles", async () => {
    const { data, form, config, entry } = await setup();
    expect(entryTitle(entry, data)).toBe("合同 · A / 张三");
    expect(
      renderDataTitle(
        defaultCollaboration(),
        form.schema,
        { amount: 0 },
        data,
        "fallback",
      ),
    ).toBe("0");
    expect(
      renderDataTitle(
        { ...config, titleParts: [] },
        form.schema,
        {},
        data,
        "fallback",
      ),
    ).toBe("fallback");
  });
  it("omits conditionally hidden fields and fields inside hidden tabs", async () => {
    const { data, form, config } = await setup();
    form.schema.settings.rules = [
      {
        id: "r",
        sourceId: "amount",
        operator: "greater",
        value: "5",
        targetIds: ["owner"],
      },
    ];
    expect(
      renderDataTitle(
        config,
        form.schema,
        { name: "A", owner: "zhang", amount: 2 },
        data,
        "fallback",
      ),
    ).toBe("合同 · A /");
    form.schema.fields = [
      createField("tabs", { visible: false, children: form.schema.fields }),
    ];
    expect(
      renderDataTitle(
        defaultCollaboration(),
        form.schema,
        { name: "private" },
        data,
        "fallback",
      ),
    ).toBe("fallback");
  });
  it("finds records using custom fixed title text", async () => {
    const { data, form, entry } = await setup();
    expect(
      filterAndSortRecords([entry], form.schema, data, {
        query: "合同 ·",
        filters: [],
        view: defaultRecordView(form.schema),
      }),
    ).toHaveLength(1);
  });
  it("blocks fields hidden by rules or made read-only through a container", async () => {
    const { data, entry } = await setup();
    const version = data.forms.find((f) => f.id === entry.formId)!.versions[0]!;
    version.schema.settings.rules = [
      {
        id: "r",
        sourceId: "amount",
        operator: "greater",
        value: "100",
        targetIds: ["owner"],
      },
    ];
    expect(inlineEditField(entry, "owner", data)).toBeUndefined();
    version.schema.fields = [
      createField("tabs", { editable: false, children: version.schema.fields }),
    ];
    expect(inlineEditField(entry, "amount", data)).toBeUndefined();
  });
  it("clears a member when a new department makes the member out of scope and shows both changes", async () => {
    const { data, entry } = await setup();
    const schema = data.forms.find((f) => f.id === entry.formId)!.versions[0]!
      .schema;
    schema.fields.find((f) => f.id === "owner")!.organization.scope.mode =
      "fieldDepartment";
    schema.fields.find((f) => f.id === "owner")!.organization.scope.fieldId =
      "dept";
    const result = prepareInlineEdit(entry, "dept", "finance", data);
    expect(result.values.owner).toBe("");
    expect(result.changes.map((c) => c.id)).toContain("owner");
    expect(result.errors).toEqual([]);
  });
});
