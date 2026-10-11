import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";
const h = harness();
const custom = {
  background: { type: "image", color: "#f7f8fa", image: 4 },
  header: {
    type: "image",
    color: "#03aba0",
    image: {
      id: "file_11111111-1111-4111-8111-111111111111",
      name: "header.png",
      size: 100,
      type: "image/png",
    },
  },
  title: {
    visible: true,
    align: "center",
    size: 24,
    bold: false,
    italic: true,
    underline: true,
    color: "#123456",
  },
  buttonColor: "#654321",
};
before(() => h.start());
after(() => h.close());

test("external themes round-trip through page publication and restart without altering data versions, grants or existing records", async () => {
  const source = schema(field("name"));
  const styled = {
    ...source,
    settings: { ...source.settings, externalStyle: { theme: 1 } },
  };
  const def = await h.definition("外链样式", styled);
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const model = await h.request(`/data-objects/${def.id}/draft`);
  const grants = await h.request(`/definitions/${def.id}/grants`);
  const saved = await h.request(
    `/pages/${page.id}/records`,
    "POST",
    { pageVersion: 1, requestId: randomUUID(), values: { name: "原记录" } },
    "admin",
    201,
  );
  const record = (
    await h.request(`/pages/${page.id}/records/${saved.record.id}`)
  ).record;
  let draft = await h.request(`/pages/${page.id}/draft`);
  draft.schema.settings.externalStyle = { theme: 4 };
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
  await h.restart();
  assert.deepEqual(
    (await h.request(`/pages/${page.id}`)).page.schema.settings.externalStyle,
    { theme: 4 },
  );
  assert.deepEqual(
    (await h.request(`/pages/${page.id}?version=1`)).page.schema.settings
      .externalStyle,
    { theme: 1 },
  );
  assert.deepEqual(
    (await h.request(`/pages/${page.id}/records/${saved.record.id}`)).record,
    record,
  );
  assert.deepEqual(await h.request(`/data-objects/${def.id}/draft`), model);
  assert.deepEqual(await h.request(`/definitions/${def.id}/grants`), grants);
  draft = await h.request(`/pages/${page.id}/draft`);
  draft.schema.settings.externalStyle = { theme: 4, custom };
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
  await h.restart();
  assert.deepEqual(
    (await h.request(`/pages/${page.id}`)).page.schema.settings.externalStyle,
    { theme: 4, custom },
  );
  assert.deepEqual(
    (await h.request(`/pages/${page.id}?version=2`)).page.schema.settings
      .externalStyle,
    { theme: 4 },
  );
  assert.deepEqual(
    (await h.request(`/pages/${page.id}/records/${saved.record.id}`)).record,
    record,
  );
  assert.deepEqual(await h.request(`/data-objects/${def.id}/draft`), model);
  assert.deepEqual(await h.request(`/definitions/${def.id}/grants`), grants);
});
test("invalid templates fail atomically on definition and page saves instead of dropping settings", async () => {
  const input = schema(field("name"));
  const def = await h.definition("样式校验", input);
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const original = await h.request(`/pages/${page.id}/draft`);
  for (const style of [
    null,
    [],
    { theme: -1 },
    { theme: 23 },
    { theme: "2" },
    { theme: 1.5 },
    { theme: 1, image: "https://unknown" },
    { theme: 4, custom: null },
    {
      theme: 4,
      custom: { ...custom, title: { ...custom.title, align: "diagonal" } },
    },
    {
      theme: 4,
      custom: {
        ...custom,
        header: { ...custom.header, image: "https://unknown" },
      },
    },
    {
      theme: 4,
      custom: {
        ...custom,
        header: {
          ...custom.header,
          image: {
            ...custom.header.image,
            preview: "data:image/svg+xml;base64,AAA",
          },
        },
      },
    },
    {
      theme: 4,
      custom: {
        ...custom,
        header: {
          ...custom.header,
          image: { ...custom.header.image, size: 5 * 1024 * 1024 + 1 },
        },
      },
    },
    { theme: 4, custom: { ...custom, buttonColor: "url(https://unknown)" } },
  ]) {
    await h.request(
      "/definitions",
      "POST",
      {
        title: "非法样式",
        schema: {
          ...input,
          settings: { ...input.settings, externalStyle: style },
        },
      },
      "admin",
      400,
    );
    await h.request(
      `/pages/${page.id}`,
      "PUT",
      {
        ...original,
        expectedRevision: original.revision,
        schema: {
          ...original.schema,
          settings: { ...original.schema.settings, externalStyle: style },
        },
      },
      "admin",
      400,
    );
    assert.deepEqual(await h.request(`/pages/${page.id}/draft`), original);
  }
});
