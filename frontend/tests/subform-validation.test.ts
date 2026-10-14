// @vitest-environment jsdom
// @vitest-environment jsdom
import { expect, it } from "vitest";

import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  validateValues,
  type FormValues,
} from "../src/domain/form";

function fixture() {
  const schema = emptySchema();
  const code = createField("text", {
    id: "code",
    label: "明细编号",
    required: true,
    unique: true,
  });
  const quantity = createField("number", { id: "quantity", label: "数量" });
  const rows = createField("subform", {
    id: "lines",
    label: "明细",
    children: [code, quantity],
  });
  schema.fields = [rows];
  return { schema, code, quantity, rows };
}

it("skips required child checks for wholly blank optional rows, ignoring metadata and decorations", () => {
  const { schema, rows } = fixture();
  rows.children.push(
    createField("divider", { id: "section" }),
    createField("button", { id: "action" }),
    createField("richtext", { id: "note" }),
    createField("address", { id: "address" }),
    createField("file", { id: "files" }),
  );
  const values = {
    lines: [
      {},
      {
        _rowId: "kept",
        removedField: "legacy",
        section: "title",
        action: "clicked",
      },
      {
        code: "  ",
        note: "<p><br>&nbsp;</p>",
        address: { province: "" },
        files: [],
      },
    ],
  };
  const before = copy(values);
  expect(validateValues(schema, values)).toEqual([]);
  expect(values).toEqual(before);
});

it("requires at least one populated row; zero activates child required checks at the original index", () => {
  const { schema, rows } = fixture();
  rows.required = true;
  expect(validateValues(schema, { lines: [{}, { code: "" }] })).toEqual([
    { fieldId: "lines", path: "lines", message: "请填写明细" },
  ]);
  expect(validateValues(schema, { lines: [{}, { quantity: 0 }] })).toEqual([
    { fieldId: "code", path: "lines.1.code", message: "请填写明细编号" },
  ]);
  expect(
    validateValues(schema, { lines: [{}, { code: "A", quantity: 0 }] }),
  ).toEqual([]);
});

it("retains hidden stored values as row content but applies child visibility rules independently", () => {
  const { schema, quantity, code } = fixture();
  quantity.visible = false;
  expect(validateValues(schema, { lines: [{ quantity: 0 }] })[0]?.path).toBe(
    "lines.0.code",
  );
  code.visible = false;
  expect(validateValues(schema, { lines: [{ quantity: 0 }] })).toEqual([]);
  code.visible = true;
  schema.settings.rules = [
    {
      id: "show",
      sourceId: "quantity",
      operator: "equals",
      value: "1",
      targetIds: ["code"],
    },
  ];
  expect(
    validateValues(schema, { lines: [{ quantity: 0 }, { quantity: 1 }] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.1.code"]);
});

it("compares unique child values with every peer record row without confusing main fields or another subform", () => {
  const { schema } = fixture();
  const existing: FormValues[] = [
    { lines: [{ code: "A" }, { code: "B" }] },
    { lines: [{ code: "C" }] },
    { code: "D", otherLines: [{ code: "D" }] },
  ];
  expect(
    validateValues(schema, { lines: [{}, { code: "C" }] }, existing),
  ).toEqual([
    { fieldId: "code", path: "lines.1.code", message: "明细编号不能重复" },
  ]);
  expect(validateValues(schema, { lines: [{ code: "D" }] }, existing)).toEqual(
    [],
  );
});

it("a child global-unique setting also rejects repeated rows in one record while optional blanks remain exempt", () => {
  const { schema, code } = fixture();
  expect(
    validateValues(schema, { lines: [{ code: "A" }, {}, { code: "A" }] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.0.code", "lines.2.code"]);
  code.unique = false;
  expect(
    validateValues(schema, { lines: [{ code: "A" }, { code: "A" }] }),
  ).toEqual([]);
});

it("tab containers retain main scope and nested row paths without mutating schemas or historical values", () => {
  const { schema, rows } = fixture();
  const title = createField("text", { id: "title", unique: true });
  const tabs = createField("tabs", { id: "tabs", children: [title, rows] });
  title.tabId = rows.tabId = tabs.tabs[0]!.id;
  schema.fields = [tabs];
  const restored = parseSchema(copy(schema));
  const existing = [{ title: "old", lines: [{ code: "A" }] }];
  const before = copy({ restored, existing });
  expect(
    validateValues(
      restored,
      { title: "old", lines: [{ code: "A" }] },
      existing,
    ).map((error) => error.path),
  ).toEqual(["title", "lines.0.code"]);
  expect({ restored, existing }).toEqual(before);
});

it("malformed subforms and non-object rows fail validation instead of throwing or being counted as blank", () => {
  const { schema } = fixture();
  expect(validateValues(schema, { lines: "broken" })).toEqual([
    { fieldId: "lines", path: "lines", message: "明细的明细格式无效" },
  ]);
  expect(
    validateValues(schema, { lines: [null, "bad", []] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.0", "lines.1", "lines.2"]);
});
