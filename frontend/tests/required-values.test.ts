import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createField, emptySchema, validateValues } from "../src/domain/form";
import { validateDynamicValues } from "../src/domain/fieldValidation";


it("validates ordinary text literally, including angle brackets and entity spelling", () => {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "code", required: true }),
    createField("textarea", { id: "note", required: true }),
  ];
  expect(validateValues(schema, { code: "<待补充>", note: "&nbsp;" })).toEqual(
    [],
  );
  expect(
    validateValues(schema, { code: "   ", note: "\n" }).map(
      (error) => error.path,
    ),
  ).toEqual(["code", "note"]);
});

it("requires rendered rich content, allowing safe image-only values and rejecting empty or removed markup", () => {
  const schema = emptySchema();
  schema.fields = [createField("richtext", { id: "note", required: true })];
  for (const note of [
    "<p><br>&nbsp;&#160;&#xA0;</p>",
    "<!-- empty -->",
    '<img src="javascript:alert(1)">',
    "<script>hidden</script><style>hidden</style>",
  ])
    expect(validateValues(schema, { note }), note).toHaveLength(1);
  for (const note of [
    '<p><img src="https://example.com/receipt.png"></p>',
    "<p>&lt;待补充&gt;</p>",
  ])
    expect(validateValues(schema, { note }), note).toEqual([]);
});

it("image-only and literal-text subform rows activate child required checks at the original row index", () => {
  const schema = emptySchema();
  schema.fields = [
    createField("subform", {
      id: "lines",
      children: [
        createField("text", { id: "code", required: true }),
        createField("richtext", { id: "note" }),
      ],
    }),
  ];
  expect(
    validateValues(schema, {
      lines: [
        { note: "<p>&#160;</p>" },
        { note: '<img src="https://example.com/proof.png">' },
      ],
    }).map((error) => error.path),
  ).toEqual(["lines.1.code"]);
  expect(validateValues(schema, { lines: [{ code: "<待补充>" }] })).toEqual([]);
});

it("keeps zero, empty address/files, malformed files and readonly required constraints distinct", () => {
  const schema = emptySchema();
  schema.fields = [
    createField("number", { id: "quantity", required: true }),
    createField("address", { id: "address", required: true }),
    createField("file", { id: "files", required: true }),
    createField("text", { id: "reference", required: true, editable: false }),
  ];
  expect(
    validateValues(schema, {
      quantity: 0,
      address: { province: "", city: "", district: "", detail: "" },
      files: [],
      reference: "",
    }).map((error) => error.path),
  ).toEqual(["address", "files", "reference"]);
  expect(
    validateValues(schema, {
      quantity: 0,
      files: [{}],
      reference: "REF-001",
    }).map((error) => error.path),
  ).toEqual(["address", "files"]);
});

it("skips dynamic validation inside hidden containers and applies it again when revealed", () => {
  const schema = emptySchema();
  const tabs = createField("tabs", {
    id: "group",
    visible: false,
    children: [
      createField("select", {
        id: "choice",
        required: true,
        options: [{ id: "valid", label: "有效" }],
      }),
    ],
  });
  schema.fields = [tabs];
  const data = seedWorkspace();
  expect(validateValues(schema, { choice: "removed" })).toEqual([]);
  expect(validateDynamicValues(schema, { choice: "removed" }, data)).toEqual(
    [],
  );
  tabs.visible = true;
  expect(
    validateDynamicValues(schema, { choice: "removed" }, data).map(
      (error) => error.path,
    ),
  ).toEqual(["choice"]);
  tabs.editable = false;
  expect(
    validateDynamicValues(schema, { choice: "removed" }, data, true),
  ).toEqual([]);
});

it("dynamic visibility of a container controls main and subform descendants together", () => {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "show" }),
    createField("tabs", {
      id: "group",
      children: [
        createField("subform", {
          id: "lines",
          children: [
            createField("select", {
              id: "choice",
              options: [{ id: "valid", label: "有效" }],
            }),
          ],
        }),
      ],
    }),
  ];
  schema.settings.rules = [
    {
      id: "rule",
      sourceId: "show",
      operator: "equals",
      value: "yes",
      targetIds: ["group"],
    },
  ];
  const data = seedWorkspace();
  const lines = [{ choice: "removed" }];
  expect(validateDynamicValues(schema, { show: "no", lines }, data)).toEqual(
    [],
  );
  expect(
    validateDynamicValues(schema, { show: "yes", lines }, data).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.0.choice"]);
});

it("malformed rows produce validation errors without crashing the following dynamic checks", () => {
  const schema = emptySchema();
  schema.fields = [
    createField("subform", {
      id: "lines",
      children: [createField("select", { id: "choice" })],
    }),
  ];
  const values = { lines: [null, [], "invalid"] };
  expect(validateValues(schema, values).map((error) => error.path)).toEqual([
    "lines.0",
    "lines.1",
    "lines.2",
  ]);
  expect(validateDynamicValues(schema, values, seedWorkspace())).toEqual([]);
});
