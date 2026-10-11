import { test } from "node:test";
import assert from "node:assert/strict";
import { separateFormSchema } from "@platform/contracts";
import { parseSchema } from "../src/schema";
import { parsePage } from "../src/page-schema";
import { field, schema } from "./helpers";

test("native definition and page parsers preserve valid subfield presentation and reject malformed widths", () => {
  const source = parseSchema(
    schema(
      field("lines", "subform", {
        children: [field("code", "text", { subformWidth: 320 })],
      }),
    ),
  );
  const split = separateFormSchema(source);
  assert.equal(
    parsePage(split.page, split.model).controls[0]?.children[0]?.properties
      .subformWidth,
    320,
  );
  assert.ok(
    !Object.hasOwn(
      split.model.fields[0]!.children[0]!.settings,
      "subformWidth",
    ),
  );
  for (const width of [0, -1, 1001, 20.5, "custom", null, {}]) {
    const definition = structuredClone(source) as any;
    definition.fields[0].children[0].subformWidth = width;
    assert.throws(() => parseSchema(definition), /子字段宽度/);
    const page = structuredClone(split.page) as any;
    page.controls[0].children[0].properties.subformWidth = width;
    assert.throws(() => parsePage(page, split.model), /子字段宽度/);
  }
  for (const width of [undefined, "half", "standard", "double", 1000]) {
    const definition = structuredClone(source) as any;
    definition.fields[0].children[0].subformWidth = width;
    assert.equal(
      parseSchema(definition).fields[0]!.children[0]!.subformWidth,
      width,
    );
  }
});
