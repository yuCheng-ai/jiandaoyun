import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dateValueAt } from "@platform/contracts";
import { harness, field, schema } from "./helpers";

const h = harness();
const dateField = (id: string, format: string, extra = {}) =>
  field(id, "datetime", { format, dateDefault: "now", ...extra });
const source = schema(
  dateField("month", "month"),
  dateField("day", "date"),
  dateField("minute", "datetime-local"),
  dateField("second", "datetime-second"),
  field("legacy", "datetime", { format: "date", defaultValue: "2020-01-01" }),
  field("name"),
  field("lines", "subform", {
    children: [dateField("lineTime", "datetime-second")],
  }),
);
let definition: any;
before(async () => {
  await h.start();
  definition = await h.definition("日期验收", source);
});
after(() => h.close());

test("current dates resolve at creation and row addition; edits, retries and restart preserve stored dates", async (t) => {
  const clock = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  try {
    const form = await h.request(`/definitions/${definition.id}`);
    assert.equal(
      form.defaultValues.second,
      dateValueAt("datetime-second", new Date(clock)),
    );
    const requestId = randomUUID(),
      body = { requestId, version: 1, values: { name: "原记录", lines: [{}] } };
    const created = await h.request(
      `/definitions/${definition.id}/records`,
      "POST",
      body,
      "admin",
      201,
    );
    const initial = created.record.values.second;
    assert.equal(initial, dateValueAt("datetime-second", new Date(clock)));
    assert.equal(created.record.values.lines[0].lineTime, initial);
    assert.equal(created.record.values.legacy, "2020-01-01");
    t.mock.timers.tick(5000);
    assert.equal(
      (
        await h.request(
          `/definitions/${definition.id}/records`,
          "POST",
          body,
          "admin",
          201,
        )
      ).record.values.second,
      initial,
    );
    const edited = await h.request(`/records/${created.record.id}`, "PATCH", {
      requestId: randomUUID(),
      changes: [{ fieldId: "name", value: "修改文本", expectedRevision: 1 }],
      rows: [
        { action: "add", subformId: "lines", expectedRevision: 1, values: {} },
      ],
    });
    assert.equal(edited.record.values.second, initial);
    assert.equal(edited.record.values.lines[0].lineTime, initial);
    assert.equal(
      edited.record.values.lines[1].lineTime,
      dateValueAt("datetime-second", new Date(clock + 5000)),
    );
    await h.restart();
    assert.deepEqual(
      (await h.request(`/records/${created.record.id}`)).record.values,
      edited.record.values,
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("invalid dates reject entire writes and zero seconds are normalized without moving civil time", async () => {
  const count = (await h.request(`/definitions/${definition.id}/records`))
    .length;
  for (const values of [
    { month: "2024-13" },
    { day: "2023-02-29" },
    { minute: "2024-02-29T24:00" },
    { second: "2024-02-29T12:13:60" },
    { lines: [{ lineTime: "2024-04-31T12:13:14" }] },
  ]) {
    const result = await h.request(
      `/definitions/${definition.id}/records`,
      "POST",
      { requestId: randomUUID(), version: 1, values },
      "admin",
      400,
    );
    assert.match(result.message, /日期或时间不合法/);
  }
  assert.equal(
    (await h.request(`/definitions/${definition.id}/records`)).length,
    count,
  );
  const record = await h.record(definition.id, {
    second: "2024-02-29T12:13",
    day: "2024-02-29",
  });
  assert.equal(record.record.values.second, "2024-02-29T12:13:00");
  assert.equal(record.record.values.day, "2024-02-29");
});

test("invalid date modes, formats and cached default types cannot be stored", async () => {
  const count = (await h.request("/definitions")).length;
  for (const extra of [
    { format: "week" },
    { dateDefault: "formula" },
    { dateDefault: "custom", defaultValue: "2023-02-29" },
    { defaultValue: { malformed: true } },
  ]) {
    await h.request(
      "/definitions",
      "POST",
      { title: "非法日期配置", schema: schema(dateField("d", "date", extra)) },
      "admin",
      400,
    );
  }
  await h.request(
    "/definitions",
    "POST",
    {
      title: "非法字段默认来源",
      schema: schema(field("text", "text", { dateDefault: "now" })),
    },
    "admin",
    400,
  );
  assert.equal((await h.request("/definitions")).length, count);
});

test("time advancing between upgrade preview and confirmation does not invalidate organization defaults or rewrite historical values", async (t) => {
  const clock = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  try {
    const original = await h.definition(
      "时间与人员升级",
      schema(field("name"), dateField("original", "datetime-second")),
    );
    const record = await h.record(original.id, { name: "原值" });
    const page = (await h.request(`/pages?definitionId=${original.id}`))[0];
    const owner = field("owner", "member", {
      organization: {
        scope: {
          mode: "all",
          departmentIds: [],
          roleIds: [],
          employeeIds: [],
          includeChildren: true,
          fieldId: "",
        },
        defaultMode: "currentUser",
        defaultIds: [],
      },
    });
    const next = schema(
      field("name"),
      dateField("original", "datetime-second"),
      dateField("added", "datetime-second"),
      owner,
    );
    await h.request(`/definitions/${original.id}`, "PUT", {
      title: "时间与人员升级",
      expectedRevision: 2,
      schema: next,
    });
    const preview = await h.request(
      `/definitions/${original.id}/publish-preview`,
      "POST",
      { expectedRevision: 3 },
      "admin",
      201,
    );
    await h.request(
      `/definitions/${original.id}/publish`,
      "POST",
      { expectedRevision: 3, impactToken: preview.token },
      "admin",
      201,
    );
    const path = `/pages/${page.id}/records/${record.record.id}/upgrade`;
    const plan = await h.request(`${path}?version=2`);
    assert.equal(plan.allowed, true);
    t.mock.timers.tick(5000);
    const freshPlan = await h.request(`${path}?version=2`);
    assert.equal(plan.defaultsToken, freshPlan.defaultsToken);
    const upgraded = await h.request(
      path,
      "POST",
      {
        pageVersion: 2,
        requestId: randomUUID(),
        expectedRevision: 1,
        defaultsToken: plan.defaultsToken,
      },
      "admin",
      201,
    );
    assert.equal(
      upgraded.record.values.added,
      dateValueAt("datetime-second", new Date(clock + 5000)),
    );
    assert.equal(
      upgraded.record.values.original,
      record.record.values.original,
    );
    assert.equal(upgraded.record.values.name, "原值");
    const admin = (await h.request("/users")).find(
      (user: any) => user.username === "admin",
    );
    assert.equal(upgraded.record.values.owner, admin.id);
  } finally {
    t.mock.timers.reset();
  }
});
