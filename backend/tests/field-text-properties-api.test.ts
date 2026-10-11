import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { harness, field, schema } from "./helpers";

const h = harness();
before(() => h.start());
after(() => h.close());

test("field text properties survive server publication, rejected edits, history and restart", async () => {
  const image = readFileSync(
    resolve(__dirname, "../../../docs/qa-files/SYN-OCR.png"),
  ).toString("base64");
  const description = `<p><strong>${"说明".repeat(1200)}</strong></p><img src="data:image/png;base64,${image}">`;
  const label = "题".repeat(1000);
  const definition = await h.definition(
    "字段文案契约验收",
    schema(
      field("name", "text", {
        label,
        description,
        placeholder: "示".repeat(100),
      }),
      field("lines", "subform", {
        children: [field("item", "text", { description })],
      }),
    ),
  );
  const [page] = await h.request(`/pages?definitionId=${definition.id}`);
  const path = `/pages/${page.id}`;
  const original = await h.request(`${path}?version=1`);
  assert.equal(
    original.page.schema.controls[0].properties.description,
    description,
  );
  assert.equal(original.model.fields[0].name, label);
  assert.equal(
    original.page.schema.controls[1].children[0].properties.description,
    description,
  );
  const draft = await h.request(`${path}/draft`);
  const invalid = structuredClone(draft);
  invalid.schema.controls[0].properties.placeholder += "超";
  const failure = await h.request(
    path,
    "PUT",
    { ...invalid, expectedRevision: draft.revision },
    "admin",
    400,
  );
  assert.match(failure.message, /提示文字不能超过100/);
  assert.deepEqual(await h.request(`${path}/draft`), draft);
  draft.schema.controls[0].properties.description += "<p>追加说明</p>";
  const saved = await h.request(path, "PUT", {
    ...draft,
    expectedRevision: draft.revision,
  });
  await h.request(
    `${path}/publish`,
    "POST",
    { expectedRevision: saved.revision },
    "admin",
    201,
  );
  await h.restart();
  assert.deepEqual(await h.request(`${path}?version=1`), original);
  const current = await h.request(path);
  assert.equal(
    current.page.schema.controls[0].properties.description,
    description + "<p>追加说明</p>",
  );
  assert.equal(
    current.page.schema.controls[1].children[0].properties.description,
    description,
  );
  assert.equal(current.page.definitionVersion, 1);
});
