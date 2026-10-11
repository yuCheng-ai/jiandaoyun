// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { identifySubformRows } from "@platform/contracts";
import FormFields from "../src/features/forms/components/FormFields.vue";
import {
  copy,
  createField,
  emptySchema,
  prepareSubmission,
  resolveFormValues,
  validateValues,
} from "../src/domain/form";
import {
  prepareMemberCreate,
  prepareMemberUpdate,
  defaultAccess,
  newAccessGroup,
  visibleValues,
  memberSchema,
} from "../src/domain/access";
import { restoreRuntimeDraft } from "../src/domain/editorDraftAdapters";
import {
  newForm,
  seedWorkspace,
  type FormEntry,
} from "../src/domain/workspace";

function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "title" }),
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("number", { id: "qty" }),
        createField("text", { id: "note", defaultValue: "默认保护" }),
        createField("text", { id: "secret", defaultValue: "默认机密" }),
      ],
    }),
  ];
  const data = seedWorkspace(),
    form = newForm("oa", "明细身份验收");
  form.schema = copy(schema);
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [copy(form.published)];
  const group = newAccessGroup(schema, "manage");
  group.identities = ["zhang"];
  group.fields.note = "read";
  group.fields.secret = "hidden";
  data.formAccess = {
    ...data.formAccess,
    [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  data.forms.push(form);
  const values = {
    title: "原主表",
    lines: [
      { _rowId: "r1", qty: 1, note: "第一行保护", secret: "第一行机密" },
      { _rowId: "r2", qty: 2, note: "第二行保护", secret: "第二行机密" },
    ],
  };
  const entry: FormEntry = {
    id: "entry-row-test",
    formId: form.id,
    definitionVersion: 1,
    status: "submitted",
    createdBy: "zhang",
    createdAt: "2026-10-10",
    values: copy(values),
    history: [],
  };
  data.entries.push(entry);
  return { schema, data, form, group, entry, values };
}
it("keeps row identity on submission while dropping unknown business keys", () => {
  const { schema, values } = fixture();
  const next = prepareSubmission(
    schema,
    { ...values, lines: [{ ...values.lines[1], qty: 0, unknown: "丢弃" }] },
    values,
  );
  expect(next.lines).toEqual([
    { _rowId: "r2", qty: 0, note: "第二行保护", secret: "第二行机密" },
  ]);
  expect(values.lines).toHaveLength(2);
});
it("merges moved rows by identity and allows row deletion/addition with readonly and hidden columns", () => {
  const { data, entry } = fixture();
  const before = copy(entry.values);
  const result = prepareMemberUpdate(data, entry, "zhang", "*", {
    title: "改主表",
    lines: [
      { _rowId: "r2", qty: 20, note: "篡改", secret: "泄露" },
      { _rowId: "new-row", qty: 0, note: "篡改新行", secret: "篡改新行" },
    ],
  });
  expect(result.errors).toEqual([]);
  expect(result.values).toMatchObject({
    title: "改主表",
    lines: [
      { _rowId: "r2", qty: 20, note: "第二行保护", secret: "第二行机密" },
      { _rowId: "new-row", qty: 0, note: "默认保护", secret: "默认机密" },
    ],
  });
  expect(entry.values).toEqual(before);
});
it("reorders existing rows without moving protected values between them", () => {
  const { data, entry, values } = fixture();
  const result = prepareMemberUpdate(data, entry, "zhang", "*", {
    lines: [
      { ...values.lines[1], qty: 22 },
      { ...values.lines[0], qty: 11 },
    ],
  });
  expect(result.errors).toEqual([]);
  expect(result.values.lines).toEqual([
    { ...values.lines[1], qty: 22 },
    { ...values.lines[0], qty: 11 },
  ]);
});
it("rejects duplicate row identity before a member edit can modify any value", () => {
  const { schema, data, entry, values } = fixture();
  const input = {
    title: "不能写",
    lines: [values.lines[0], { ...values.lines[0], qty: 2 }],
  };
  expect(
    validateValues(schema, input).some((e) => e.message.includes("明细行")),
  ).toBe(true);
  const result = prepareMemberUpdate(data, entry, "zhang", "*", input);
  expect(result.errors.join()).toContain("明细行");
  expect(result.values).toEqual(entry.values);
  expect(entry.values).toEqual(values);
});
it("retains hidden old values from the matching row after deletion shifts the visible row number", () => {
  const { schema, values } = fixture();
  schema.fields[1].children[2].visible = false;
  schema.settings.hiddenValueRules = { secret: "retain" };
  const next = resolveFormValues(
    schema,
    { title: "新主表", lines: [{ _rowId: "r2", qty: 0, note: "新文" }] },
    values,
  );
  expect(next.lines).toEqual([
    { _rowId: "r2", qty: 0, note: "新文", secret: "第二行机密" },
  ]);
});
it("restores row-scoped editable drafts by identity and retains the correct current protected cells", () => {
  const { schema, group, values } = fixture();
  const permitted = memberSchema(schema, [group], true);
  const next = restoreRuntimeDraft(
    {
      title: "恢复",
      lines: [
        { _rowId: "r2", qty: 0, note: "旧保护", secret: "旧机密" },
        { _rowId: "new-row", qty: 3, note: "篡改", secret: "篡改" },
      ],
    },
    permitted.fields,
    values,
  );
  expect(next.lines).toEqual([
    { _rowId: "r2", qty: 0, note: "第二行保护", secret: "第二行机密" },
    { _rowId: "new-row", qty: 3, note: "默认保护", secret: "默认机密" },
  ]);
  expect(values.lines).toHaveLength(2);
});
it("preserves identity in masked values without revealing hidden cells", () => {
  const { schema, group, values } = fixture();
  const next = visibleValues(memberSchema(schema, [group]), values);
  expect(next.lines).toEqual([
    { _rowId: "r1", qty: 1, note: "第一行保护" },
    { _rowId: "r2", qty: 2, note: "第二行保护" },
  ]);
});
it("matches legacy rows without rewriting the stored baseline before an explicit save", () => {
  const { schema, data, entry } = fixture();
  for (const row of entry.values.lines as any[]) delete row._rowId;
  const before = copy(entry.values),
    identified = identifySubformRows(schema.fields, entry.values);
  const result = prepareMemberUpdate(data, entry, "zhang", "*", {
    lines: [{ ...(identified.lines as any[])[1], qty: 0, note: "篡改" }],
  });
  expect(result.errors).toEqual([]);
  expect(result.values.lines).toEqual([
    {
      _rowId: "legacy:lines:1",
      qty: 0,
      note: "第二行保护",
      secret: "第二行机密",
    },
  ]);
  expect(entry.values).toEqual(before);
});
it("keeps a new member row's identity while filling protected initial values", () => {
  const { schema, data, group } = fixture();
  const permitted = memberSchema(schema, [group], true);
  const next = prepareMemberCreate(
    permitted,
    {
      lines: [{ _rowId: "created-row", qty: 0, note: "篡改", secret: "篡改" }],
    },
    data,
  );
  expect(next.lines).toEqual([
    { _rowId: "created-row", qty: 0, note: "默认保护", secret: "默认机密" },
  ]);
});
it("keeps actual row controls with their identity on reordering and gives new rows independent IDs", async () => {
  const { schema, values } = fixture();
  const current = reactive(copy(values));
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(FormFields, {
        fields: schema.fields,
        schema,
        values: current,
        onChange: (id: string, value: unknown) => {
          (current as any)[id] = value;
        },
      }),
  });
  app.use(createPinia()).mount(host);
  try {
    const second = host.querySelectorAll("tbody tr")[1];
    current.lines = [current.lines[1], current.lines[0]];
    await nextTick();
    expect(host.querySelectorAll("tbody tr")[0]).toBe(second);
    host
      .querySelector<HTMLButtonElement>('[aria-label="删除明细第1行"]')!
      .click();
    await nextTick();
    expect(current.lines.map((row) => row._rowId)).toEqual(["r1"]);
    host.querySelector<HTMLButtonElement>(".subform-add")!.click();
    await nextTick();
    expect(current.lines).toHaveLength(2);
    expect(typeof current.lines[1]._rowId).toBe("string");
    expect(["r1", "r2"]).not.toContain(current.lines[1]._rowId);
  } finally {
    app.unmount();
    host.remove();
  }
});
it("does not guess protected row ownership when an old draft changes the row count without IDs", () => {
  const { schema, group, values } = fixture();
  const before = copy(values);
  const legacy = { lines: [{ qty: 0, note: "旧第二行" }] };
  expect(() =>
    restoreRuntimeDraft(
      legacy,
      memberSchema(schema, [group], true).fields,
      values,
    ),
  ).toThrow("无法对应原记录");
  expect(values).toEqual(before);
  expect(legacy.lines).toHaveLength(1);
});
it("does not render mutating row controls when the shared subform is explicitly readonly", async () => {
  const { schema, values } = fixture();
  const changes = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(FormFields, {
        fields: schema.fields,
        schema,
        values,
        readonly: true,
        onChange: changes,
      }),
  });
  app.use(createPinia()).mount(host);
  try {
    expect(host.querySelectorAll('button[aria-label^="删除明细"]').length).toBe(
      0,
    );
    expect(host.querySelector(".subform-add")).toBeNull();
    expect(changes).not.toHaveBeenCalled();
    expect(values.lines).toHaveLength(2);
  } finally {
    app.unmount();
    host.remove();
  }
});
