import { newAutomation, newAutomationStep } from "../src/domain/automation";
import {
  parsePayment,
  type PaymentResultMapping,
} from "../src/domain/payments";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "../src/stores/workspace";
import { copy, createField } from "../src/domain/form";
import {
  newPayment,
  paymentCents,
  quotePayment,
  orderState,
  paymentIssues,
  parsePaymentOrders,
  type PaymentMerchant,
} from "../src/domain/payments";
import { defaultAccess, newAccessGroup } from "../src/domain/access";
import {
  parseWorkspace,
  LocalWorkspaceRepository,
} from "../src/repositories/workspaceRepository";
import { fieldExtensionImpacts } from "../src/domain/extensions";
beforeEach(() => {
  vi.restoreAllMocks();
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  });
  setActivePinia(createPinia());
});
const time = Date.parse("2026-10-08T03:00:00Z");
async function setup() {
  const store = useWorkspaceStore(),
    form = store.openForm(
      (await store.createForm("oa", "支付验收", "form"))!.id,
    )!;
  form.schema.fields = [
    createField("text", { id: "name", label: "服务名称", required: true }),
    createField("number", { id: "amount", label: "金额", min: 0 }),
  ];
  const merchant: PaymentMerchant = {
    id: "demo",
    name: "测试商户",
    enabled: true,
    methods: ["wechat", "alipay"],
    note: "",
  };
  expect(await store.savePaymentMerchant(merchant)).toBe(true);
  const config = newPayment();
  Object.assign(config, {
    enabled: true,
    merchantId: merchant.id,
    amount: { source: "field", value: "amount" },
    description: { source: "field", value: "name" },
  });
  expect(await store.savePayment(form.id, config)).toBe(true);
  expect(await store.publishForm(form.id)).toBe(true);
  const entry = (await store.submitEntry(
    form.id,
    { name: "服务 A", amount: 12.34 },
    "submitted",
    undefined,
    "zhang",
  ))!;
  const start = async () =>
    (await store.startPayment(entry.id, "detail", undefined, time))!;
  return { store, form, config, merchant, entry, start };
}
describe("local payment lifecycle", () => {
  it("rechecks configured conditions before a pending order can complete", async () => {
    const { store, form, config } = await setup();
    config.filters = [
      {
        id: "minimum",
        sourceFieldId: "amount",
        operator: "greater",
        source: "constant",
        value: "10",
      },
    ];
    expect(await store.savePayment(form.id, config)).toBe(true);
    await store.publishForm(form.id);
    const entry = (await store.submitEntry(form.id, {
      name: "条件测试",
      amount: 12,
    }))!;
    const order = (await store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    await store.updateEntry(entry.id, { ...entry.values, amount: 5 });
    expect(
      await store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect(
      await store.startPayment(entry.id, "detail", undefined, time),
    ).toBeUndefined();
  });
  it("resolves calculated amounts from source values and blocks unsupported methods", async () => {
    const { store, form, config } = await setup();
    form.schema.fields.push(
      createField("calculated", {
        id: "total",
        label: "应付合计",
        expression: "{{amount}}*2",
      }),
    );
    config.amount = { source: "field", value: "total" };
    config.methods = ["wechat"];
    await store.savePayment(form.id, config);
    await store.publishForm(form.id);
    const entry = (await store.submitEntry(form.id, {
      name: "计算金额",
      amount: 12.34,
      total: 1,
    }))!;
    const order = (await store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    expect(order.amountCents).toBe(2468);
    expect(
      await store.finishPayment(
        order.id,
        "alipay",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect(store.data.paymentOrders![0]!.status).toBe("pending");
  });
  it("rolls back refund amounts and configuration when persistence fails", async () => {
    const { store, form, merchant, start } = await setup(),
      order = await start();
    await store.finishPayment(
      order.id,
      "wechat",
      "success",
      undefined,
      time + 1,
    );
    const before = JSON.stringify(store.data),
      draftBefore = JSON.stringify(form);
    vi.spyOn(LocalWorkspaceRepository.prototype, "save").mockImplementation(
      () => {
        throw Error("存储失败");
      },
    );
    expect(await store.refundPayment(order.id, "2", "测试")).toBe(false);
    expect(
      await store.savePaymentMerchant({ ...merchant, enabled: false }),
    ).toBe(false);
    expect(await store.savePayment(form.id, newPayment())).toBe(false);
    expect(JSON.stringify(store.data)).toBe(before);
    expect(form.extensions!.payment!.enabled).toBe(true);
    expect(JSON.stringify(form.extensions)).toBe(
      JSON.stringify(JSON.parse(draftBefore).extensions),
    );
  });
  it("keeps exact cents and rejects empty, precision, negative and excessive amounts", () => {
    expect(paymentCents("00012.30")).toBe(1230);
    expect(paymentCents(0)).toBe(0);
    expect(paymentCents(100000)).toBe(10000000);
    expect(paymentCents(0.1 + 0.2)).toBe(30);
    for (const value of [
      "",
      null,
      -1,
      true,
      "1.001",
      "1e2",
      "Infinity",
      100000.01,
    ])
      expect(() => paymentCents(value)).toThrow();
  });
  it("validates enabled settings and reports deleted field references before publishing", async () => {
    const { store, form, config } = await setup();
    expect(fieldExtensionImpacts(form, ["amount"])).toContain(
      "在线支付的金额、说明、条件或结果回填",
    );
    const bad = { ...config, merchantId: "missing", methods: [] };
    expect(paymentIssues(bad, form.schema, store.data).length).toBeGreaterThan(
      1,
    );
    expect(await store.savePayment(form.id, bad)).toBe(false);
    form.schema.fields = form.schema.fields.filter((f) => f.id !== "amount");
    expect(await store.publishForm(form.id)).toBe(false);
  });
  it("reuses an active order and treats duplicate success callbacks as idempotent", async () => {
    const { store, entry, start } = await setup(),
      order = await start();
    expect((await start()).id).toBe(order.id);
    expect(store.data.paymentOrders).toHaveLength(1);
    expect(
      await store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(true);
    const saved = JSON.stringify(store.data);
    expect(
      await store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 2,
      ),
    ).toBe(true);
    expect(JSON.stringify(store.data)).toBe(saved);
    expect((await start()).id).toBe(order.id);
    expect(store.data.entries.find((e) => e.id === entry.id)!.status).toBe(
      "submitted",
    );
  });
  it("retains submitted records on failure and retries the same order before expiry", async () => {
    const { store, entry, start } = await setup(),
      order = await start();
    expect(
      await store.finishPayment(
        order.id,
        "alipay",
        "failed",
        undefined,
        time + 1,
      ),
    ).toBe(true);
    expect(store.data.entries.some((e) => e.id === entry.id)).toBe(true);
    expect((await start()).id).toBe(order.id);
    expect(
      await store.finishPayment(
        order.id,
        "alipay",
        "success",
        undefined,
        time + 2,
      ),
    ).toBe(true);
    expect(store.data.paymentOrders![0]!.attempts).toBe(2);
  });
  it("cancels pending attempts and rejects callbacks until a new order is created", async () => {
    const { store, start } = await setup(),
      old = await start();
    expect(await store.cancelPayment(old.id)).toBe(true);
    expect(
      await store.finishPayment(
        old.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect((await start()).id).not.toBe(old.id);
  });
  it("expires orders and gives the replacement a fresh validity window", async () => {
    const { store, entry, start } = await setup(),
      old = await start(),
      expired = time + 30 * 60000;
    expect(orderState(old, expired)).toBe("expired");
    expect(
      await store.finishPayment(
        old.id,
        "wechat",
        "success",
        undefined,
        expired,
      ),
    ).toBe(false);
    const next = (await store.startPayment(
      entry.id,
      "detail",
      undefined,
      expired,
    ))!;
    expect(next.id).not.toBe(old.id);
    expect(Date.parse(next.expiresAt)).toBe(expired + 30 * 60000);
  });
  it("rejects stale quotes and preserves old amounts when records are updated", async () => {
    const { store, entry, start } = await setup(),
      old = await start();
    expect(
      await store.updateEntry(entry.id, { ...entry.values, amount: 20 }),
    ).toBe(true);
    expect(
      await store.finishPayment(
        old.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    const next = await start();
    expect(next.amountCents).toBe(2000);
    expect(next.id).not.toBe(old.id);
    expect(
      store.data.paymentOrders!.find((o) => o.id === old.id)!.amountCents,
    ).toBe(1234);
  });
  it("closes stale attempts atomically when requoting directly", async () => {
    const { store, entry, start } = await setup(),
      old = await start();
    await store.updateEntry(entry.id, { ...entry.values, name: "服务 B" });
    const next = await start();
    expect(next.description).toBe("服务 B");
    expect(store.data.paymentOrders!.find((o) => o.id === old.id)!.status).toBe(
      "cancelled",
    );
  });
  it("rechecks conditions and merchant availability at payment time", async () => {
    const { store, entry, merchant, start } = await setup(),
      order = await start();
    await store.savePaymentMerchant({ ...merchant, enabled: false });
    expect(
      await store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect(await store.startPayment(entry.id)).toBeUndefined();
  });
  it("supports zero amounts without claiming payment or allowing refunds", async () => {
    const { store, entry, start } = await setup();
    await store.updateEntry(entry.id, { ...entry.values, amount: 0 });
    const order = await start();
    expect(order.status).toBe("free");
    expect(order.transactionId).toBeUndefined();
    expect(await store.refundPayment(order.id, "1", "测试")).toBe(false);
    expect((await start()).id).toBe(order.id);
  });
  it("supports partial and full refunds with a fixed original amount and no second payment", async () => {
    const { store, start } = await setup(),
      order = await start();
    await store.finishPayment(
      order.id,
      "wechat",
      "success",
      undefined,
      time + 1,
    );
    expect(await store.refundPayment(order.id, "2.34", "部分服务取消")).toBe(
      true,
    );
    expect(store.data.paymentOrders![0]!.status).toBe("partially_refunded");
    expect(await store.refundPayment(order.id, "10.01", "超过余额")).toBe(
      false,
    );
    expect(await store.refundPayment(order.id, "10", "剩余服务取消")).toBe(
      true,
    );
    expect(store.data.paymentOrders![0]!.status).toBe("refunded");
    expect((await start()).id).toBe(order.id);
    expect(store.data.paymentOrders![0]!.amountCents).toBe(1234);
  });
  it("uses immutable published configuration for old records and new configuration for new records", async () => {
    const { store, form, config, entry } = await setup();
    await store.savePayment(form.id, {
      ...config,
      amount: { source: "fixed", value: "88" },
    });
    await store.publishForm(form.id);
    expect(quotePayment(entry, store.data).amountCents).toBe(1234);
    const next = (await store.submitEntry(form.id, {
      name: "服务 B",
      amount: 12.34,
    }))!;
    expect(quotePayment(next, store.data).amountCents).toBe(8800);
    expect(
      (await store.duplicateForm(form.id))!.extensions!.payment!.enabled,
    ).toBe(false);
  });
  it("allows only the owning member and the permitted entry path to initiate payment", async () => {
    const { store, form, entry, config } = await setup();
    const group = newAccessGroup(form.schema, "manage");
    group.identities = ["zhang", "li"];
    await store.saveFormAccess(form.id, {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [group],
    });
    const owner = { actorId: "zhang", selection: "*" },
      other = { actorId: "li", selection: "*" };
    expect(
      await store.startPayment(entry.id, "detail", other, time),
    ).toBeUndefined();
    const order = (await store.startPayment(entry.id, "detail", owner, time))!;
    expect(order.payerId).toBe("zhang");
    expect(
      await store.finishPayment(order.id, "wechat", "success", other, time + 1),
    ).toBe(false);
    expect(
      await store.finishPayment(order.id, "wechat", "success", owner, time + 1),
    ).toBe(true);
    await store.savePayment(form.id, { ...config, timing: "detail" });
    await store.publishForm(form.id);
    const later = (await store.submitEntry(form.id, {
      name: "稍后支付",
      amount: 2,
    }))!;
    expect(
      await store.startPayment(later.id, "submit", undefined, time),
    ).toBeUndefined();
    expect(
      await store.startPayment(later.id, "detail", undefined, time),
    ).toBeDefined();
  });
  it("does not allow pending callbacks on recycled records", async () => {
    const { store, entry, start } = await setup(),
      order = await start();
    await store.recycleEntries([entry.id], true);
    expect(
      await store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
  });
  it("rolls back orders and record history together on storage failure, including requotes", async () => {
    const { store, entry, start } = await setup(),
      order = await start();
    const before = JSON.stringify(store.data);
    vi.spyOn(LocalWorkspaceRepository.prototype, "save").mockImplementation(
      () => {
        throw Error("存储失败");
      },
    );
    expect(
      await store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect(JSON.stringify(store.data)).toBe(before);
    expect(await store.cancelPayment(order.id)).toBe(false);
    expect(JSON.stringify(store.data)).toBe(before);
    entry.values.amount = 30;
    const changed = JSON.stringify(store.data);
    expect(await start()).toBeUndefined();
    expect(JSON.stringify(store.data)).toBe(changed);
  });
  it("round trips local orders and merchants, fails safely on corrupt amounts", async () => {
    const { store, start } = await setup();
    await start();
    const loaded = parseWorkspace(JSON.stringify(store.data));
    expect(loaded.paymentOrders).toEqual(copy(store.data.paymentOrders));
    expect(loaded.paymentMerchants).toHaveLength(1);
    expect(() =>
      parsePaymentOrders([{ ...loaded.paymentOrders![0], amountCents: -1 }]),
    ).toThrow("无效");
    expect(() =>
      parsePaymentOrders([loaded.paymentOrders![0], loaded.paymentOrders![0]]),
    ).toThrow("无效");
    expect(
      parseWorkspace(
        JSON.stringify({
          ...store.data,
          paymentOrders: undefined,
          paymentMerchants: undefined,
        }),
      ).paymentOrders,
    ).toEqual([]);
  });
});

async function resultSetup() {
  const ctx = await setup();
  ctx.form.schema.fields.push(
    createField("text", {
      id: "payStatus",
      label: "支付状态",
      editable: false,
    }),
    createField("text", { id: "payId", label: "订单号", editable: false }),
    createField("number", {
      id: "paidAmount",
      label: "订单金额",
      editable: false,
    }),
    createField("number", {
      id: "refundAmount",
      label: "已退款",
      editable: false,
    }),
    createField("datetime", {
      id: "paidTime",
      label: "支付时间",
      format: "datetime-second",
      editable: false,
    }),
  );
  ctx.config.resultMappings = [
    { source: "status", targetId: "payStatus" },
    { source: "orderId", targetId: "payId" },
    { source: "amount", targetId: "paidAmount" },
    { source: "refundedAmount", targetId: "refundAmount" },
    { source: "paidAt", targetId: "paidTime" },
  ];
  expect(await ctx.store.savePayment(ctx.form.id, ctx.config)).toBe(true);
  return ctx;
}
async function resultRule(ctx: Awaited<ReturnType<typeof resultSetup>>) {
  const target = ctx.store.openForm(
    (await ctx.store.createForm("oa", "支付台账", "form"))!.id,
  )!;
  target.schema.fields = [
    createField("text", { id: "status", label: "支付状态", required: true }),
    createField("number", { id: "refund", label: "退款" }),
  ];
  await ctx.store.publishForm(target.id);
  const rule = newAutomation(),
    step = newAutomationStep();
  Object.assign(rule, {
    name: "支付台账",
    events: ["payment_paid", "payment_free", "payment_refunded"],
  });
  Object.assign(step, {
    targetFormId: target.id,
    targetVersion: 1,
    mappings: [
      { targetId: "status", source: "field", fieldId: "payStatus", value: "" },
      {
        targetId: "refund",
        source: "field",
        fieldId: "refundAmount",
        value: "",
      },
    ],
  });
  rule.steps = [step];
  expect(await ctx.store.saveAutomation(ctx.form.id, rule)).toBe(true);
  await ctx.store.publishForm(ctx.form.id);
  const entry = (await ctx.store.submitEntry(ctx.form.id, {
    name: "回填验收",
    amount: 12.34,
  }))!;
  return { target, rule, entry };
}
describe("payment results and automation", () => {
  it("payment timestamps use the target date granularity and the same platform timezone as form defaults", async () => {
    for (const [format, expected] of [
      ["month", "2026-10"],
      ["date", "2026-10-08"],
      ["datetime-local", "2026-10-08T11:00"],
      ["datetime-second", "2026-10-08T11:00:00"],
    ]) {
      const ctx = await resultSetup();
      ctx.form.schema.fields.find((field) => field.id === "paidTime")!.format =
        format!;
      expect(await ctx.store.publishForm(ctx.form.id)).toBe(true);
      const entry = (await ctx.store.submitEntry(ctx.form.id, {
        name: "日期回填",
        amount: 1,
      }))!;
      const order = (await ctx.store.startPayment(
        entry.id,
        "detail",
        undefined,
        time,
      ))!;
      expect(
        await ctx.store.finishPayment(
          order.id,
          "wechat",
          "success",
          undefined,
          time + 1,
        ),
      ).toBe(true);
      expect(entry.values.paidTime).toBe(expected);
    }
  });
  it("keeps a successful payment and its results when a downstream business action fails", async () => {
    const ctx = await resultSetup(),
      { target, rule } = await resultRule(ctx);
    rule.steps[0]!.mappings[0] = {
      targetId: "status",
      source: "constant",
      fieldId: "",
      value: "",
    };
    await ctx.store.saveAutomation(ctx.form.id, rule);
    await ctx.store.publishForm(ctx.form.id);
    const entry = (await ctx.store.submitEntry(ctx.form.id, {
      name: "助手失败",
      amount: 5,
    }))!;
    const order = (await ctx.store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    expect(
      await ctx.store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(true);
    expect(entry.values.payStatus).toBe("已支付");
    expect(
      ctx.store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(0);
    expect(ctx.store.data.extensionRuns![0]!.status).toBe("failed");
    expect(ctx.store.data.paymentOrders![0]!.status).toBe("paid");
  });
  it("does not save a free order when result validation fails", async () => {
    const ctx = await resultSetup();
    ctx.form.schema.fields.find((f) => f.id === "payStatus")!.maxLength = 2;
    await ctx.store.publishForm(ctx.form.id);
    const entry = (await ctx.store.submitEntry(ctx.form.id, {
      name: "免费回填失败",
      amount: 0,
    }))!;
    const before = JSON.stringify(ctx.store.data);
    expect(
      await ctx.store.startPayment(entry.id, "detail", undefined, time),
    ).toBeUndefined();
    expect(JSON.stringify(ctx.store.data)).toBe(before);
  });
  it("writes typed read-only results before actions and never repeats a successful callback", async () => {
    const ctx = await resultSetup(),
      { entry, target } = await resultRule(ctx);
    const order = (await ctx.store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    expect(entry.values.payId).not.toBe(order.id);
    expect(
      await ctx.store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(true);
    expect(entry.values).toMatchObject({
      payStatus: "已支付",
      payId: order.id,
      paidAmount: 12.34,
      refundAmount: 0,
    });
    expect(entry.values.paidTime).toBe("2026-10-08T11:00:00");
    expect(
      ctx.store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(1);
    expect(
      ctx.store.data.entries.find((e) => e.formId === target.id)!.values.status,
    ).toBe("已支付");
    const before = JSON.stringify(ctx.store.data);
    await ctx.store.finishPayment(
      order.id,
      "wechat",
      "success",
      undefined,
      time + 2,
    );
    expect(JSON.stringify(ctx.store.data)).toBe(before);
    expect(ctx.store.data.extensionRuns![0]!.event).toBe("payment_paid");
  });
  it("applies cumulative refunds and emits one event for each accepted refund", async () => {
    const ctx = await resultSetup(),
      { entry, target } = await resultRule(ctx);
    const order = (await ctx.store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    await ctx.store.finishPayment(
      order.id,
      "wechat",
      "success",
      undefined,
      time + 1,
    );
    expect(await ctx.store.refundPayment(order.id, "2.34", "部分取消")).toBe(
      true,
    );
    expect(entry.values).toMatchObject({
      payStatus: "部分退款",
      refundAmount: 2.34,
      paidAmount: 12.34,
    });
    expect(await ctx.store.refundPayment(order.id, "10", "剩余取消")).toBe(
      true,
    );
    expect(entry.values).toMatchObject({
      payStatus: "已退款",
      refundAmount: 12.34,
      payId: order.id,
    });
    expect(
      ctx.store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(3);
    expect(
      (ctx.store.data.extensionRuns || []).filter(
        (r) => r.event === "payment_refunded",
      ),
    ).toHaveLength(2);
    const restored = parseWorkspace(JSON.stringify(ctx.store.data));
    expect(
      restored.forms.find((f) => f.id === ctx.form.id)!.published!.extensions!
        .automations![0]!.events,
    ).toContain("payment_refunded");
    expect(
      restored.entries.find((e) => e.id === entry.id)!.values.refundAmount,
    ).toBe(12.34);
  });
  it("uses a separate free-order event and does not emit generic updates", async () => {
    const ctx = await resultSetup(),
      { target, rule } = await resultRule(ctx);
    rule.id = "ordinary-update";
    rule.events = ["data_update"];
    await ctx.store.saveAutomation(ctx.form.id, rule);
    await ctx.store.publishForm(ctx.form.id);
    const entry = (await ctx.store.submitEntry(ctx.form.id, {
      name: "免费",
      amount: 0,
    }))!;
    const order = (await ctx.store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    expect(order.status).toBe("free");
    expect(entry.values).toMatchObject({
      payStatus: "无需支付",
      paidAmount: 0,
      paidTime: "",
    });
    expect(
      ctx.store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(1);
    expect((ctx.store.data.extensionRuns || []).map((r) => r.event)).toEqual([
      "payment_free",
    ]);
    await ctx.store.startPayment(entry.id, "detail", undefined, time + 1);
    expect(ctx.store.data.extensionRuns).toHaveLength(1);
  });
  it("rolls back order, result values, derived records and logs if storage fails", async () => {
    const ctx = await resultSetup(),
      { entry } = await resultRule(ctx);
    const order = (await ctx.store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    const before = JSON.stringify(ctx.store.data);
    const save = vi
      .spyOn(LocalWorkspaceRepository.prototype, "save")
      .mockImplementation(() => {
        throw Error("已满");
      });
    expect(
      await ctx.store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect(JSON.stringify(ctx.store.data)).toBe(before);
    save.mockRestore();
    expect(
      await ctx.store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 2,
      ),
    ).toBe(true);
    const paid = JSON.stringify(ctx.store.data);
    vi.spyOn(LocalWorkspaceRepository.prototype, "save").mockImplementation(
      () => {
        throw Error("已满");
      },
    );
    expect(await ctx.store.refundPayment(order.id, "1", "测试")).toBe(false);
    expect(JSON.stringify(ctx.store.data)).toBe(paid);
  });
  it("rejects duplicate, mismatched, input-overwriting and missing result targets", async () => {
    const ctx = await resultSetup();
    for (const mappings of [
      [
        { source: "status", targetId: "payStatus" },
        { source: "orderId", targetId: "payStatus" },
      ],
      [{ source: "amount", targetId: "payStatus" }],
      [{ source: "status", targetId: "missing" }],
      [{ source: "amount", targetId: "amount" }],
      [{ source: "invented", targetId: "payStatus" }],
    ])
      expect(
        await ctx.store.savePayment(ctx.form.id, {
          ...ctx.config,
          resultMappings: mappings as PaymentResultMapping[],
        }),
      ).toBe(false);
    expect(fieldExtensionImpacts(ctx.form, ["payStatus"])).toContain(
      "在线支付的金额、说明、条件或结果回填",
    );
    expect(parsePayment({}).resultMappings).toEqual([]);
  });
  it("validates hidden system targets and leaves the payment pending on invalid results", async () => {
    const ctx = await resultSetup();
    const status = ctx.form.schema.fields.find((f) => f.id === "payStatus")!;
    status.visible = false;
    status.maxLength = 2;
    const { entry, target } = await resultRule(ctx),
      order = (await ctx.store.startPayment(
        entry.id,
        "detail",
        undefined,
        time,
      ))!;
    expect(
      await ctx.store.finishPayment(
        order.id,
        "wechat",
        "success",
        undefined,
        time + 1,
      ),
    ).toBe(false);
    expect(
      ctx.store.data.paymentOrders!.find((o) => o.id === order.id)!.status,
    ).toBe("pending");
    expect(
      ctx.store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(0);
    expect(entry.values.payStatus).not.toBe("已支付");
  });
  it("keeps historical versions unmapped and skips result events on failure or cancel", async () => {
    const ctx = await resultSetup();
    await resultRule(ctx);
    const old = await ctx.start();
    await ctx.store.finishPayment(
      old.id,
      "wechat",
      "success",
      undefined,
      time + 1,
    );
    expect(ctx.entry.values).not.toHaveProperty("payId");
    const entry = (await ctx.store.submitEntry(ctx.form.id, {
      name: "取消",
      amount: 4,
    }))!;
    const order = (await ctx.store.startPayment(
      entry.id,
      "detail",
      undefined,
      time,
    ))!;
    await ctx.store.finishPayment(
      order.id,
      "wechat",
      "failed",
      undefined,
      time + 1,
    );
    await ctx.store.cancelPayment(order.id);
    expect(ctx.store.data.extensionRuns || []).toHaveLength(0);
    expect(entry.values.payId).not.toBe(order.id);
  });
});
