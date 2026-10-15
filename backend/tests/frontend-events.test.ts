import { test } from "node:test";
import assert from "node:assert/strict";
import {
  separateFormSchema,
  frontendEventSettingsErrors,
  type FrontendEvent,
} from "@platform/contracts";
import { parseSchema } from "../src/modules/records/record-schema";
import { parsePage } from "../src/modules/pages/page-schema";
import { field, schema } from "./helpers";

test("unconnected frontend events are rejected by both server definition and page paths, retaining source objects", () => {
  const source = parseSchema(schema(field("qty", "number")));
  const original = structuredClone(source);
  const split = separateFormSchema(source);
  const request: FrontendEvent = {
    id: "event_request",
    name: "请求回填",
    description: "",
    enabled: true,
    trigger: "field",
    fieldIds: ["qty"],
    request: {
      method: "POST",
      url: { source: "constant", value: "https://example.com/api" },
      headers: [],
      bodyFormat: "json",
      body: [],
      responseFormat: "json",
      outputs: [
        { fieldId: "qty", path: { source: "constant", value: "$.quantity" } },
      ],
      subformFill: "merge",
      simulation: { status: 200, response: '{"quantity":3}' },
    },
  };
  assert.deepEqual(
    frontendEventSettingsErrors({
      ...source.settings,
      frontendEvents: [request],
    }),
    [],
  );
  const selection: FrontendEvent = {
    id: "event_selection",
    name: "选择数据填充",
    description: "",
    enabled: true,
    trigger: "field",
    fieldIds: ["choose"],
    selection: {
      formId: "source_form",
      columns: ["source_qty"],
      filters: [],
      match: "all",
      sort: { fieldId: "$createdAt", direction: "asc" },
      subformFill: "replace",
      mappings: [{ sourceFieldId: "source_qty", targetFieldId: "qty" }],
    },
  };
  assert.deepEqual(
    frontendEventSettingsErrors({
      ...source.settings,
      frontendEvents: [selection],
    }),
    [],
  );
  for (const events of [
    null,
    {},
    [{ id: "event_demo", enabled: false }],
    [request],
    [selection],
  ]) {
    const definition = {
      ...source,
      settings: { ...source.settings, frontendEvents: events },
    };
    const page = {
      ...split.page,
      settings: { ...split.page.settings, frontendEvents: events },
    };
    assert.throws(() => parseSchema(definition), /暂不支持前端事件/);
    assert.throws(() => parsePage(page, split.model), /暂不支持前端事件/);
  }
  assert.deepEqual(source, original);
  const empty = {
    ...source,
    settings: { ...source.settings, frontendEvents: [] },
  };
  assert.deepEqual(parseSchema(empty).settings.frontendEvents, []);
  const page = {
    ...split.page,
    settings: { ...split.page.settings, frontendEvents: [] },
  };
  assert.deepEqual(parsePage(page, split.model).settings.frontendEvents, []);
});
