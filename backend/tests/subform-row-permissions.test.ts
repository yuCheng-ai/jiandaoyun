import { test } from "node:test";
import assert from "node:assert/strict";
import { separateFormSchema, composeFormSchema, newSubformPermissions, type FormSchema } from "@platform/contracts";
import { parseSchema } from "../src/modules/records/record-schema";
import { parsePage } from "../src/modules/pages/page-schema";
import { field, schema } from "./helpers";
test("page conversion and native parsers retain row restrictions for server enforcement", () => {
  const source: any = schema(
    field("lines", "subform", {
      children: [field("item", "text")],
      subformPermissions: { ...newSubformPermissions(), editExisting: false },
    }),
  );
  const split = separateFormSchema(source);
  assert.deepEqual(
    composeFormSchema(split.model, split.page).fields[0]!.subformPermissions,
    source.fields[0]!.subformPermissions,
  );
  assert.deepEqual(parseSchema(source).fields[0]!.subformPermissions, source.fields[0]!.subformPermissions);
  assert.deepEqual(parsePage(split.page, split.model).controls[0]!.properties.subformPermissions, source.fields[0]!.subformPermissions);
});
test("native parsers keep unrestricted and legacy definitions but reject malformed row permissions", () => {
  const source: any = schema(
    field("lines", "subform", {
      children: [field("item", "text")],
      subformPermissions: newSubformPermissions(),
    }),
  );
  assert.deepEqual(
    parseSchema(source).fields[0]!.subformPermissions,
    newSubformPermissions(),
  );
  const split = separateFormSchema(source);
  assert.deepEqual(
    parsePage(split.page, split.model).controls[0]!.properties
      .subformPermissions,
    newSubformPermissions(),
  );
  (source.fields[0] as any).subformPermissions.insert = "false";
  assert.throws(() => parseSchema(source), /操作权限格式/);
  (split.page.controls[0] as any).properties.subformPermissions.insert =
    "false";
  assert.throws(() => parsePage(split.page, split.model), /操作权限格式/);
  delete source.fields[0]!.subformPermissions;
  assert.equal(parseSchema(source).fields[0]!.subformPermissions, undefined);
});
