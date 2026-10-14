// @vitest-environment jsdom
// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";

import FormFields from "../src/features/forms/components/FormFields.vue";
import {
  copy,
  createField,
  emptySchema,
  prepareSubmission,
  resolveFormValues,
} from "../src/domain/form";
import {
  defaultAccess,
  newAccessGroup,
  visibleValues,
  memberSchema,
} from "../src/domain/access";
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
it("preserves identity in masked values without revealing hidden cells", () => {
  const { schema, group, values } = fixture();
  const next = visibleValues(memberSchema(schema, [group]), values);
  expect(next.lines).toEqual([
    { _rowId: "r1", qty: 1, note: "第一行保护" },
    { _rowId: "r2", qty: 2, note: "第二行保护" },
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
