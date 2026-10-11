import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { harness, field, schema } from "./helpers";
import { maxChoiceOptions } from "@platform/contracts";
const h = harness();
before(() => h.start());
after(() => h.close());
const options = Array.from({ length: maxChoiceOptions }, (_, index) => ({
  id: `option_${index}`,
  label: `选项${index + 1}`,
}));
const choice = (
  id: string,
  type: string,
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
    ...extra,
  });

test("1000 options survive publishing, page projection, records and restart in main and subform fields", async () => {
  const definition = await h.definition(
    "选项数量验收",
    schema(
      choice("status", "select", { defaultValue: "option_999" }),
      field("lines", "subform", {
        children: [
          choice("checks", "multiselect", {
            defaultValue: ["option_999", "option_0"],
          }),
        ],
      }),
    ),
  );
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const published = await h.request(`/pages/${page.id}`);
  assert.equal(
    published.model.fields[0].settings.options.length,
    maxChoiceOptions,
  );
  assert.equal(
    published.model.fields[1].children[0].settings.options.at(-1).id,
    "option_999",
  );
  const record = await h.record(definition.id, {
    status: "option_999",
    lines: [{ checks: ["option_999", "option_0"] }],
  });
  assert.deepEqual(record.record.values.lines[0].checks, [
    "option_999",
    "option_0",
  ]);
  await h.restart();
  const loaded = await h.request(`/records/${record.record.id}`);
  assert.equal(loaded.record.values.status, "option_999");
  assert.deepEqual(loaded.record.values.lines[0].checks, [
    "option_999",
    "option_0",
  ]);
  assert.equal(
    loaded.definition.schema.fields[0].options.at(-1).label,
    "选项1000",
  );
});

test("too many options and long labels fail atomically while incomplete empty drafts remain repairable", async () => {
  const count = (await h.request("/definitions")).length;
  for (const invalid of [
    [...options, { id: "extra", label: "多余选项" }],
    [{ id: "long", label: "字".repeat(101) }],
  ]) {
    await h.request(
      "/definitions",
      "POST",
      {
        title: "非法选项",
        schema: schema(choice("bad", "radio", { options: invalid })),
      },
      "admin",
      400,
    );
  }
  assert.equal((await h.request("/definitions")).length, count);
  const draft = await h.request(
    "/data-objects",
    "POST",
    {
      title: "选项草稿",
      model: {
        version: 1,
        fields: [
          {
            id: "empty",
            name: "empty",
            kind: "choices",
            required: false,
            settings: {
              maxLength: 200,
              precision: 2,
              options: [],
              defaultValue: [],
              choiceSource: {
                mode: "manual",
                formId: "",
                labelFieldId: "",
                valueFieldId: "",
                filters: [],
                sort: "none",
                deduplicate: true,
              },
            },
            children: [],
          },
        ],
      },
    },
    "admin",
    201,
  );
  await h.request(
    `/data-objects/${draft.id}/publish-preview`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    400,
  );
  assert.equal(
    (await h.request(`/data-objects/${draft.id}/draft`)).latestVersion,
    0,
  );
});
