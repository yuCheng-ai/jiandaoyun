import { test } from "node:test";
import assert from "node:assert/strict";
import { separateFormSchema, composeFormSchema } from "@platform/contracts";
import { parseSchema } from "../src/modules/records/record-schema";
import { parsePage } from "../src/modules/pages/page-schema";
import { field, schema } from "./helpers";

test("mobile presentation remains page-only, with summary bindings independent of control IDs", () => {
  const source: any = schema(
    field("lines", "subform", {
      children: [field("item", "text")],
      subformMobile: {
        layout: "vertical",
        summary: "custom",
        fieldIds: ["item"],
      },
    }),
  );
  assert.deepEqual(
    parseSchema(source).fields[0]!.subformMobile,
    source.fields[0].subformMobile,
  );
  const split = separateFormSchema(source);
  assert.equal(Object.hasOwn(split.model.fields[0]!, "subformMobile"), false);
  split.page.controls[0]!.children[0]!.id = "item-control";
  const page = parsePage(split.page, split.model);
  assert.deepEqual(
    composeFormSchema(split.model, page).fields[0]!.subformMobile,
    source.fields[0].subformMobile,
  );
});
test("native parsers reject malformed mobile metadata and invalid summary references", () => {
  const source: any = schema(
    field("lines", "subform", { children: [field("item", "text")] }),
  );
  const split = separateFormSchema(source);
  for (const invalid of [
    true,
    [],
    { layout: "bad", summary: "first", fieldIds: [] },
    { layout: "vertical", summary: "custom", fieldIds: ["missing"] },
    { layout: "vertical", summary: "first", fieldIds: ["a", "b", "c", "d"] },
    { layout: "table", summary: "custom", fieldIds: ["item", "item"] },
  ]) {
    source.fields[0].subformMobile = invalid;
    (split.page.controls[0]!.properties as any).subformMobile = invalid;
    assert.throws(() => parseSchema(source), /简报/);
    assert.throws(() => parsePage(split.page, split.model), /简报/);
  }
});
