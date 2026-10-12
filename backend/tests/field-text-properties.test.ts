import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeFormSchema,
  separateFormSchema,
  type FormSchema,
} from "@platform/contracts";
import { parseSchema } from "../src/core/database/schema";
import { parseModel, parsePage } from "../src/modules/pages/page-schema";
import { field, schema } from "./helpers";

function throughPages(source: unknown) {
  const parsed = parseSchema(source);
  const split = separateFormSchema(parsed);
  return {
    parsed,
    model: parseModel(split.model),
    page: parsePage(split.page, split.model),
  };
}

test("field titles use the same 1000-character bound through definitions, models and pages", () => {
  const label = "题".repeat(1000);
  const source = schema(
    field("name", "text", { label }),
    field("lines", "subform", { children: [field("item", "text", { label })] }),
  );
  const result = throughPages(source);
  assert.equal(result.model.fields[0]!.name, label);
  assert.equal(
    composeFormSchema(result.model, result.page).fields[1]!.children[0]!.label,
    label,
  );
  assert.throws(
    () => parseSchema(schema(field("name", "text", { label: label + "超" }))),
    /字段标题不能超过1000/,
  );
});

test("rich field descriptions round-trip without imposing a raw-HTML 2000-character limit", () => {
  const description = `<p><strong>${"说明".repeat(1200)}</strong></p><img src="https://example.test/guide.png">`;
  const source = schema(
    field("name", "text", { description }),
    field("lines", "subform", {
      children: [field("item", "text", { description })],
    }),
  );
  const original = structuredClone(source);
  const result = throughPages(source);
  assert.equal(result.parsed.fields[0]!.description, description);
  assert.equal(result.page.controls[0]!.properties.description, description);
  assert.equal(
    result.page.controls[1]!.children[0]!.properties.description,
    description,
  );
  assert.deepEqual(source, original);
});

test("supported placeholders obey the same bound before and after page separation", () => {
  const source = schema(
    field("name", "text", { placeholder: "示".repeat(100) }),
  );
  const parsed = throughPages(source).parsed;
  assert.throws(
    () =>
      parseSchema(
        schema(field("name", "text", { placeholder: "示".repeat(101) })),
      ),
    /提示文字不能超过100/,
  );
  const split = separateFormSchema(parsed);
  split.page.controls[0]!.properties.placeholder += "超";
  assert.throws(
    () => parsePage(split.page, split.model),
    /提示文字不能超过100/,
  );
});

test("historical omitted text properties and inactive phone-column placeholders remain intact", () => {
  const source = schema(
    field("lines", "subform", {
      children: [
        field("phone", "phone", {
          placeholder: "旧".repeat(150),
          defaultValue: "",
        }),
      ],
    }),
  );
  const result = throughPages(source);
  assert.equal(result.parsed.fields[0]!.description, undefined);
  assert.equal(
    result.page.controls[0]!.children[0]!.properties.placeholder,
    "旧".repeat(150),
  );
});

test("malformed field descriptions and placeholders fail at every server definition boundary", () => {
  for (const key of ["description", "placeholder"] as const) {
    for (const value of [null, [], {}, 12]) {
      assert.throws(
        () => parseSchema(schema(field("name", "text", { [key]: value }))),
        /格式不合法/,
      );
      const split = separateFormSchema(parseSchema(schema(field("name"))));
      (split.page.controls[0]!.properties as any)[key] = value;
      assert.throws(() => parsePage(split.page, split.model), /格式不合法/);
    }
  }
});

test("page title overrides inherit a valid model label or obey the shared field-title rule", () => {
  const split = separateFormSchema(
    parseSchema(schema(field("name"))) as FormSchema,
  );
  split.page.controls[0]!.properties.label = null;
  assert.doesNotThrow(() => parsePage(split.page, split.model));
  split.page.controls[0]!.properties.label = "题".repeat(1000);
  assert.doesNotThrow(() => parsePage(split.page, split.model));
  split.page.controls[0]!.properties.label += "超";
  assert.throws(
    () => parsePage(split.page, split.model),
    /字段标题不能超过1000/,
  );
});
