import { test } from "node:test";
import assert from "node:assert/strict";
import { composeFormSchema, separateFormSchema } from "@platform/contracts";
import { parseSchema } from "../src/modules/records/record-schema";
import { parsePage } from "../src/modules/pages/page-schema";
import { field, schema } from "./helpers";

test("fixed columns remain page-only metadata through native schema and page parsing", () => {
  const source: any = schema(
    field("lines", "subform", {
      children: [field("item", "text")],
      subformFixedColumns: { desktop: 1, mobile: 0 },
    }),
  );
  assert.deepEqual(parseSchema(source).fields[0]!.subformFixedColumns, {
    desktop: 1,
    mobile: 0,
  });
  const split = separateFormSchema(source);
  assert.equal(
    Object.hasOwn(split.model.fields[0]!, "subformFixedColumns"),
    false,
  );
  const page = parsePage(split.page, split.model);
  assert.deepEqual(
    composeFormSchema(split.model, page).fields[0]!.subformFixedColumns,
    { desktop: 1, mobile: 0 },
  );
});
test("both native parsers reject malformed display settings instead of dropping them", () => {
  const source: any = schema(
    field("lines", "subform", { children: [field("item", "text")] }),
  );
  const split = separateFormSchema(source);
  for (const invalid of [
    true,
    [],
    { desktop: 1 },
    { desktop: 301, mobile: 0 },
    { desktop: -1, mobile: 0 },
    { desktop: 0, mobile: 1.5 },
    { desktop: 0, mobile: 0, extra: true },
  ]) {
    source.fields[0].subformFixedColumns = invalid;
    (split.page.controls[0]!.properties as any).subformFixedColumns = invalid;
    assert.throws(() => parseSchema(source), /固定列/);
    assert.throws(() => parsePage(split.page, split.model), /固定列/);
  }
});
