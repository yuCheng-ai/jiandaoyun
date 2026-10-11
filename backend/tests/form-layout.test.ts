import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchema } from "../src/schema";
import { schema, field } from "./helpers";
test("definition schemas round-trip device layouts and reject invalid optional presentation metadata", () => {
  const input = schema(field("name"));
  const settings = {
    ...input.settings,
    layout: 4,
    labelPosition: "left",
    labelWidth: 500,
    labelAlignment: "right",
    descriptionMode: "popover",
    inputWidth: "auto",
    mobileLayout: {
      labelPosition: "left",
      labelWidth: 120,
      labelAlignment: "left",
      descriptionMode: "show",
    },
  };
  assert.deepEqual(parseSchema({ ...input, settings }).settings, settings);
  for (const changes of [
    { inputWidth: "wide" },
    { labelAlignment: "center" },
    { descriptionMode: "none" },
    { mobileLayout: null },
    { mobileLayout: [] },
    { mobileLayout: { ...settings.mobileLayout, labelWidth: 501 } },
  ]) {
    assert.throws(
      () => parseSchema({ ...input, settings: { ...settings, ...changes } }),
      /布局/,
    );
  }
  assert.deepEqual(parseSchema(input).settings, input.settings);
});
