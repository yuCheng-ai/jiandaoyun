import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel, type FormField } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
import { scalar } from "../src/field-values";
import { relationFields, matchesRelation } from "../src/relation-rules";
const h = harness();
const options = [{ id: "pass", label: "合格" }, { id: "hold", label: "待复核" }];
const choice = (id: string, type = "select", extra = {}) => field(id, type, { options, choiceSource: { mode: "manual", formId: "", labelFieldId: "", valueFieldId: "", filters: [], sort: "none", deduplicate: true }, ...extra });
const source = schema(field("date", "datetime", { format: "date" }), field("time", "datetime", { format: "datetime-local" }), choice("status"), choice("checks", "multiselect"), field("phone", "phone"), field("email", "text", { format: "email" }), field("lines", "subform", { children: [choice("result", "radio"), choice("flags", "checkbox")] }));
let definition: any, page: any, record: any;
before(async () => { await h.start(); definition = await h.definition("日期选项协作", source); const pages = await h.request(`/pages?definitionId=${definition.id}`); page = pages[0]; });
after(() => h.close());
const values = () => ({ date: "2028-02-29", time: "2026-10-09T08:30", status: "pass", checks: ["hold", "pass"], phone: "13800000000", email: "example@example.test", lines: [{ result: "hold", flags: ["pass"] }] });

test("legacy field and option identities survive separation, page reuse, record persistence and restart", async () => {
  const published = await h.request(`/pages/${page.id}`);
  assert.equal(published.model.fields.find((f: any) => f.id === "status").kind, "choice");
  assert.deepEqual(published.model.fields.find((f: any) => f.id === "checks").settings.options, options);
  const alternative = pageForModel(published.model); alternative.controls.find(c => c.binding?.fieldId === "status")!.type = "radio";
  let reused = await h.request("/pages", "POST", { title: "同字段另一控件", definitionId: definition.id, definitionVersion: 1, schema: alternative }, "admin", 201);
  reused = await h.request(`/pages/${reused.id}/publish`, "POST", { expectedRevision: reused.revision }, "admin", 201);
  record = await h.record(definition.id, values());
  assert.deepEqual(record.record.values.checks, ["hold", "pass"]);
  assert.deepEqual(record.record.values.lines[0].flags, ["pass"]);
  const other = await h.request(`/pages/${reused.id}/records/${record.record.id}`);
  assert.deepEqual(other.record.values, record.record.values);
  await h.restart();
  assert.deepEqual((await h.request(`/records/${record.record.id}`)).record, record.record);
});

test("definition validation rejects malformed options, dynamic sources and unsupported date formats without creating objects", async () => {
  const before = (await h.request("/definitions")).length;
  const bad: any[] = [choice("x", "select", { options: [] }), choice("x", "select", { options: [options[0], options[0]] }), choice("x", "select", { options: [{ id: "__proto__", label: "bad" }] }), choice("x", "select", { choiceSource: { mode: "form" } }), choice("x", "select", { defaultValue: "unknown" }), field("date", "datetime", { format: "unknown" }), field("email", "text", { format: "script" })];
  for (const item of bad) {
    const saved = await h.request("/definitions", "POST", { title: "非法配置", schema: schema(item) }, "admin", 400);
  }
  assert.equal((await h.request("/definitions")).length, before);
});

test("server rejects impossible dates, timezones, bad option shapes and invalid contact formats atomically", async () => {
  const count = (await h.request(`/definitions/${definition.id}/records`)).length;
  const bad = [{ date: "2026-02-29" }, { date: "1900-02-29" }, { date: "0000-01-01" }, { date: "2026-04-31" }, { time: "2026-10-09T24:00" }, { time: "2026-10-09T08:30Z" }, { status: "合格" }, { status: ["pass"] }, { checks: "pass" }, { checks: ["pass", "pass"] }, { checks: ["unknown"] }, { phone: "123" }, { email: "not-an-email" }, { lines: [{ result: "invalid", flags: [] }] }];
  for (const patch of bad) await h.request(`/pages/${page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, values: { ...values(), ...patch } }, "admin", 400);
  assert.equal((await h.request(`/definitions/${definition.id}/records`)).length, count);
  assert.equal(scalar(source.fields[0] as unknown as FormField, "2000-02-29"), "2000-02-29");
  assert.throws(() => scalar({ ...source.fields[3], required: true } as unknown as FormField, []), /不能为空/);
});

test("new types honor hidden fields and readonly subform columns; stale array edits conflict without partial writes", async () => {
  const users = await h.request("/users"), editor = users.find((u: any) => u.username === "editor");
  await h.request(`/definitions/${definition.id}/grants`, "PUT", { userId: editor.id, read: true, create: true, edit: true, scope: "all", fields: { date: "edit", time: "read", status: "edit", checks: "edit", phone: "hidden", email: "hidden", lines: "edit", result: "read", flags: "edit" } });
  const path = `/pages/${page.id}/records/${record.record.id}`, detail = await h.request(path, "GET", undefined, "editor");
  assert.equal(detail.record.values.phone, undefined); assert.equal(detail.record.cellRevisions.phone, undefined);
  const rowId = detail.record.values.lines[0]._rowId;
  await h.request(path, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes: [{ fieldId: "result", subformId: "lines", rowId, value: "pass", expectedRevision: 1 }] }, "editor", 403);
  const command = { pageVersion: 1, requestId: randomUUID(), changes: [{ fieldId: "checks", value: ["pass"], expectedRevision: 1 }] };
  await h.request(path, "PATCH", command, "editor"); await h.request(path, "PATCH", command, "editor");
  await h.request(path, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes: [{ fieldId: "date", value: "2026-10-10", expectedRevision: 1 }, { fieldId: "checks", value: ["hold"], expectedRevision: 1 }] }, "editor", 409);
  const after = await h.request(path); assert.equal(after.record.values.date, "2028-02-29"); assert.deepEqual(after.record.values.checks, ["pass"]);
});

test("option changes report incompatible records but retain old published labels and stored IDs", async () => {
  let draft = await h.request(`/data-objects/${definition.id}/draft`);
  const status = draft.model.fields.find((f: any) => f.id === "status"); status.settings.options = [{ id: "hold", label: "等待复核" }];
  draft = await h.request(`/data-objects/${definition.id}`, "PUT", { ...draft, expectedRevision: draft.revision });
  const impact = await h.request(`/data-objects/${definition.id}/publish-preview`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  assert.equal(impact.records[0].incompatible, 1); assert.ok(impact.changes.changed[0].details.some((text: string) => text.startsWith("选项：")));
  assert.ok(impact.changes.changed[0].details.includes("选项：合格、待复核 → 等待复核"));
  await h.request(`/data-objects/${definition.id}/publish`, "POST", { expectedRevision: draft.revision, impactToken: impact.token }, "admin", 201);
  const old = await h.request(`/pages/${page.id}/records/${record.record.id}`);
  assert.equal(old.record.definitionVersion, 1); assert.equal(old.record.values.status, "pass"); assert.equal(old.definition.schema.fields.find((f: any) => f.id === "status").options[0].label, "合格");
  await h.record(definition.id, { ...values(), status: "hold" }, "admin", 2);
});

test("relation mappings require compatible date formats and choice identities; multi-choice filters use exact option membership", () => {
  const base = { title: "关系", sourceDefinitionId: "source", targetDefinitionId: "target", cardinality: "one", inverseCardinality: "many", valueMode: "live", labelFieldId: "x", columns: [], filters: [], mappings: [{ fromTargetFieldId: "x", toSourceFieldId: "y" }] } as any;
  const form = (f: any) => schema(f) as any;
  assert.throws(() => relationFields(base, form(choice("y", "select", { options: [{ id: "other", label: "合格" }] })), form(choice("x"))), /不兼容/);
  assert.throws(() => relationFields(base, form(field("y", "datetime", { format: "date" })), form(field("x", "datetime", { format: "datetime-local" }))), /不兼容/);
  const relation = { ...base, filters: [{ id: "f", sourceFieldId: "x", operator: "contains", source: "constant", value: "pass" }] };
  assert.equal(matchesRelation(relation, {}, { x: ["bypass"] }), false);
  assert.equal(matchesRelation(relation, {}, { x: ["hold", "pass"] }), true);
});

test("multi-choice wait conditions compare sets and reject unavailable options before starting tasks", async () => {
  const users = await h.request("/users"), admin = users.find((u: any) => u.username === "admin");
  const waiting = await h.record(definition.id, values());
  const task = { id: "check", title: "核对", recordBinding: "main", assigneeId: admin.id, pageId: page.id, pageVersion: 1, dependsOn: [], requiredFields: [], waitFor: { recordBinding: "main", fieldId: "checks", equals: ["pass", "hold"] } };
  const bindings = { main: waiting.record.id };
  await h.request("/processes", "POST", { requestId: randomUUID(), spec: { title: "非法等待", tasks: [{ ...task, waitFor: { ...task.waitFor, equals: ["missing"] } }] }, bindings }, "admin", 400);
  const started = await h.request("/processes", "POST", { requestId: randomUUID(), spec: { title: "选项等待", tasks: [task] }, bindings }, "admin", 201);
  assert.equal(started.tasks[0].status, "ready");
});

test("relation previews and saved links display option labels while mapping the original IDs", async () => {
  const source = await h.definition("选项来源", schema(choice("result"))), target = await h.definition("选项目标", schema(choice("result")));
  const origin = await h.record(source.id, { result: "hold" }), destination = await h.record(target.id, { result: "pass" });
  const relation = await h.relation({ title: "选项关系", sourceDefinitionId: source.id, targetDefinitionId: target.id, cardinality: "one", inverseCardinality: "many", valueMode: "snapshot", labelFieldId: "result", columns: ["result"], filters: [], mappings: [{ fromTargetFieldId: "result", toSourceFieldId: "result" }] });
  const path = `/records/${origin.record.id}/relations/${relation.id}`;
  const candidates = await h.request(`${path}/candidates?q=${encodeURIComponent('合格')}`);
  assert.equal(candidates.items[0].label, "合格"); assert.equal(candidates.items[0].values.result, "pass"); assert.equal(candidates.items[0].displayValues.result, "合格");
  assert.equal(candidates.items[0].mappings[0].beforeLabel, "待复核");
  await h.request(`${path}/links`, "POST", { requestId: randomUUID(), targetRecordId: destination.record.id, expectedTargetRevision: destination.record.revision, expectedRelationVersion: relation.latestVersion, expectedCells: origin.record.cellRevisions }, "admin", 201);
  const groups = await h.request(`/records/${origin.record.id}/relations`);
  assert.equal(groups[0].links[0].displayValues.result, "合格");
  assert.equal((await h.request(`/records/${origin.record.id}`)).record.values.result, "pass");
});
