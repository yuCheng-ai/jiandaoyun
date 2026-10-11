export const pushEvents = {
  data_create: "新增数据",
  data_update: "修改数据",
  data_remove: "删除数据",
  data_recover: "恢复数据",
} as const;
export type PushEvent = keyof typeof pushEvents;
export const paymentEvents = {
  payment_paid: "支付成功",
  payment_free: "零元订单确认",
  payment_refunded: "退款成功（含部分退款）",
} as const;
export type PaymentEvent = keyof typeof paymentEvents;
export const automationEvents = { ...pushEvents, ...paymentEvents } as const;
export type AutomationEvent = keyof typeof automationEvents;
export const isPushEvent = (value: unknown): value is PushEvent =>
  typeof value === "string" && Object.hasOwn(pushEvents, value);
