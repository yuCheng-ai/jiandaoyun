import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";
const h = harness();
before(() => h.start());
after(() => h.close());
const options = [
  { id: "a", label: "北京" },
  { id: "b", label: "上海" },
  { id: "c", label: "广州" },
];
const choice = (
  id: string,
  type = "checkbox",
  extra: Record<string, unknown> = {},
) =>
  field(id, type, {
    options,
    choiceSource: {
      mode: "manual",
      formId: "",
      labelFieldId: "",
      valueFieldId: "",
      filters: [],
      sort: "none",
      deduplicate: true,
    },
    defaultValue: [],
    ...extra,
  });
const properties = {
  coloredOptions: true,
  optionColors: { a: "#5865f5", b: "#46c26f", c: "#eb5050" },
  choiceLayout: "vertical",
  selectionLimit: { enabled: true, min: 1, max: 2 },
};

test("choice presentation and counts persist as page properties without changing the data model or historical versions", async () => {
  const def = await h.definition(
    "选项属性验收",
    schema(choice("checks", "checkbox", properties)),
  );
  const model = (await h.request(`/data-objects/${def.id}/draft`)).model;
  for (const key of Object.keys(properties))
    assert.equal(model.fields[0].settings[key], undefined);
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  assert.deepEqual(
    (await h.request(`/pages/${page.id}`)).page.schema.controls[0].properties
      .optionColors,
    properties.optionColors,
  );
  let draft = await h.request(`/pages/${page.id}/draft`);
  Object.assign(draft.schema.controls[0].properties, {
    coloredOptions: false,
    choiceLayout: "horizontal",
    selectionLimit: { enabled: false, min: 1, max: 2 },
  });
  draft = await h.request(`/pages/${page.id}`, "PUT", {
    ...draft,
    expectedRevision: draft.revision,
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    201,
  );
  assert.deepEqual(
    (await h.request(`/data-objects/${def.id}/draft`)).model,
    model,
  );
  assert.equal(
    (await h.request(`/data-objects/${def.id}/draft`)).latestVersion,
    1,
  );
  assert.equal(
    (await h.request(`/pages/${page.id}?version=1`)).page.schema.controls[0]
      .properties.coloredOptions,
    true,
  );
  await h.restart();
  const current = (await h.request(`/pages/${page.id}`)).page.schema.controls[0]
    .properties;
  assert.equal(current.coloredOptions, false);
  assert.equal(current.choiceLayout, "horizontal");
  assert.deepEqual(current.optionColors, properties.optionColors);
  assert.deepEqual(current.selectionLimit, { enabled: false, min: 1, max: 2 });
});

test("switching choice presentation keeps data identities, grants and pinned records across publication and restart", async () => {
  const def = await h.definition("选项切换验收", schema(choice("single", "radio", { defaultValue: "b", coloredOptions: true, optionColors: properties.optionColors, choiceLayout: "horizontal" }), field("lines", "subform", { children: [choice("multi", "multiselect", { defaultValue: ["b", "a"], selectionLimit: properties.selectionLimit })] })));
  const model = (await h.request(`/data-objects/${def.id}/draft`)).model;
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const editor = (await h.request("/users")).find((user: any) => user.username === "editor");
  await h.permissionGroup(def.id, {
    id: "member_" + editor.id,
    subjects: [{ kind: "member", id: editor.id }],
    scope: "all",
    fields: { single: "edit", lines: "edit", multi: "read" },
    actions: ["view", "create", "edit"],
  });
  const record = await h.request(`/pages/${page.id}/records`, "POST", { pageVersion: 1, requestId: randomUUID(), values: { single: "a", lines: [{}] } }, "editor", 201);
  const before = (await h.request(`/pages/${page.id}/records/${record.record.id}`, "GET", undefined, "editor")).record;
  let draft = await h.request(`/pages/${page.id}/draft`);
  draft.schema.controls[0].type = "select";
  draft.schema.controls[1].children[0].type = "checkbox";
  draft.schema.controls[1].children[0].properties.choiceLayout = "vertical";
  draft = await h.request(`/pages/${page.id}`, "PUT", { ...draft, expectedRevision: draft.revision });
  const expectedSchema = structuredClone(draft.schema);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  await h.restart();
  assert.deepEqual((await h.request(`/data-objects/${def.id}/draft`)).model, model);
  assert.equal((await h.request(`/data-objects/${def.id}/draft`)).latestVersion, 1);
  assert.deepEqual((await h.request(`/pages/${page.id}`)).page.schema, expectedSchema);
  assert.equal((await h.request(`/pages/${page.id}?version=1`)).page.schema.controls[0].type, "radio");
  assert.deepEqual((await h.request(`/pages/${page.id}/records/${record.record.id}`, "GET", undefined, "editor")).record, before);
  const next = await h.request(`/pages/${page.id}/records`, "POST", { pageVersion: 2, requestId: randomUUID(), values: { single: "b", lines: [{}] } }, "editor", 201);
  assert.equal(next.record.values.single, "b");
  assert.deepEqual(next.record.values.lines[0].multi, ["b", "a"]);
  await h.request(`/pages/${page.id}/records`, "POST", { pageVersion: 2, requestId: randomUUID(), values: { single: "b", lines: [{ multi: ["c"] }] } }, "editor", 403);
});

test("page submissions enforce main and row counts atomically; partial drafts keep values and submit only after repair", async () => {
  const def = await h.definition(
    "选择项数验收",
    schema(
      choice("checks", "checkbox", properties),
      field("lines", "subform", {
        children: [
          choice("rowchecks", "multiselect", {
            selectionLimit: properties.selectionLimit,
          }),
        ],
      }),
    ),
  );
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const path = `/pages/${page.id}/records`,
    invalid = { checks: ["a", "b", "c"], lines: [{ rowchecks: ["a"] }] };
  for (const values of [
    invalid,
    { checks: [], lines: [] },
    { checks: ["a"], lines: [{ rowchecks: ["a", "b", "c"] }] },
  ])
    await h.request(
      path,
      "POST",
      { pageVersion: 1, requestId: randomUUID(), values },
      "admin",
      400,
    );
  assert.deepEqual(await h.request(`/definitions/${def.id}/records`), []);
  const saved = await h.request(
    path,
    "POST",
    {
      pageVersion: 1,
      requestId: randomUUID(),
      state: "draft",
      values: invalid,
    },
    "admin",
    201,
  );
  assert.equal(saved.record.state, "draft");
  assert.deepEqual(saved.record.values.checks, invalid.checks);
  const submitPath = `${path}/${saved.record.id}/submit`,
    command = {
      pageVersion: 1,
      expectedRevision: saved.record.revision,
      requestId: randomUUID(),
    };
  await h.request(submitPath, "POST", command, "admin", 400);
  const unchanged = await h.request(`${path}/${saved.record.id}`);
  assert.equal(unchanged.record.state, "draft");
  assert.equal(unchanged.record.revision, saved.record.revision);
  const result = await h.request(
    submitPath,
    "POST",
    {
      ...command,
      changes: [
        {
          fieldId: "checks",
          expectedRevision: saved.record.cellRevisions.checks,
          value: ["a", "b"],
        },
      ],
    },
    "admin",
    201,
  );
  assert.equal(result.record.state, "active");
  assert.deepEqual(result.record.values.checks, ["a", "b"]);
  await h.request(
    `${path}/${saved.record.id}`,
    "PATCH",
    {
      pageVersion: 1,
      requestId: randomUUID(),
      changes: [
        {
          subformId: "lines",
          rowId: result.record.values.lines[0]._rowId,
          fieldId: "rowchecks",
          expectedRevision: 1,
          value: [],
        },
      ],
    },
    "admin",
    400,
  );
  assert.deepEqual(
    (await h.request(`${path}/${saved.record.id}`)).record.values.lines[0]
      .rowchecks,
    ["a"],
  );
  const editor = (await h.request("/users")).find((user: any) => user.username === "editor");
  await h.permissionGroup(def.id, {
    id: "member_" + editor.id,
    subjects: [{ kind: "member", id: editor.id }],
    scope: "all",
    fields: { checks: "hidden", lines: "edit", rowchecks: "edit" },
    actions: ["view", "create", "edit"],
  });
  const masked = await h.request(path, "POST", { pageVersion: 1, requestId: randomUUID(), values: { lines: [{ rowchecks: ["a"] }] } }, "editor", 201);
  assert.equal(masked.record.state, "active"); assert.equal(Object.hasOwn(masked.record.values, "checks"), false);

});

test("malformed colors and count bounds are rejected; incomplete count drafts are repairable but cannot publish", async () => {
  const def = await h.definition("可修正配置", schema(choice("checks")));
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  let draft = await h.request(`/pages/${page.id}/draft`);
  for (const extra of [
    { coloredOptions: "true" },
    { optionColors: { a: "url(javascript:bad)" } },
    { selectionLimit: { enabled: true, min: -1 } },
    { selectionLimit: { enabled: true, max: 1.5 } },
    { choiceLayout: "grid" },
  ]) {
    const invalid = structuredClone(draft.schema);
    Object.assign(invalid.controls[0].properties, extra);
    await h.request(`/pages/${page.id}`, "PUT", {
      ...draft,
      schema: invalid,
      expectedRevision: draft.revision,
    }, "admin", 400);
  }
  assert.deepEqual(await h.request(`/pages/${page.id}/draft`), draft);
  draft.schema.controls[0].properties.selectionLimit = {
    enabled: true,
    min: 2,
    max: 1,
  };
  draft = await h.request(`/pages/${page.id}`, "PUT", {
    ...draft,
    expectedRevision: draft.revision,
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    400,
  );
  assert.equal((await h.request(`/pages/${page.id}/draft`)).latestVersion, 1);
  const revision = draft.revision,
    invalid = structuredClone(draft);
  invalid.schema.controls[0].properties.optionColors = {
    a: "red;display:none",
  };
  await h.request(
    `/pages/${page.id}`,
    "PUT",
    { ...invalid, expectedRevision: revision },
    "admin",
    400,
  );
  assert.equal((await h.request(`/pages/${page.id}/draft`)).revision, revision);
  draft.schema.controls[0].properties.selectionLimit.max = 3;
  draft = await h.request(`/pages/${page.id}`, "PUT", {
    ...draft,
    expectedRevision: revision,
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    201,
  );
});
