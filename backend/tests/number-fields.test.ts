import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fieldValueLabel } from "@platform/contracts";
import { harness, field, schema } from "./helpers";

const h = harness();
const source = schema(
  field("amount", "number", {
    format: "number",
    retainPrecision: true,
    precision: 2,
    numberGrouping: true,
    limitRange: true,
    min: 0,
    max: 1000000,
    defaultValue: 12.3456,
  }),
  field("rate", "number", {
    format: "percent",
    retainPrecision: true,
    precision: 2,
    limitRange: true,
    min: 0,
    max: 1,
    defaultValue: 0.125678,
  }),
  field("free", "number", { format: "number", retainPrecision: false }),
  field("legacy", "number", { format: "none", precision: 2 }),
);
let definition: any, record: any;
before(async () => {
  await h.start();
  definition = await h.definition("数字格式验收", source);
});
after(() => h.close());

test("number settings, defaults and unrounded stored values survive definition separation, record writes and restart", async () => {
  const saved = (await h.request(`/definitions/${definition.id}`)).definition;
  assert.equal(saved.schema.fields[0].numberGrouping, true);
  const values = {
    amount: 12345.6789,
    rate: 0.123456,
    free: 1.23456789,
    legacy: 1.23,
  };
  record = await h.record(definition.id, values);
  assert.deepEqual(record.record.values, values);
  assert.equal(
    fieldValueLabel(saved.schema.fields[0], values.amount),
    "12,345.68",
  );
  assert.equal(fieldValueLabel(saved.schema.fields[1], values.rate), "12.35%");
  assert.equal(fieldValueLabel(saved.schema.fields[3], values.legacy), "1.23");
  const defaults = await h.record(definition.id, {});
  assert.equal(defaults.record.values.amount, 12.3456);
  assert.equal(defaults.record.values.rate, 0.125678);
  await h.restart();
  assert.deepEqual(
    (await h.request(`/records/${record.record.id}`)).record.values,
    values,
  );
});

test("invalid numbers, enabled bounds and legacy decimal constraints reject an entire write", async () => {
  const count = (await h.request(`/definitions/${definition.id}/records`))
    .length;
  for (const [values, message] of [
    [{ free: "1,234" }, "请输入有效数字"],
    [{ free: 1e100 }, "请输入有效数字"],
    [{ rate: 1.0001 }, "超出允许范围"],
    [{ amount: -1 }, "超出允许范围"],
    [{ legacy: 1.234 }, "最多输入 2 位小数"],
  ] as const) {
    const result = await h.request(
      `/definitions/${definition.id}/records`,
      "POST",
      { requestId: randomUUID(), version: 1, values },
      "admin",
      400,
    );
    assert.ok(result.message.includes(message));
  }
  assert.equal(
    (await h.request(`/definitions/${definition.id}/records`)).length,
    count,
  );
});

test("configuration rejects malformed formatting and flags; disabled bounds retain settings without constraining records", async () => {
  const count = (await h.request("/definitions")).length;
  for (const extra of [
    { format: "currency" },
    { retainPrecision: "yes" },
    { numberGrouping: 1 },
    { limitRange: "false" },
    { min: 10, max: 1 },
  ]) {
    await h.request(
      "/definitions",
      "POST",
      {
        title: "非法数字配置",
        schema: schema(
          field("n", "number", {
            format: "number",
            retainPrecision: true,
            ...extra,
          }),
        ),
      },
      "admin",
      400,
    );
  }
  assert.equal((await h.request("/definitions")).length, count);
  const disabled = await h.definition(
    "关闭范围验收",
    schema(
      field("n", "number", {
        format: "number",
        retainPrecision: false,
        limitRange: false,
        min: 10,
        max: 1,
      }),
    ),
  );
  const saved = await h.record(disabled.id, { n: -20.1234 });
  assert.equal(saved.record.values.n, -20.1234);
});

test("editing formatting in a new published version preserves old record values and their original format", async () => {
  let draft = await h.request(`/data-objects/${definition.id}/draft`);
  const amount = draft.model.fields.find((f: any) => f.id === "amount");
  amount.settings.numberGrouping = false;
  amount.settings.retainPrecision = false;
  draft = await h.request(`/data-objects/${definition.id}`, "PUT", {
    ...draft,
    expectedRevision: draft.revision,
  });
  const impact = await h.request(
    `/data-objects/${definition.id}/publish-preview`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    201,
  );
  assert.ok(
    impact.changes.changed[0].details.some((text: string) =>
      text.startsWith("显示千分符："),
    ),
  );
  await h.request(
    `/data-objects/${definition.id}/publish`,
    "POST",
    { expectedRevision: draft.revision, impactToken: impact.token },
    "admin",
    201,
  );
  const old = await h.request(`/records/${record.record.id}`);
  assert.equal(old.record.values.amount, 12345.6789);
  assert.equal(old.definition.schema.fields[0].numberGrouping, true);
  assert.equal(
    fieldValueLabel(old.definition.schema.fields[0], old.record.values.amount),
    "12,345.68",
  );
  const latest = await h.record(
    definition.id,
    { amount: 12345.6789 },
    "admin",
    2,
  );
  assert.equal(
    fieldValueLabel(
      latest.definition.schema.fields[0],
      latest.record.values.amount,
    ),
    "12345.6789",
  );
});
