import { test } from "node:test";
import assert from "node:assert/strict";
import { separateFormSchema, type FormSchema } from "@platform/contracts";
import { parseSchema } from "../src/schema";
import { parseModel, parsePage } from "../src/page-schema";
import { schema, field } from "./helpers";

const rule = { id: "check", expression: "{{amount}} <= 100", message: "超过预算", mode: "block", realtime: true };
test("within-record duplicate rules survive contract separation and are rejected by the native server until execution is supported", () => {
  const source = parseSchema(schema(field("lines", "subform", { children: [field("code")] })));
  source.fields[0]!.children[0]!.uniqueInRecord = true;
  source.fields[0]!.children[0]!.duplicateMessage = "明细编号不能重复录入";
  assert.throws(() => parseSchema(source), /含暂未接通的规则/);
  const split = separateFormSchema(source);
  assert.equal(split.model.fields[0]?.children[0]?.settings.uniqueInRecord, true);
  assert.equal(split.model.fields[0]?.children[0]?.settings.duplicateMessage, "明细编号不能重复录入");
  assert.throws(() => parseModel(split.model), /含暂未接通的规则/);
  source.fields[0]!.children[0]!.uniqueInRecord = false;
  assert.doesNotThrow(() => parseSchema(source));
  assert.doesNotThrow(() => parseModel(separateFormSchema(source).model));
});
test("unsupported submission conditions are rejected instead of silently accepted by the server definition", () => {
  const source = schema(field("amount", "number"));
  assert.throws(() => parseSchema({ ...source, settings: { rules: [], validations: [rule] } }), /暂不支持表单提交校验/);
  assert.throws(() => parseSchema({ ...source, settings: { rules: [], validations: "invalid" } }), /暂不支持表单提交校验/);
  assert.doesNotThrow(() => parseSchema(source));
  assert.doesNotThrow(() => parseSchema({ ...source, settings: { rules: [], validations: [] } }));
});
test("server pages preserve legacy compatibility and reject conditions both before and after schema separation", () => {
  const parsed = parseSchema(schema(field("amount", "number")));
  const split = separateFormSchema(parsed);
  assert.doesNotThrow(() => parsePage(split.page, split.model));
  const withChecks = separateFormSchema({ ...parsed, settings: { ...parsed.settings, validations: [rule] } } as FormSchema);
  assert.throws(() => parsePage(withChecks.page, withChecks.model), /校验尚未接入服务端/);
  assert.throws(() => parsePage({ ...split.page, settings: { ...split.page.settings, validations: {} } }, split.model), /校验尚未接入服务端/);
});
test("unsupported hidden assignments are retained in contracts and rejected by server definitions and pages", () => {
  const source = schema(field("amount", "number"));
  for (const settings of [{rules:[],hiddenValues:"recalculate"},{rules:[],hiddenValueRules:{amount:"clear"}},{rules:[],hiddenValueRules:[]}])
    assert.throws(() => parseSchema({...source,settings}), /不可见字段赋值规则/);
  const parsed = parseSchema(source), split = separateFormSchema(parsed);
  const withRules = separateFormSchema({...parsed,settings:{...parsed.settings,hiddenValueRules:{amount:"recalculate"}}});
  assert.deepEqual(withRules.page.settings.hiddenValueRules,{amount:"recalculate"});
  assert.throws(() => parsePage(withRules.page,split.model), /特殊字段赋值规则尚未接入服务端/);
  assert.doesNotThrow(() => parsePage({...split.page,settings:{...split.page.settings,hiddenValueRules:{}}},split.model));
});
