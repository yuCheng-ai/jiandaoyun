import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";
const h = harness();
before(() => h.start());
after(() => h.close());
const options = [
  { id: "a", label: "北京" },
  { id: "other", label: "其他", other: true },
];
const choice = (
  id: string,
  type = "select",
  extra: Record<string, unknown> = {},
) =>
  field(id, type, {
    options: type === "select" || type === "radio" ? options : [options[0]],
    defaultValue: type === "select" || type === "radio" ? "other" : [],
    choiceSource: {
      mode: "manual",
      formId: "",
      labelFieldId: "",
      valueFieldId: "",
      filters: [],
      sort: "none",
      deduplicate: true,
    },
    ...extra,
  });
const both = () =>
  schema(
    choice("single"),
    choice("multi", "multiselect", { allowCustomChoices: true }),
  );

test("1000 predefined choices plus temporary selections survive drafts, submission and restart while configured totals still apply", async () => {
  const fixedOptions = Array.from({ length: 1000 }, (_, index) => ({ id: `c${index}`, label: `项目${index}` }));
  const settings = {
    options: fixedOptions,
    allowCustomChoices: true,
    selectionLimit: { enabled: true, min: 1001, max: 1001 },
  };
  await h.request("/definitions", "POST", {
    title: "预设项数边界",
    schema: schema(choice("multi", "checkbox", { ...settings, options: [...fixedOptions, { id: "overflow", label: "多余预设" }] })),
  }, "admin", 400);
  const definition = await h.definition("临时选项总数边界", schema(
    choice("multi", "multiselect", settings),
    field("lines", "subform", { children: [choice("checks", "checkbox", settings)] }),
  ));
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const path = `/pages/${page.id}/records`;
  const selected = [...fixedOptions.map(option => option.id), { text: "临时项目" }];
  const overflow = [...selected, { text: "额外项目" }];
  const values = { multi: selected, lines: [{ checks: overflow }] };
  const rejected = await h.request(path, "POST", { pageVersion: 1, requestId: randomUUID(), values }, "admin", 400);
  assert.match(rejected.message, /1001~1001/);
  const saved = await h.request(path, "POST", { pageVersion: 1, requestId: randomUUID(), state: "draft", values }, "admin", 201);
  await h.restart();
  const reopened = await h.request(`${path}/${saved.record.id}`);
  assert.deepEqual(reopened.record.values.multi, selected);
  assert.deepEqual(reopened.record.values.lines[0].checks, overflow);
  const submitted = await h.request(`${path}/${saved.record.id}/submit`, "POST", {
    pageVersion: 1, requestId: randomUUID(), expectedRevision: reopened.record.revision,
    changes: [{ subformId: "lines", rowId: reopened.record.values.lines[0]._rowId, fieldId: "checks", expectedRevision: 1, value: selected }],
  }, "admin", 201);
  assert.equal(submitted.record.state, "active");
  assert.deepEqual(submitted.record.values.multi, selected);
  assert.deepEqual(submitted.record.values.lines[0].checks, selected);
  for (const value of [fixedOptions.map(option => option.id), overflow]) {
    const result = await h.request(`${path}/${saved.record.id}`, "PATCH", {
      pageVersion: 1, requestId: randomUUID(),
      changes: [{ fieldId: "multi", expectedRevision: submitted.record.cellRevisions.multi, value }],
    }, "admin", 400);
    assert.match(result.message, /1001~1001/);
  }
  assert.deepEqual((await h.request(`${path}/${saved.record.id}`)).record, submitted.record);
  const model = (await h.request(`/data-objects/${definition.id}/draft`)).model;
  assert.deepEqual(model.fields[0].settings.options, fixedOptions);
  assert.deepEqual(model.fields[1].children[0].settings.options, fixedOptions);
});

test("Other text and temporary choices persist in pages, rows and revisions without modifying option definitions or other fills", async () => {
  const definition = await h.definition(
    "选项补充验收",
    schema(
      ...both().fields,
      field("lines", "subform", {
        children: [
          choice("rowSingle", "radio"),
          choice("rowMulti", "checkbox", { allowCustomChoices: true }),
        ],
      }),
    ),
  );
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const published = await h.request(`/pages/${page.id}`),
    model = (await h.request(`/data-objects/${definition.id}/draft`)).model;
  const values = {
    single: { optionId: "other", text: "成都仓" },
    multi: ["a", { text: "临时部门" }],
    lines: [
      {
        rowSingle: { optionId: "other", text: "行说明" },
        rowMulti: [{ text: "行部门" }],
      },
    ],
  };
  const path = `/pages/${page.id}/records`;
  const created = await h.request(
    path,
    "POST",
    { pageVersion: 1, requestId: randomUUID(), values },
    "admin",
    201,
  );
  const record = created.record;
  const updated = await h.request(`${path}/${record.id}`, "PATCH", {
    pageVersion: 1,
    requestId: randomUUID(),
    changes: [
      {
        fieldId: "single",
        expectedRevision: record.cellRevisions.single,
        value: { optionId: "other", text: "武汉仓" },
      },
    ],
  });
  assert.equal(
    updated.record.cellRevisions.single,
    record.cellRevisions.single + 1,
  );
  assert.deepEqual(updated.record.values.single, {
    optionId: "other",
    text: "武汉仓",
  });
  const fresh = await h.request(
    path,
    "POST",
    { pageVersion: 1, requestId: randomUUID(), values: { lines: [{}] } },
    "admin",
    201,
  );
  assert.equal(fresh.record.values.single, "other");
  assert.deepEqual(fresh.record.values.multi, []);
  assert.equal(fresh.record.values.lines[0].rowSingle, "other");
  assert.deepEqual(fresh.record.values.lines[0].rowMulti, []);
  assert.deepEqual(
    (await h.request(`/data-objects/${definition.id}/draft`)).model,
    model,
  );
  const draftSchema = schema(
    choice("single", "select", {
      options: [
        { id: "a", label: "北京" },
        { id: "other", label: "其他" },
      ],
    }),
    choice("multi", "multiselect"),
    field("lines", "subform", {
      children: [
        choice("rowSingle", "radio"),
        choice("rowMulti", "checkbox", { allowCustomChoices: true }),
      ],
    }),
  );
  await h.request(`/definitions/${definition.id}`, "PUT", {
    title: "选项补充验收",
    expectedRevision: 2,
    schema: draftSchema,
  });
  const preview = await h.request(
    `/definitions/${definition.id}/publish-preview`,
    "POST",
    { expectedRevision: 3 },
    "admin",
    201,
  );
  await h.request(
    `/definitions/${definition.id}/publish`,
    "POST",
    { expectedRevision: 3, impactToken: preview.token },
    "admin",
    201,
  );
  await h.restart();
  const reopened = await h.request(`${path}/${record.id}?version=1`);
  assert.deepEqual(reopened.record.values, updated.record.values);
  assert.equal(reopened.record.definitionVersion, 1);
  assert.deepEqual(
    (await h.request(`/pages/${page.id}?version=1`)).page.schema,
    published.page.schema,
  );
  assert.deepEqual(
    (await h.request(`/records/${record.id}`)).definition.schema.fields[0]
      .options,
    options,
  );
});

test("invalid shapes, unauthorized custom choices and malformed definitions fail atomically", async () => {
  const total = (await h.request("/definitions")).length;
  for (const invalid of [
    choice("bad", "checkbox", { options }),
    choice("bad", "select", { allowCustomChoices: true }),
    choice("bad", "select", {
      options: [...options, { id: "other2", label: "另一个其他", other: true }],
    }),
    choice("bad", "select", { options: [null] }),
    choice("bad", "select", {
      options: [{ id: "a", label: "北京", other: "true" }],
    }),
    choice("bad", "select", {
      defaultValue: { optionId: "other", text: "非预设默认值" },
    }),
    choice("bad", "multiselect", {
      allowCustomChoices: true,
      defaultValue: [{ text: "非预设默认值" }],
    }),
  ])
    await h.request(
      "/definitions",
      "POST",
      { title: "无效定义", schema: schema(invalid) },
      "admin",
      400,
    );
  assert.equal((await h.request("/definitions")).length, total);
  const def = await h.definition(
    "选项校验",
    schema(...both().fields, choice("fixed", "checkbox")),
  );
  const path = `/definitions/${def.id}/records`;
  const base = { single: "other", multi: [], fixed: [] };
  for (const patch of [
    { single: { optionId: "a", text: "伪造" } },
    { single: { text: "无身份" } },
    { single: { optionId: "other", text: 7 } },
    { single: { optionId: "other", text: "a".repeat(10001) } },
    { single: { optionId: "other", text: "合法", extra: true } },
    { multi: [{ text: " " }] },
    { multi: [{ text: "长".repeat(101) }] },
    { multi: [{ text: "重复" }, { text: "重复" }] },
    { multi: [{ optionId: "a", text: "伪造" }] },
    { multi: ["missing"] },
    { fixed: [{ text: "未允许" }] },
  ])
    await h.request(
      path,
      "POST",
      { version: 1, requestId: randomUUID(), values: { ...base, ...patch } },
      "admin",
      400,
    );
  assert.deepEqual(await h.request(path), []);
  const record = await h.record(def.id, {
    single: "other",
    multi: [{ text: "保留" }],
    fixed: [],
  });
  await h.request(
    `/records/${record.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [
        {
          fieldId: "single",
          expectedRevision: 1,
          value: { optionId: "other", text: "合法修改" },
        },
        { fieldId: "multi", expectedRevision: 1, value: [{ text: "" }] },
      ],
    },
    "admin",
    400,
  );
  assert.deepEqual(
    (await h.request(`/records/${record.record.id}`)).record,
    record.record,
  );
  const editor = (await h.request("/users")).find(
    (u: any) => u.username === "editor",
  );
  await h.request(`/definitions/${def.id}/grants`, "PUT", {
    userId: editor.id,
    read: true,
    create: true,
    edit: true,
    scope: "all",
    fields: { single: "read", multi: "edit", fixed: "hidden" },
  });
  await h.request(
    `/records/${record.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [
        {
          fieldId: "single",
          expectedRevision: 1,
          value: { optionId: "other", text: "越权" },
        },
      ],
    },
    "editor",
    403,
  );
  assert.deepEqual(
    (
      await h.request(
        `/records/${record.record.id}`,
        "GET",
        undefined,
        "editor",
      )
    ).record.values.multi,
    [{ text: "保留" }],
  );
});

test("custom-filter list SQL agrees with detail and write permissions for Other IDs and temporary option text", async () => {
  const def = await h.definition("补充选项权限", both());
  const text = "临时' OR true --",
    accepted = await h.record(def.id, {
      single: { optionId: "other", text: "任何说明" },
      multi: [{ text }],
    });
  const rejected = await h.record(def.id, { single: "a", multi: [{ text }] });
  const editor = (await h.request("/users")).find(
    (u: any) => u.username === "editor",
  );
  await h.request(`/definitions/${def.id}/permission-groups`, "PUT", {
    expectedRevision: 0,
    mode: "groups",
    allowMerged: false,
    groups: [
      {
        id: "filtered",
        name: "补充选项",
        enabled: true,
        archived: false,
        subjects: [{ kind: "member", id: editor.id }],
        actions: ["view", "edit"],
        scope: "custom",
        filters: [
          {
            id: "a",
            sourceFieldId: "single",
            operator: "equals",
            source: "constant",
            value: "other",
          },
          {
            id: "b",
            sourceFieldId: "multi",
            operator: "contains",
            source: "constant",
            value: text,
          },
        ],
        fields: { single: "read", multi: "edit" },
        relations: {},
      },
    ],
  });
  assert.deepEqual(
    (
      await h.request(
        `/definitions/${def.id}/records`,
        "GET",
        undefined,
        "editor",
      )
    ).map((r: any) => r.id),
    [accepted.record.id],
  );
  assert.deepEqual(
    (
      await h.request(
        `/records/${accepted.record.id}`,
        "GET",
        undefined,
        "editor",
      )
    ).record.values.single,
    { optionId: "other", text: "任何说明" },
  );
  await h.request(
    `/records/${rejected.record.id}`,
    "GET",
    undefined,
    "editor",
    403,
  );
  await h.request(
    `/records/${rejected.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [{ fieldId: "multi", expectedRevision: 1, value: ["a"] }],
    },
    "editor",
    403,
  );
  const changed = await h.request(
    `/records/${accepted.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [
        { fieldId: "multi", expectedRevision: 1, value: [{ text }, "a"] },
      ],
    },
    "editor",
  );
  assert.deepEqual(changed.record.values.multi, [{ text }, "a"]);
});

test("related candidates display text and match Other identity while snapshot mappings retain complete values", async () => {
  const source = await h.definition("补充来源", both()),
    target = await h.definition("补充资料", both());
  const sourceRecord = await h.record(source.id, { single: "a", multi: [] });
  const targetRecord = await h.record(target.id, {
    single: { optionId: "other", text: "成都仓" },
    multi: [{ text: "临时部门" }],
  });
  await h.record(target.id, { single: "a", multi: [] });
  const relation = await h.relation({
    title: "补充资料",
    sourceDefinitionId: source.id,
    targetDefinitionId: target.id,
    cardinality: "one",
    inverseCardinality: "many",
    labelFieldId: "single",
    columns: ["single", "multi"],
    filters: [
      {
        id: "f",
        sourceFieldId: "single",
        operator: "equals",
        source: "constant",
        value: "other",
      },
    ],
    mappings: [
      { fromTargetFieldId: "single", toSourceFieldId: "single" },
      { fromTargetFieldId: "multi", toSourceFieldId: "multi" },
    ],
    valueMode: "snapshot",
  });
  const path = `/records/${sourceRecord.record.id}/relations/${relation.id}`;
  const candidates = await h.request(`${path}/candidates`);
  assert.equal(candidates.items.length, 1);
  assert.equal(candidates.items[0].label, "成都仓");
  assert.equal(candidates.items[0].displayValues.multi, "临时部门");
  await h.request(
    `${path}/links`,
    "POST",
    {
      requestId: randomUUID(),
      targetRecordId: targetRecord.record.id,
      expectedCells: sourceRecord.record.cellRevisions,
    },
    "admin",
    201,
  );
  assert.deepEqual(
    (await h.request(`/records/${sourceRecord.record.id}`)).record.values,
    targetRecord.record.values,
  );
});
