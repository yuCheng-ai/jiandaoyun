import { test } from "node:test";
import assert from "node:assert/strict";
import { separateFormSchema, composeFormSchema } from "@platform/contracts";
import { parseSchema } from "../src/schema";
import { parsePage } from "../src/page-schema";
import { field, schema } from "./helpers";

test("quick filling survives page projection and native parsers explicitly reject enabled execution", () => {
  const source: any = schema(
    field("lines", "subform", {
      children: [field("item", "text")],
      subformQuickFill: true,
    }),
  );
  const split = separateFormSchema(source);
  assert.equal(
    composeFormSchema(split.model, split.page).fields[0]!.subformQuickFill,
    true,
  );
  assert.throws(() => parseSchema(source), /快速填报暂未接通服务端/);
  assert.throws(
    () => parsePage(split.page, split.model),
    /快速填报暂未接通服务端/,
  );
});
test("disabled and legacy quick-fill definitions remain readable while malformed settings are rejected", () => {
  const source: any = schema(
    field("lines", "subform", {
      children: [field("item", "text")],
      subformQuickFill: false,
    }),
  );
  assert.doesNotThrow(() => parseSchema(source));
  const split = separateFormSchema(source);
  assert.equal(
    parsePage(split.page, split.model).controls[0]!.properties.subformQuickFill,
    false,
  );
  source.fields[0].subformQuickFill = "false";
  assert.throws(() => parseSchema(source), /快速填报配置无效/);
  (split.page.controls[0]!.properties as any).subformQuickFill = "false";
  assert.throws(() => parsePage(split.page, split.model), /快速填报配置无效/);
  delete source.fields[0].subformQuickFill;
  assert.doesNotThrow(() => parseSchema(source));
});
