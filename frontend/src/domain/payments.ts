import { copy, resolveCalculations, uid, type FormSchema } from "./form";
import { isNumericField } from "@platform/contracts";
import { parseFilters, type DataFilter } from "./fieldConfig";
import { matchesFilters, scopeFields } from "./relations";
import type { FormEntry, WorkspaceData } from "./workspace";

export const paymentMethods = { wechat: "微信支付", alipay: "支付宝" } as const;
export type PaymentMethod = keyof typeof paymentMethods;
export const paymentStates = {
  pending: "待支付",
  failed: "支付失败",
  cancelled: "已取消",
  expired: "已过期",
  paid: "已支付",
  partially_refunded: "部分退款",
  refunded: "已退款",
  free: "无需支付",
} as const;
export type PaymentState = keyof typeof paymentStates;
export { paymentEvents, type PaymentEvent } from "./events";
export const paymentResults = {
  status: { label: "支付状态", type: "text" },
  orderId: { label: "订单号", type: "text" },
  transactionId: { label: "支付流水号", type: "text" },
  amount: { label: "订单金额（元）", type: "number" },
  refundedAmount: { label: "累计退款（元）", type: "number" },
  paidAt: { label: "支付时间", type: "datetime" },
  method: { label: "支付方式", type: "text" },
  merchantName: { label: "商户名称", type: "text" },
} as const;
export type PaymentResultKey = keyof typeof paymentResults;
export interface PaymentResultMapping {
  source: PaymentResultKey;
  targetId: string;
}
export interface PaymentConfig {
  enabled: boolean;
  merchantId: string;
  amount: { source: "fixed" | "field"; value: string };
  description: { source: "fixed" | "field"; value: string };
  timing: "submit" | "detail" | "both";
  filters: DataFilter[];
  methods: PaymentMethod[];
  expiresMinutes: number;
  resultMappings?: PaymentResultMapping[];
}
export interface PaymentMerchant {
  id: string;
  name: string;
  enabled: boolean;
  methods: PaymentMethod[];
  note: string;
}
export interface PaymentQuote {
  merchantId: string;
  merchantName: string;
  amountCents: number;
  description: string;
  methods: PaymentMethod[];
  expiresMinutes: number;
}
export interface PaymentOrder extends PaymentQuote {
  id: string;
  mode: "simulation";
  formId: string;
  entryId: string;
  definitionVersion: number;
  payerId: string;
  status: PaymentState;
  createdAt: string;
  expiresAt: string;
  paidAt?: string;
  method?: PaymentMethod;
  transactionId?: string;
  refundedCents: number;
  attempts: number;
  history: { at: string; message: string }[];
}
export const settledPayment = (s: PaymentState) =>
  ["paid", "free", "partially_refunded", "refunded"].includes(s);
export function newPayment(): PaymentConfig {
  return {
    enabled: false,
    merchantId: "",
    amount: { source: "fixed", value: "100.00" },
    description: { source: "fixed", value: "表单订单" },
    timing: "both",
    filters: [],
    methods: ["wechat", "alipay"],
    expiresMinutes: 30,
    resultMappings: [],
  };
}
const methods = (raw: unknown): PaymentMethod[] =>
  Array.isArray(raw)
    ? [
        ...new Set(
          raw.filter(
            (m): m is PaymentMethod =>
              typeof m === "string" && Object.hasOwn(paymentMethods, m),
          ),
        ),
      ]
    : [];
export function parsePayment(raw: any): PaymentConfig {
  const base = newPayment();
  return {
    enabled: raw?.enabled === true,
    merchantId: String(raw?.merchantId || ""),
    amount: {
      source: raw?.amount?.source === "field" ? "field" : "fixed",
      value: String(raw?.amount?.value ?? ""),
    },
    description: {
      source: raw?.description?.source === "field" ? "field" : "fixed",
      value: String(raw?.description?.value ?? ""),
    },
    timing: ["submit", "detail", "both"].includes(raw?.timing)
      ? raw.timing
      : base.timing,
    filters: parseFilters(raw?.filters),
    methods: methods(raw?.methods),
    expiresMinutes: Number(raw?.expiresMinutes ?? base.expiresMinutes),
    resultMappings: (Array.isArray(raw?.resultMappings)
      ? raw.resultMappings
      : []
    ).map((m: any) => ({
      source: String(m?.source || "") as PaymentResultKey,
      targetId: String(m?.targetId || ""),
    })),
  };
}
/** Currency is held in integer cents; never silently rounds a configured amount. */
export function paymentCents(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100000
  ) {
    const scaled = value * 100,
      rounded = Math.round(scaled);
    if (
      Math.abs(scaled - rounded) <=
      Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8
    )
      return rounded;
  }
  const text =
    typeof value === "number" || typeof value === "string"
      ? String(value).trim()
      : "";
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw Error("金额须为非负数字，最多两位小数");
  const [whole, fraction = ""] = text.split("."),
    cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 10000000)
    throw Error("单笔金额不能超过 100,000 元");
  return cents;
}
export const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
export function paymentFields(schema: FormSchema) {
  return scopeFields(schema.fields).filter((f) =>
    ["number", "calculated", "text", "textarea", "serial"].includes(f.type),
  );
}
export function paymentReferences(c: PaymentConfig): string[] {
  return [
    ...(c.resultMappings || []).map((m) => m.targetId),
    ...[c.amount, c.description]
      .filter((b) => b.source === "field")
      .map((b) => b.value),
    ...c.filters.flatMap((f) => [
      f.sourceFieldId,
      ...(f.source === "field" ? [f.value] : []),
    ]),
  ];
}
export function paymentResultTargets(
  schema: FormSchema,
  source: PaymentResultKey,
) {
  const type = paymentResults[source]?.type;
  return scopeFields(schema.fields).filter((f) =>
    type === "text" ? ["text", "textarea"].includes(f.type) : f.type === type,
  );
}
export function paymentMappingIssues(
  c: PaymentConfig,
  schema: FormSchema,
): string[] {
  const issues: string[] = [],
    seen = new Set<string>();
  if ((c.resultMappings?.length || 0) > 32)
    issues.push("最多配置 32 项支付结果回填");
  for (const m of c.resultMappings || []) {
    if (
      !Object.hasOwn(paymentResults, m.source) ||
      !paymentResultTargets(schema, m.source).some(
        (f) => f.id === m.targetId,
      ) ||
      ["__proto__", "constructor", "prototype"].includes(m.targetId)
    )
      issues.push("支付结果回填的目标字段已失效或类型不匹配");
    if (seen.has(m.targetId)) issues.push("一个字段只能接收一项支付结果");
    seen.add(m.targetId);
    if (
      [c.amount, c.description].some(
        (b) => b.source === "field" && b.value === m.targetId,
      )
    )
      issues.push("支付结果请使用独立字段，不能覆盖金额或订单说明来源");
  }
  return [...new Set(issues)];
}
export function paymentIssues(
  c: PaymentConfig,
  schema: FormSchema,
  data?: WorkspaceData,
): string[] {
  const errors: string[] = [],
    fields = paymentFields(schema),
    all = scopeFields(schema.fields);
  if (!c.merchantId) errors.push("请选择演示商户");
  const merchant = data?.paymentMerchants?.find(
    (m) => m.id === c.merchantId && m.enabled,
  );
  if (data && !merchant) errors.push("商户不存在或已停用，请到支付管理检查");
  if (
    !c.methods.length ||
    c.methods.some((m) => !Object.hasOwn(paymentMethods, m))
  )
    errors.push("至少选择一种支付方式");
  if (merchant && c.methods.some((m) => !merchant.methods.includes(m)))
    errors.push("所选支付方式未在商户中启用");
  if (c.amount.source === "fixed") {
    try {
      paymentCents(c.amount.value);
    } catch (e) {
      errors.push((e as Error).message);
    }
  } else if (!fields.some((f) => f.id === c.amount.value && isNumericField(f)))
    errors.push("金额来源须为当前表单的数字或计算字段");
  if (
    c.description.source === "fixed"
      ? !c.description.value.trim()
      : !fields.some((f) => f.id === c.description.value)
  )
    errors.push("请填写订单说明或选择有效字段");
  if (
    c.description.source === "fixed" &&
    c.description.value.trim().length > 256
  )
    errors.push("订单说明不能超过 256 个字符");
  if (
    !Number.isInteger(c.expiresMinutes) ||
    c.expiresMinutes < 1 ||
    c.expiresMinutes > 1440
  )
    errors.push("订单有效期须为 1–1440 分钟");
  for (const f of c.filters) {
    if (
      !all.some((v) => v.id === f.sourceFieldId) ||
      (f.source === "field" && !all.some((v) => v.id === f.value))
    )
      errors.push("支付条件引用了不存在的字段");
    if (f.operator !== "notEmpty" && f.source === "constant" && !f.value.trim())
      errors.push("请填写支付条件的比较值");
  }
  return [...new Set([...errors, ...paymentMappingIssues(c, schema)])];
}
export function paymentDefinition(entry: FormEntry, data: WorkspaceData) {
  const form = data.forms.find((f) => f.id === entry.formId);
  return (
    form?.versions.find((v) => v.version === entry.definitionVersion) ||
    (form?.published?.version === entry.definitionVersion
      ? form.published
      : undefined)
  );
}
export function quotePayment(
  entry: FormEntry,
  data: WorkspaceData,
): PaymentQuote {
  if (
    entry.deletedAt ||
    entry.status === "draft" ||
    !data.forms.some((f) => f.id === entry.formId && !f.archived)
  )
    throw Error("这条记录当前不能发起支付");
  const definition = paymentDefinition(entry, data),
    c = definition?.extensions?.payment;
  if (!definition || !c?.enabled) throw Error("该记录的发布版本未启用在线支付");
  const issues = paymentIssues(c, definition.schema, data);
  if (issues.length) throw Error(issues[0]);
  const values = resolveCalculations(definition.schema.fields, entry.values);
  if (!matchesFilters(c.filters, values, values, data, "all", scopeFields(definition.schema.fields)))
    throw Error("这条记录尚未满足支付条件");
  const raw = (b: PaymentConfig["amount"]): unknown =>
    b.source === "field" ? values[b.value] : b.value;
  const descriptionValue = raw(c.description);
  if (
    !["string", "number"].includes(typeof descriptionValue) ||
    !String(descriptionValue).trim()
  )
    throw Error("订单说明为空，请先完善记录");
  const description = String(descriptionValue).trim();
  if (description.length > 256) throw Error("订单说明不能超过 256 个字符");
  return {
    merchantId: c.merchantId,
    merchantName: data.paymentMerchants!.find((m) => m.id === c.merchantId)!
      .name,
    amountCents: paymentCents(raw(c.amount)),
    description,
    methods: [...c.methods],
    expiresMinutes: c.expiresMinutes,
  };
}
export function sameQuote(a: PaymentQuote, b: PaymentQuote) {
  return (
    a.merchantId === b.merchantId &&
    a.amountCents === b.amountCents &&
    a.description === b.description &&
    JSON.stringify(a.methods) === JSON.stringify(b.methods)
  );
}
export function orderState(
  order: PaymentOrder,
  now = Date.now(),
): PaymentState {
  return ["pending", "failed"].includes(order.status) &&
    now >= Date.parse(order.expiresAt)
    ? "expired"
    : order.status;
}
export function createPaymentOrder(
  entry: FormEntry,
  quote: PaymentQuote,
  actorId: string,
  now = Date.now(),
): PaymentOrder {
  const at = new Date(now).toISOString();
  return {
    ...copy(quote),
    id: uid("SIM"),
    mode: "simulation",
    formId: entry.formId,
    entryId: entry.id,
    definitionVersion: entry.definitionVersion,
    payerId: actorId,
    status: quote.amountCents === 0 ? "free" : "pending",
    createdAt: at,
    expiresAt: new Date(now + quote.expiresMinutes * 60000).toISOString(),
    refundedCents: 0,
    attempts: 0,
    history: [
      {
        at,
        message:
          quote.amountCents === 0 ? "金额为零，无需支付" : "创建本地模拟订单",
      },
    ],
  };
}
export function parsePaymentMerchants(raw: unknown): PaymentMerchant[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Error("商户列表格式无效");
  const seen = new Set<string>();
  return raw.map((m) => {
    if (
      typeof m?.id !== "string" ||
      seen.has(m.id) ||
      typeof m.name !== "string"
    )
      throw Error("商户 ID 无效或重复");
    seen.add(m.id);
    return {
      id: m.id,
      name: m.name,
      enabled: m.enabled === true,
      methods: methods(m.methods),
      note: String(m.note || ""),
    };
  });
}
export function parsePaymentOrders(raw: unknown): PaymentOrder[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Error("支付订单格式无效");
  const seen = new Set<string>();
  return raw.map((o) => {
    if (
      !o ||
      [
        "id",
        "formId",
        "entryId",
        "payerId",
        "merchantId",
        "merchantName",
        "description",
      ].some((k) => typeof o[k] !== "string") ||
      seen.has(o.id) ||
      o.mode !== "simulation" ||
      !Object.hasOwn(paymentStates, o.status) ||
      !Number.isSafeInteger(o.amountCents) ||
      o.amountCents < 0 ||
      o.amountCents > 10000000 ||
      !Number.isSafeInteger(o.refundedCents) ||
      o.refundedCents < 0 ||
      o.refundedCents > o.amountCents ||
      !Number.isInteger(o.definitionVersion) ||
      o.definitionVersion < 1 ||
      !Number.isInteger(o.attempts) ||
      o.attempts < 0 ||
      !Number.isInteger(o.expiresMinutes) ||
      o.expiresMinutes < 1 ||
      o.expiresMinutes > 1440 ||
      !methods(o.methods).length ||
      (o.status === "free" && o.amountCents !== 0) ||
      (o.status === "refunded" &&
        (o.amountCents === 0 || o.refundedCents !== o.amountCents)) ||
      (o.status === "partially_refunded" &&
        (o.refundedCents <= 0 || o.refundedCents >= o.amountCents)) ||
      (!["partially_refunded", "refunded"].includes(o.status) &&
        o.refundedCents !== 0) ||
      !Number.isFinite(Date.parse(o.createdAt)) ||
      !Number.isFinite(Date.parse(o.expiresAt)) ||
      !Array.isArray(o.history)
    )
      throw Error("支付订单数据无效");
    seen.add(o.id);
    return {
      ...copy(o),
      methods: methods(o.methods),
      history: o.history.map((h: any) => ({
        at: String(h.at),
        message: String(h.message),
      })),
    };
  });
}
