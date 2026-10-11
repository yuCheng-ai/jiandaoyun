import { describe, expect, it } from "vitest";
import { serverFieldTypes } from "@platform/contracts";
import { inspectApplicationMigration } from "../src/domain/applicationMigration";
import { createField, fieldRegistry } from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormEntry,
  type FormRecord,
  type PublishedDefinition,
} from "../src/domain/workspace";
import { newAutomation, newAutomationStep } from "../src/domain/automation";
import { newButton } from "../src/domain/buttons";
import { newReminder } from "../src/domain/reminders";
import { defaultAccess, newAccessGroup } from "../src/domain/access";

const fixture = () => {
  const data = seedWorkspace();
  data.forms = [];
  data.entries = [];
  data.formAccess = {};
  data.recordViews = {};
  data.organization.roles = [];
  return data;
};
function publish(form: FormRecord, version = 1) {
  const definition: PublishedDefinition = {
    version,
    title: form.title,
    schema: structuredClone(form.schema),
    workflow: structuredClone(form.workflow),
    extensions: structuredClone(form.extensions),
    publishedAt: "2026-10-09T00:00:00.000Z",
  };
  form.versions.push(definition);
  form.published = structuredClone(definition);
  return definition;
}
const entry = (
  form: FormRecord,
  patch: Partial<FormEntry> = {},
): FormEntry => ({
  id: "entry_one",
  formId: form.id,
  definitionVersion: 1,
  createdAt: "2026-10-09T00:00:00.000Z",
  values: {},
  status: "submitted",
  history: [],
  createdBy: "zhang",
  ...patch,
});

describe("application migration inventory", () => {
  it("accounts for every registry type across data and display controls without claiming an executable import", () => {
    const data = fixture(),
      form = newForm("oa", "完整字段");
    form.schema.fields = fieldRegistry.map((item, index) =>
      createField(item.type, { id: `f_${index}` }),
    );
    data.forms.push(form);
    const report = inspectApplicationMigration(data, "oa");
    expect(new Set(report.fieldTypes.map((type) => type.type))).toEqual(
      new Set(fieldRegistry.map((type) => type.type)),
    );
    expect(
      report.fieldTypes
        .filter((type) => type.runtimeSupported)
        .map((type) => type.type)
        .sort(),
    ).toEqual([...serverFieldTypes].sort());
    expect(report.forms[0].versions[0].layoutControls).toBe(3);
    expect(
      report.forms[0].versions[0].dataFields +
        report.forms[0].versions[0].layoutControls,
    ).toBe(fieldRegistry.length);
    expect(
      report.issues.some(
        (issue) => issue.fieldId && issue.message.includes("附件"),
      ),
    ).toBe(true);
    expect(report).not.toHaveProperty("ready");
    expect(report).not.toHaveProperty("targetId");
  });
  it("includes archived forms, every immutable version, deleted records and their exact version schemas", () => {
    const data = fixture(),
      form = newForm("oa", "历史内容");
    form.archived = true;
    form.schema.fields = [
      createField("file", { id: "old_file" }),
      createField("subform", {
        id: "lines",
        children: [createField("text", { id: "old_column" })],
      }),
    ];
    publish(form);
    form.schema.fields = [createField("text", { id: "new_field" })];
    publish(form, 2);
    data.forms.push(form);
    data.entries.push(
      entry(form, {
        values: { old_file: [], lines: [{ old_column: "保留原内容" }] },
        deletedAt: "2026-10-09T01:00:00Z",
        history: [{ label: "审核", action: "通过", time: "2026-10-09" }],
      }),
    );
    const report = inspectApplicationMigration(data, "oa");
    expect(report.forms[0]).toMatchObject({
      archived: true,
      publishedVersions: 2,
      records: 1,
      deletedRecords: 1,
      rowCount: 1,
      historyEvents: 1,
    });
    expect(report.forms[0].versions.map((version) => version.label)).toEqual([
      "草稿",
      "V1",
      "V2",
    ]);
    expect(
      report.issues.some(
        (issue) => issue.version === "V1" && issue.fieldId === "old_file",
      ),
    ).toBe(true);
    expect(
      report.issues.some((issue) => issue.message.includes("未定义")),
    ).toBe(false);
  });
  it("retains same-name identities and locates internal, cross-application and missing dependencies with pinned versions", () => {
    const data = fixture(),
      form = newForm("oa", "来源"),
      sameNameA = newForm("oa", "客户"),
      sameNameB = newForm("product", "客户");
    for (const target of [sameNameA, sameNameB]) {
      target.schema.fields = [createField("text", { id: "name" })];
      publish(target);
    }
    form.schema.fields = [
      createField("select", {
        id: "choice",
        choiceSource: {
          ...createField("select").choiceSource,
          mode: "form",
          formId: sameNameA.id,
          labelFieldId: "name",
        },
      }),
      createField("relation", {
        id: "relation",
        referenceFormId: sameNameB.id,
        referenceFieldId: "name",
      }),
    ];
    const automation = newAutomation();
    automation.enabled = false;
    automation.steps = [
      { ...newAutomationStep(), targetFormId: sameNameB.id, targetVersion: 3 },
    ];
    const button = newButton();
    button.action = "openForm";
    button.targetFormId = "missing";
    form.extensions = {
      webhooks: [],
      automations: [automation],
      buttons: [button],
    };
    data.forms.push(form, sameNameA, sameNameB);
    const report = inspectApplicationMigration(data, "oa");
    expect(
      report.dependencies.map((item) => [item.targetId, item.scope]),
    ).toEqual([
      [sameNameA.id, "application"],
      [sameNameB.id, "external"],
      [sameNameB.id, "external"],
      ["missing", "missing"],
    ]);
    expect(report.dependencies[2].targetVersion).toBe(3);
    expect(
      report.issues.some((issue) => issue.message.includes("V3 不存在")),
    ).toBe(true);
    expect(report.forms).toHaveLength(2);
  });
  it("checks both conflicting published copies and never chooses a new schema to reinterpret records", () => {
    const data = fixture(),
      form = newForm("oa", "冲突历史");
    form.schema.fields = [createField("text", { id: "name" })];
    publish(form);
    form.published!.schema.fields.push(
      createField("file", { id: "conflict_file" }),
    );
    data.forms.push(form);
    data.entries.push(
      entry(form, { definitionVersion: 99, values: { name: "历史秘密值" } }),
    );
    const report = inspectApplicationMigration(data, "oa");
    expect(report.forms[0].publishedVersions).toBe(1);
    expect(
      report.issues.some(
        (issue) =>
          issue.version.includes("冲突内容") &&
          issue.fieldId === "conflict_file",
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) =>
          issue.version === "V99" && issue.message.includes("不能改用当前草稿"),
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("历史秘密值");
  });
  it("collects members and departments from historical values, subforms, permission groups and disabled reminders", () => {
    const data = fixture(),
      form = newForm("oa", "身份映射");
    form.schema.fields = [
      createField("members", { id: "owners" }),
      createField("subform", {
        id: "rows",
        children: [createField("department", { id: "department" })],
      }),
    ];
    const reminder = newReminder();
    reminder.recipients.ids = ["missing_member"];
    form.extensions = { webhooks: [], reminders: [reminder] };
    publish(form);
    data.forms.push(form);
    const access = defaultAccess(),
      group = newAccessGroup(form.schema);
    group.identities = ["company"];
    access.groups.push(group);
    data.formAccess![form.id] = access;
    data.entries.push(
      entry(form, {
        values: { owners: ["zhang"], rows: [{ department: "product" }] },
      }),
    );
    const report = inspectApplicationMigration(data, "oa");
    expect(report.identities).toEqual(
      expect.arrayContaining([
        { id: "zhang", kind: "member", found: true },
        { id: "company", kind: "department", found: true },
        { id: "product", kind: "department", found: true },
        { id: "missing_member", kind: "member", found: false },
      ]),
    );
    expect(
      report.issues.some(
        (issue) => issue.location === "访问权限" && issue.kind === "mapping",
      ),
    ).toBe(true);
  });
  it("reports corrupt record identity and unknown fields without exposing their values or webhook secrets", () => {
    const data = fixture(),
      form = newForm("oa", "记录检查");
    form.schema.fields = [
      createField("subform", {
        id: "rows",
        children: [createField("text", { id: "known" })],
      }),
    ];
    publish(form);
    data.forms.push(form);
    data.entries.push(
      entry(form, {
        values: {
          unknown: "business-secret",
          rows: [{ other: "child-secret" }],
        },
      }),
      entry(form, { values: {} }),
    );
    data.webhookCredentials = [
      {
        id: "credential",
        mode: "local-demo",
        secret: "signing-secret",
        createdAt: "2026-10-09",
      },
    ];
    const before = JSON.stringify(data),
      report = inspectApplicationMigration(data, "oa");
    expect(
      report.issues
        .filter((issue) => issue.kind === "invalid")
        .map((issue) => issue.message)
        .join(" "),
    ).toContain("记录身份重复");
    expect(
      report.issues.some((issue) => issue.message.includes("未定义的列")),
    ).toBe(true);
    for (const secret of ["business-secret", "child-secret", "signing-secret"])
      expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(data)).toBe(before);
  });
  it("does not merge field identities across versions or treat page-only rules as permanent data constraints", () => {
    const data = fixture(),
      form = newForm("oa", "页面规则");
    form.schema.fields = [
      createField("text", {
        id: "name",
        editable: false,
        visible: false,
        required: true,
      }),
      createField("datetime", { id: "date", format: "unsupported" }),
    ];
    form.schema.settings.rules = [
      {
        id: "rule",
        sourceId: "missing",
        operator: "empty",
        value: "",
        targetIds: ["name"],
      },
    ];
    publish(form);
    data.forms.push(form);
    const report = inspectApplicationMigration(data, "oa");
    expect(
      report.issues.some(
        (issue) => issue.location === "页面规则" && issue.kind === "invalid",
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) =>
          issue.fieldId === "date" && issue.message.includes("日期格式"),
      ),
    ).toBe(true);
    expect(report.issues.some((issue) => issue.fieldId === "name")).toBe(false);
  });
  it("fails explicitly for a removed application", () => {
    expect(() => inspectApplicationMigration(fixture(), "missing")).toThrow(
      "应用不存在",
    );
  });

  it("does not treat malformed record and subform values as empty data", () => {
    const data = fixture(),
      form = newForm("oa", "异常明细");
    form.schema.fields = [
      createField("subform", {
        id: "rows",
        children: [createField("text", { id: "name" })],
      }),
    ];
    publish(form);
    data.forms.push(form);
    data.entries.push(
      entry(form, { id: "array_record", values: [] as never }),
      entry(form, { id: "bad_rows", values: { rows: "original-value" } }),
    );
    const report = inspectApplicationMigration(data, "oa");
    expect(
      report.issues.some((issue) => issue.message.includes("不能按空记录迁移")),
    ).toBe(true);
    expect(
      report.issues.some((issue) => issue.message.includes("不能按空明细迁移")),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("original-value");
    expect(data.entries[1].values.rows).toBe("original-value");
  });
});
