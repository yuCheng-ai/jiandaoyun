import { seedWorkspace } from "./fixtures/workspace";
import { describe, expect, it, vi } from "vitest";

import {
  copy,
  createField,
  emptySchema,
  type FormField,
} from "../src/domain/form";
import { newForm } from "../src/domain/workspace";
import { parseExtensions } from "../src/domain/extensions";
import { memberContext } from "../src/domain/access";

import { localQuickFillExtractor } from "../src/services/quickFillExtractor";
import {
  newQuickFill,
  normalizeQuickFill,
  parseQuickFill,
  prepareQuickFill,
  quickFillDesignSchema,
  quickFillFields,
  quickFillIssues,
  quickFillValue,
  type QuickFillConfig,
} from "../src/domain/quickFill";
function fixture(extra: FormField[] = []) {
  const data = seedWorkspace(),
    schema = emptySchema();
  schema.fields = [
    createField("text", { id: "name", label: "服务名称", required: true }),
    createField("number", { id: "amount", label: "金额", min: 0 }),
    ...extra,
  ];
  const config: QuickFillConfig = {
    ...newQuickFill(),
    enabled: true,
    fields: schema.fields.map((f) => ({
      fieldId: f.id,
      aliases: [],
      instruction: "",
    })),
  };
  const extract = (text: string) =>
    localQuickFillExtractor.extract(
      config,
      schema,
      { text, attachments: [] },
      new AbortController().signal,
    );
  return { data, schema, config, extract };
}
describe("quick-fill extraction and value review", () => {
  it("extracts aliases, typed JSON and unknown lines without executing or sending input", async () => {
    const { config, schema, data, extract } = fixture();
    config.fields[0]!.aliases = ["项目"];
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const found = await extract(
      "项目：服务 A\n金额：128.50\n没有标签\n未知：保留原文",
    );
    expect(normalizeQuickFill(found, config, schema, {}, data)).toEqual({
      values: { name: "服务 A", amount: 128.5 },
      errors: {},
    });
    expect(found.unmatched).toEqual(["没有标签", "未知：保留原文"]);
    expect(
      (await extract('{"name":"服务 B","amount":0}')).suggestions,
    ).toHaveLength(2);
    expect(network).not.toHaveBeenCalled();
  });
  it("does not silently choose duplicated field labels or duplicated source values", async () => {
    const { extract } = fixture([
      createField("text", { id: "other", label: "金额" }),
    ]);
    expect((await extract("金额：8")).unmatched[0]).toContain("多个字段");
    const duplicate = await extract("服务名称：A\n服务名称：B");
    expect(duplicate.suggestions[0]!.error).toContain("出现多次");
  });
  it("rejects invalid input, disabled sources and cancellation", async () => {
    const { extract, config, schema } = fixture();
    await expect(extract("{ broken")).rejects.toThrow("JSON");
    await expect(extract("x".repeat(20001))).rejects.toThrow("20,000");
    config.allowText = false;
    await expect(extract("服务名称：A")).rejects.toThrow("未启用");
    const signal = new AbortController();
    signal.abort();
    await expect(
      localQuickFillExtractor.extract(
        config,
        schema,
        { text: "", attachments: [] },
        signal.signal,
      ),
    ).rejects.toThrow("已取消");
  });
  it("resolves organization dependencies regardless of input order and rejects ambiguous or unavailable people", async () => {
    const employee = createField("member", { id: "person", label: "负责人" }),
      department = createField("department", { id: "dept", label: "部门" });
    employee.organization.scope.mode = "fieldDepartment";
    employee.organization.scope.fieldId = "dept";
    const { schema, config, data, extract } = fixture([employee, department]);
    let result = normalizeQuickFill(
      await extract("负责人：王五\n部门：研发部"),
      config,
      schema,
      { dept: "product" },
      data,
    );
    expect(result).toEqual({
      values: { person: "wang", dept: "engineering" },
      errors: {},
    });
    result = normalizeQuickFill(
      await extract("负责人：张三\n部门：研发部"),
      config,
      schema,
      { dept: "product" },
      data,
    );
    expect(result.values.person).toBeUndefined();
    expect(result.errors.person).toContain("范围");
    data.organization.employees.push({
      ...copy(data.organization.employees.find((e) => e.id === "wang")!),
      id: "duplicate",
    });
    expect(() =>
      quickFillValue(employee, "王五", { dept: "engineering" }, data),
    ).toThrow("同名");
    expect(
      quickFillValue(employee, "wang", { dept: "engineering" }, data),
    ).toBe("wang");
    data.organization.employees.find((e) => e.id === "wang")!.status =
      "inactive";
    expect(() =>
      quickFillValue(employee, "wang", { dept: "engineering" }, data),
    ).toThrow("范围");
  });
  it("uses option IDs, preserves zero and rejects invalid numbers and calendar dates", () => {
    const { data } = fixture(),
      f = createField("multiselect", {
        options: [
          { id: "a", label: "选项 A" },
          { id: "b", label: "选项 B" },
        ],
      });
    expect(quickFillValue(f, "选项 A，选项 B，选项 A", {}, data)).toEqual([
      "a",
      "b",
    ]);
    expect(quickFillValue(createField("number"), 0, {}, data)).toBe(0);
    for (const value of ["12元", "Infinity", "", "1e6"])
      expect(() =>
        quickFillValue(createField("number"), value, {}, data),
      ).toThrow();
    const date = createField("datetime", { format: "date" });
    expect(quickFillValue(date, "2028-02-29", {}, data)).toBe("2028-02-29");
    expect(() => quickFillValue(date, "2026-02-29", {}, data)).toThrow(
      "有效日期",
    );
  });
  it("validates image limits and keeps only safe local previews without claiming OCR", async () => {
    const picture = createField("image", {
        id: "image",
        label: "图片",
        multiple: true,
        accept: "image/*",
      }),
      { config, schema, data } = fixture([picture]);
    config.allowImages = true;
    const image = {
      name: "example.png",
      type: "image/png",
      size: 50,
      preview: "https://example.com/image.png",
    };
    expect(
      (quickFillValue(picture, [image], {}, data) as any[])[0].preview,
    ).toBe("");
    expect(() =>
      quickFillValue(picture, [{ ...image, size: 6 * 1024 * 1024 }], {}, data),
    ).toThrow("5 MB");
    const output = await localQuickFillExtractor.extract(
      config,
      schema,
      { text: "", attachments: [image] },
      new AbortController().signal,
    );
    expect(output.suggestions[0]!.evidence).toContain("未识别");
    picture.multiple = false;
    expect(() => quickFillValue(picture, [image, image], {}, data)).toThrow(
      "数量",
    );
  });
});
describe("quick-fill apply boundary", () => {
  it("only plans unsaved changes, keeps unchecked values and identifies overwrites and calculations", () => {
    const total = createField("calculated", {
        id: "total",
        label: "合计",
        expression: "{{amount}}*2",
      }),
      { config, schema, data } = fixture([total]);
    config.fields = config.fields.filter((f) => f.fieldId !== "total");
    const baseline = { name: "原服务", amount: 2, total: 4 },
      before = JSON.stringify(data);
    const result = prepareQuickFill(
      config,
      schema,
      baseline,
      { name: "新服务", amount: 5 },
      ["amount"],
      data,
      "test",
    );
    expect(result.values).toEqual({ name: "原服务", amount: 5, total: 10 });
    expect(result.changes.find((c) => c.id === "amount")?.overwrite).toBe(true);
    expect(result.changes.find((c) => c.id === "total")?.indirect).toBe(true);
    expect(baseline.amount).toBe(2);
    expect(JSON.stringify(data)).toBe(before);
  });
  it("permits partial filling but validates selected required, phone, bounds and uniqueness", () => {
    const phone = createField("phone", { id: "phone", label: "手机" }),
      { config, schema, data } = fixture([phone]);
    expect(
      prepareQuickFill(
        config,
        schema,
        {},
        { amount: 0 },
        ["amount"],
        data,
        "test",
      ).values.amount,
    ).toBe(0);
    expect(() =>
      prepareQuickFill(
        config,
        schema,
        {},
        { name: "" },
        ["name"],
        data,
        "test",
      ),
    ).toThrow("服务名称");
    expect(() =>
      prepareQuickFill(
        config,
        schema,
        {},
        { amount: -1 },
        ["amount"],
        data,
        "test",
      ),
    ).toThrow("范围");
    expect(() =>
      prepareQuickFill(
        config,
        schema,
        {},
        { phone: "123" },
        ["phone"],
        data,
        "test",
      ),
    ).toThrow("手机号");
    schema.fields[0]!.unique = true;
    data.entries.push({
      id: "existing",
      formId: "test",
      values: { name: "已有" },
      status: "submitted",
      definitionVersion: 1,
      createdAt: "",
      history: [],
    });
    expect(() =>
      prepareQuickFill(
        config,
        schema,
        {},
        { name: "已有" },
        ["name"],
        data,
        "test",
      ),
    ).toThrow("重复");
  });
  it("rejects hidden/read-only/unconfigured targets and respects conditional parent tabs", () => {
    const hidden = createField("text", { id: "hidden", visible: false }),
      readonly = createField("text", { id: "read", editable: false });
    const tab = createField("tabs", {
      id: "tab",
      children: [createField("text", { id: "child" })],
    });
    const { config, schema, data } = fixture([hidden, readonly, tab]);
    config.fields.push({ fieldId: "child", aliases: [], instruction: "" });
    schema.settings.rules = [
      {
        id: "rule",
        sourceId: "name",
        operator: "equals",
        value: "显示",
        targetIds: ["tab"],
      },
    ];
    for (const id of ["hidden", "read", "unconfigured", "child"])
      expect(() =>
        prepareQuickFill(
          config,
          schema,
          { name: "隐藏" },
          { [id]: "值" },
          [id],
          data,
          "test",
        ),
      ).toThrow();
    expect(
      prepareQuickFill(
        config,
        schema,
        {},
        { name: "显示", child: "值" },
        ["name", "child"],
        data,
        "test",
      ).values.child,
    ).toBe("值");
  });
  it("shows relation mappings but never writes to read-only targets", () => {
    const relation = createField("relation", {
      id: "relation",
      label: "客户",
      referenceFormId: "source",
      referenceFieldId: "title",
    });
    relation.reference.mappings = [
      { sourceFieldId: "phone", targetFieldId: "contact" },
      { sourceFieldId: "phone", targetFieldId: "locked" },
    ];
    const { config, schema, data } = fixture([
      relation,
      createField("text", { id: "contact" }),
      createField("text", { id: "locked", editable: false }),
    ]);
    const remote = newForm("oa", "客户");
    remote.id = "source";
    remote.schema.fields = [
      createField("text", { id: "title" }),
      createField("text", { id: "phone" }),
    ];
    data.forms.push(remote);
    data.entries.push({
      id: "client",
      formId: "source",
      values: { title: "青禾", phone: "12345" },
      status: "submitted",
      definitionVersion: 1,
      createdAt: "",
      history: [],
    });
    const result = prepareQuickFill(
      config,
      schema,
      { locked: "保留" },
      { relation: "青禾" },
      ["relation"],
      data,
      "test",
    );
    expect(result.values).toEqual({
      locked: "保留",
      relation: "client",
      contact: "12345",
    });
    expect(result.changes.find((c) => c.id === "contact")?.indirect).toBe(true);
    expect(() =>
      prepareQuickFill(
        config,
        schema,
        {},
        { relation: "青禾" },
        ["relation"],
        memberContext(data, "li"),
        "test",
      ),
    ).toThrow("范围");
  });
  it("clears out-of-scope dependent selections and reviews that indirect change", () => {
    const person = createField("member", { id: "person", label: "负责人" });
    person.organization.scope.mode = "fieldDepartment";
    person.organization.scope.fieldId = "dept";
    const { config, schema, data } = fixture([
      createField("department", { id: "dept", label: "部门" }),
      person,
    ]);
    const result = prepareQuickFill(
      config,
      schema,
      { dept: "product", person: "zhang" },
      { dept: "engineering" },
      ["dept"],
      data,
      "test",
    );
    expect(result.values.person).toBe("");
    expect(result.changes.find((c) => c.id === "person")).toMatchObject({
      overwrite: true,
      indirect: true,
    });
  });
});
describe("quick-fill configuration persistence", () => {
  it("migrates safely and validates supported fields and image targets", () => {
    const { schema, config } = fixture();
    expect(parseExtensions({ webhooks: [] }).quickFill).toBeUndefined();
    expect(parseQuickFill({})).toEqual(newQuickFill());
    expect(quickFillIssues(config, schema)).toEqual([]);
    config.allowImages = true;
    expect(quickFillIssues(config, schema).join()).toContain("接收字段");
    config.fields.push(copy(config.fields[0]!));
    expect(quickFillIssues(config, schema).join()).toContain("重复");
  });
  it("excludes workflow start permissions and disabled ancestor containers", () => {
    const { schema } = fixture([
      createField("tabs", {
        editable: false,
        children: [createField("text", { id: "child" })],
      }),
    ]);
    const form = newForm("oa", "流程", "workflow");
    form.schema = schema;
    form.workflow.nodes.find((n) => n.data.kind === "start")!.data.permissions =
      { amount: "read" };
    expect(
      quickFillFields(quickFillDesignSchema(form)).map((f) => f.id),
    ).toEqual(["name"]);
  });
});
