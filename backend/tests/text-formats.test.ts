import { test } from "node:test";
import assert from "node:assert/strict";
import {
  separateFormSchema,
  composeFormSchema,
  type FormField,
} from "@platform/contracts";
import { scalar } from "../src/field-values";
import { parseSchema } from "../src/schema";
import { field, schema } from "./helpers";
import { dataModelImpact } from "../src/model-impact";
import type { Transaction } from "../src/database";

const values = {
  mobile: "086-12000000001",
  tel: "0571-23456789-0123",
  zip: "000001",
  id: "11000020000229123X",
  email: "sample+tag@example.technology",
};
const source = () =>
  schema(
    ...Object.entries(values).map(([format, value]) =>
      field(format, "text", { format, defaultValue: value }),
    ),
  );
test("server definitions and compatibility projections preserve all built-in text formats and original identifiers", () => {
  const parsed = parseSchema(source()),
    parts = separateFormSchema(parsed),
    composed = composeFormSchema(parts.model, parts.page);
  assert.deepEqual(
    composed.fields.map((f) => [f.id, f.format, f.defaultValue]),
    Object.entries(values).map(([format, value]) => [format, format, value]),
  );
  assert.throws(
    () => parseSchema(schema(field("bad", "text", { format: "script" }))),
    /文本格式/,
  );
  assert.throws(
    () => parseSchema(schema(field("bad", "textarea", { format: "zip" }))),
    /暂不支持/,
  );
});
test("server scalar writes enforce the same formats without normalizing postal or contact values", () => {
  const parsed = parseSchema(source());
  for (const f of parsed.fields) {
    const value = values[f.id as keyof typeof values];
    assert.equal(scalar(f, value), value);
    assert.throws(() => scalar(f, "bad"), /有效/);
    assert.throws(() => scalar(f, 100001), /文本格式/);
    assert.equal(scalar({ ...f, required: false }, ""), "");
    assert.throws(() => scalar({ ...f, required: true }, ""), /不能为空/);
  }
});
test("server main and child default validation rejects malformed formats while preserving historical email behavior", () => {
  assert.throws(
    () =>
      parseSchema(
        schema(field("zip", "text", { format: "zip", defaultValue: "bad" })),
      ),
    /邮政编码/,
  );
  assert.throws(
    () =>
      parseSchema(
        schema(
          field("rows", "subform", {
            children: [
              field("tel", "text", { format: "tel", defaultValue: "bad" }),
            ],
          }),
        ),
      ),
    /电话号码/,
  );
  const historical = field("legacy", "textarea", {
    format: "email",
  }) as unknown as FormField;
  assert.equal(scalar(historical, values.email), values.email);
  assert.throws(() => scalar(historical, "bad"), /邮箱/);
});

test("existing publication review presents business format names instead of raw identifiers", async () => {
  const old = separateFormSchema(
    parseSchema(schema(field("code", "text", { format: "none" }))),
  ).model;
  const next = separateFormSchema(
    parseSchema(schema(field("code", "text", { format: "zip" }))),
  ).model;
  const tx = {
    query: async (sql: string) => ({
      rows: sql.startsWith("SELECT v.title,m.model")
        ? [{ title: "编码", model: old }]
        : [],
    }),
  } as unknown as Transaction;
  const impact = await dataModelImpact(
    tx,
    {
      id: "definition",
      workspace_id: "workspace",
      latest_version: 1,
      revision: 2,
      title: "编码",
    },
    next,
  );
  assert.deepEqual(impact.changes.changed[0].details, [
    "格式：普通文本 → 邮政编码",
  ]);
});
