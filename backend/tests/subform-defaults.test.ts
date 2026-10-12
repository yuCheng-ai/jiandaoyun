import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchema } from "../src/core/database/schema";
import { field, schema } from "./helpers";
test("native schemas explicitly reject unsupported whole-subform defaults instead of dropping their rules", () => {
  for (const defaultRows of [[], [{ code: "SYN-DEFAULT" }], {}, null])
    assert.throws(
      () =>
        parseSchema(
          schema(
            field("lines", "subform", {
              children: [field("code", "text")],
              defaultRows,
            }),
          ),
        ),
      /暂未接通/,
    );
  assert.throws(
    () =>
      parseSchema(
        schema(
          field("lines", "subform", {
            children: [field("code", "text")],
            defaultLink: {
              enabled: true,
              formId: "source",
              fieldId: "rows",
              filters: [],
              match: "all",
              mappings: [{ sourceFieldId: "remote", targetFieldId: "code" }],
            },
          }),
        ),
      ),
    /暂未接通/,
  );
  assert.doesNotThrow(() =>
    parseSchema(
      schema(field("lines", "subform", { children: [field("code", "text")] })),
    ),
  );
});
