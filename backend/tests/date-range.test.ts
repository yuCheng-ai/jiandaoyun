import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { emptyDateRange, separateFormSchema, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness();
before(() => h.start());
after(() => h.close());
const range = () => {
  const result = emptyDateRange();
  result.weekdaysEnabled = true;
  result.weekdays = [1, 2, 3, 4, 5];
  Object.assign(result.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-01",
  });
  Object.assign(result.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-31",
  });
  return result;
};

test("date ranges persist with page versions, without constraining backfilled values or creating a data-model migration", async () => {
  const definition = await h.definition(
    "日期范围验收",
    schema(
      field("date", "datetime", {
        format: "date",
        dateRange: range(),
        defaultValue: "2020-01-01",
      }),
    ),
  );
  const object = await h.request(`/data-objects/${definition.id}/draft`);
  assert.equal(object.model.fields[0].settings.dateRange, undefined);
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const original = await h.request(`/pages/${page.id}`);
  assert.deepEqual(
    original.page.schema.controls[0].properties.dateRange,
    range(),
  );
  const record = await h.record(definition.id, { date: "2024-03-02" }); // Saturday: valid stored civil date.
  assert.equal(record.record.values.date, "2024-03-02");
  let draft = await h.request(`/pages/${page.id}/draft`);
  draft.schema.controls[0].properties.dateRange.earliest.enabled = false;
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
  assert.equal(
    (await h.request(`/data-objects/${definition.id}/draft`)).latestVersion,
    1,
  );
  assert.equal(
    (await h.request(`/pages/${page.id}?version=1`)).page.schema.controls[0]
      .properties.dateRange.earliest.enabled,
    true,
  );
  assert.equal(
    (await h.request(`/pages/${page.id}`)).page.schema.controls[0].properties
      .dateRange.earliest.enabled,
    false,
  );
  await h.restart();
  assert.equal(
    (await h.request(`/records/${record.record.id}`)).record.values.date,
    "2024-03-02",
  );
});

test("malformed ranges and wrong field scope reject publication atomically; incomplete references remain repairable drafts", async () => {
  const definition = await h.definition(
    "日期字段引用",
    schema(
      field("main", "datetime", { format: "date" }),
      field("lines", "subform", {
        children: [
          field("start", "datetime", { format: "date" }),
          field("end", "datetime", { format: "date" }),
        ],
      }),
    ),
  );
  const model = (await h.request(`/data-objects/${definition.id}/draft`)).model;
  const parts = separateFormSchema(
    schema(
      field("main", "datetime", { format: "date" }),
      field("lines", "subform", {
        children: [
          field("start", "datetime", { format: "date" }),
          field("end", "datetime", { format: "date" }),
        ],
      }),
    ) as unknown as FormSchema,
  );
  const config = emptyDateRange();
  Object.assign(config.earliest, {
    enabled: true,
    mode: "field",
    fieldId: "main",
  });
  parts.page.controls[1]!.children[1]!.properties.dateRange = config;
  let page = await h.request(
    "/pages",
    "POST",
    {
      title: "行内日期",
      definitionId: definition.id,
      definitionVersion: 1,
      schema: parts.page,
    },
    "admin",
    201,
  );
  const failed = await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: page.revision },
    "admin",
    400,
  );
  assert.match(failed.message, /同一范围/);
  assert.equal((await h.request(`/pages/${page.id}/draft`)).latestVersion, 0);
  page = await h.request(`/pages/${page.id}/draft`);
  page.schema.controls[1].children[1].properties.dateRange.earliest.fieldId =
    "start";
  page = await h.request(`/pages/${page.id}`, "PUT", {
    ...page,
    expectedRevision: page.revision,
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: page.revision },
    "admin",
    201,
  );
  assert.equal(
    (await h.request(`/pages/${page.id}`)).page.schema.controls[1].children[1]
      .properties.dateRange.earliest.fieldId,
    "start",
  );
  assert.deepEqual(
    (await h.request(`/data-objects/${definition.id}/draft`)).model,
    model,
  );
});

test("saving an inverted page range retains its draft, rejects publication and leaves the current version intact", async () => {
  const definition = await h.definition(
    "日期范围草稿",
    schema(field("date", "datetime", { format: "date", dateRange: range() })),
  );
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const published = await h.request(`/pages/${page.id}`);
  let draft = await h.request(`/pages/${page.id}/draft`);
  draft.schema.controls[0].properties.dateRange.earliest.value = "2024-04-01";
  draft = await h.request(`/pages/${page.id}`, "PUT", {
    ...draft,
    expectedRevision: draft.revision,
  });
  await h.restart();
  draft = await h.request(`/pages/${page.id}/draft`);
  assert.equal(
    draft.schema.controls[0].properties.dateRange.earliest.value,
    "2024-04-01",
  );
  const failed = await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    400,
  );
  assert.match(failed.message, /最早可选时间不能晚于/);
  assert.deepEqual((await h.request(`/pages/${page.id}`)).page, published.page);
  draft.schema.controls[0].properties.dateRange.latest.value = "2024-04-30";
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
  assert.equal(
    (await h.request(`/pages/${page.id}`)).page.schema.controls[0].properties
      .dateRange.earliest.value,
    "2024-04-01",
  );
  assert.deepEqual(
    (await h.request(`/pages/${page.id}?version=1`)).page.schema.controls[0]
      .properties.dateRange,
    range(),
  );
});
