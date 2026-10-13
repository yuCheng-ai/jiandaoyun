// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";

import { createPinia } from "pinia";
import { composeFormSchema, separateFormSchema } from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  fieldRegistry,
  parseSchema,
  validateValues,
  type FormField,
} from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(seedWorkspace()));
});
function fixture() {
  const code = createField("text", {
    id: "code",
    label: "明细编号",
    uniqueInRecord: true,
    duplicateMessage: "明细编号不能重复录入",
  });
  const rows = createField("subform", { id: "lines", children: [code] });
  const schema = emptySchema();
  schema.fields = [rows];
  return { code, rows, schema };
}

it("checks duplicate rows within one record, exempts blank rows and permits the same value in another record", () => {
  const { schema } = fixture();
  const values = { lines: [{}, { code: "A" }, { code: "A" }, { code: "" }] };
  const original = copy(values);
  expect(validateValues(schema, values, [{ lines: [{ code: "A" }] }])).toEqual([
    { fieldId: "code", path: "lines.1.code", message: "明细编号不能重复录入" },
    { fieldId: "code", path: "lines.2.code", message: "明细编号不能重复录入" },
  ]);
  expect(validateValues(schema, { lines: [{ code: "A" }] }, [values])).toEqual(
    [],
  );
  expect(values).toEqual(original);
});

it("global uniqueness includes sibling rows and other records even for old definitions without a within-record flag", () => {
  const { schema, code } = fixture();
  code.unique = true;
  delete code.uniqueInRecord;
  delete code.duplicateMessage;
  expect(
    validateValues(schema, { lines: [{ code: "A" }, { code: "A" }] }),
  ).toHaveLength(2);
  expect(
    validateValues(schema, { lines: [{ code: "B" }] }, [
      { lines: [{ code: "B" }] },
    ]),
  ).toEqual([
    { fieldId: "code", path: "lines.0.code", message: "明细编号不能重复" },
  ]);
  code.duplicateMessage = "  自定义重复提示  ";
  expect(
    validateValues(schema, { lines: [{ code: "B" }] }, [
      { lines: [{ code: "B" }] },
    ])[0]?.message,
  ).toBe("自定义重复提示");
});

it("only the five supported child types gain the new rule; legacy global numeric uniqueness remains valid for zero", () => {
  const supported = ["text", "select", "member", "department", "lookup"];
  expect(
    fieldRegistry
      .filter((item) => item.subformUnique)
      .map((item) => item.type)
      .sort(),
  ).toEqual([...supported].sort());
  for (const type of supported) {
    const { schema, rows } = fixture();
    const child = createField(type as FormField["type"], {
      id: "code",
      uniqueInRecord: true,
    });
    rows.children = [child];
    expect(
      validateValues(schema, {
        lines: [{ code: "id-A" }, { code: "id-A" }],
      }).filter((error) => error.message.includes("不能重复")),
    ).toHaveLength(2);
  }
  const { schema, rows } = fixture();
  const number = createField("number", { id: "n", uniqueInRecord: true });
  rows.children = [number];
  expect(validateValues(schema, { lines: [{ n: 0 }, { n: 0 }] })).toEqual([]);
  number.unique = true;
  expect(validateValues(schema, { lines: [{ n: 0 }, { n: 0 }] })).toHaveLength(
    2,
  );
  schema.fields = [createField("text", { id: "main", uniqueInRecord: true })];
  expect(validateValues(schema, { main: "A" }, [{ main: "A" }])).toEqual([]);
});

it("preserves row paths and scope through tabs and legacy nested subforms", () => {
  const { schema, rows, code } = fixture();
  const tabs = createField("tabs", { id: "tabs", children: [code] });
  rows.children = [tabs];
  expect(
    validateValues(schema, { lines: [{ code: "A" }, { code: "A" }] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.0.code", "lines.1.code"]);
  const parent = createField("subform", { id: "outer", children: [rows] });
  schema.fields = [parent];
  const values = {
    outer: [{ lines: [{ code: "A" }] }, { lines: [{ code: "A" }] }],
  };
  expect(validateValues(schema, values).map((error) => error.path)).toEqual([
    "outer.0.lines.0.code",
    "outer.1.lines.0.code",
  ]);
  expect(
    validateValues(schema, { outer: [{ lines: [{ code: "B" }] }] }, [values]),
  ).toEqual([]);
});

it("round-trips optional rules without changing old schemas and rejects malformed configuration", () => {
  const { schema, code } = fixture();
  expect(parseSchema(schema).fields[0]?.children[0]).toMatchObject({
    uniqueInRecord: true,
    duplicateMessage: "明细编号不能重复录入",
  });
  const split = separateFormSchema(schema);
  expect(split.model.fields[0]?.children[0]?.settings).toMatchObject({
    uniqueInRecord: true,
    duplicateMessage: code.duplicateMessage,
  });
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  delete code.uniqueInRecord;
  delete code.duplicateMessage;
  expect(parseSchema(schema)).toEqual(schema);
  expect(parseSchema(schema).fields[0]?.children[0]).not.toHaveProperty(
    "uniqueInRecord",
  );
  expect(() =>
    parseSchema({ ...schema, fields: [{ ...code, uniqueInRecord: "yes" }] }),
  ).toThrow("单条数据重复校验配置无效");
  expect(() =>
    parseSchema({ ...schema, fields: [{ ...code, duplicateMessage: [] }] }),
  ).toThrow("重复校验提示配置无效");
});

it("pins drafts and record edits to their published rule while retry preserves one record identity", async () => {
  const store = useWorkspaceStore(createPinia());
  const form = (await store.createForm("oa", "合成独立重复校验", "form"))!;
  store.openForm(form.id)!.schema = fixture().schema;
  expect(await store.publishForm(form.id)).toBe(true);
  const published = copy(
    store.data.forms.find((item) => item.id === form.id)!.versions[0],
  );
  const first = (await store.submitEntry(form.id, { lines: [{ code: "A" }] }))!;
  const draft = (await store.submitEntry(
    form.id,
    { lines: [{ code: "A" }, { code: "A" }] },
    "draft",
  ))!;
  store.openForm(form.id)!.schema.fields[0]!.children[0]!.uniqueInRecord =
    false;
  expect(await store.publishForm(form.id)).toBe(true);
  expect(
    await store.submitEntry(
      form.id,
      { lines: [{ code: "A" }, { code: "A" }] },
      "submitted",
      draft.id,
    ),
  ).toBeUndefined();
  expect(store.data.entries.find((item) => item.id === draft.id)?.status).toBe(
    "draft",
  );
  const retry = (await store.submitEntry(
    form.id,
    { lines: [{ code: "A" }, { code: "B" }] },
    "submitted",
    draft.id,
  ))!;
  expect(retry).toMatchObject({
    id: draft.id,
    definitionVersion: 1,
    status: "submitted",
  });
  expect(
    await store.updateEntry(first.id, {
      lines: [{ code: "A" }, { code: "A" }],
    }),
  ).toBe(false);
  expect(
    store.data.entries.filter((item) => item.formId === form.id),
  ).toHaveLength(2);
  expect(
    store.data.forms.find((item) => item.id === form.id)!.versions[0],
  ).toEqual(published);
});
