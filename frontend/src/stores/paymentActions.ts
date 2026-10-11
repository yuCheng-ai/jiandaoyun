import { sameWorkspaceValue } from "../domain/workspaceSync";
import type { Ref } from "vue";
import { copy, uid } from "../domain/form";
import { canEntry, eligibleGroups } from "../domain/access";
import { parseExtensions } from "../domain/extensions";
import { recordCheckpoint } from "./recordTransaction";
import {
  applyPaymentResults,
  paymentResultEvent,
} from "../domain/paymentResults";
import type { PaymentEvent } from "../domain/events";
import {
  createPaymentOrder,
  orderState,
  parsePayment,
  paymentCents,
  paymentDefinition,
  paymentIssues,
  quotePayment,
  sameQuote,
  settledPayment,
  paymentMethods,
  type PaymentConfig,
  type PaymentMerchant,
  type PaymentMethod,
  type PaymentOrder,
} from "../domain/payments";
import type { FormEntry, FormRecord, WorkspaceData } from "../domain/workspace";

export interface PaymentMemberScope {
  actorId: string;
  selection: string;
}
export function paymentActions(
  data: Ref<WorkspaceData>,
  open: (id: string) => FormRecord | undefined,
  save: (id: string) => boolean,
  persist: () => boolean,
  notify: (message: string, type?: string) => void,
  onResult: (entry: FormEntry, event: PaymentEvent, actorId: string) => void,
) {
  const actor = (scope?: PaymentMemberScope) =>
    scope?.actorId || data.value.organization.currentUserId;
  const context = (scope?: PaymentMemberScope): WorkspaceData => ({
    ...data.value,
    organization: { ...data.value.organization, currentUserId: actor(scope) },
  });
  function allowed(
    entry: FormEntry,
    scope?: PaymentMemberScope,
    submitting = false,
  ) {
    return (
      !scope ||
      (entry.createdBy === scope.actorId &&
        (canEntry(data.value, entry, scope.actorId, "view", scope.selection) ||
          (submitting &&
            eligibleGroups(
              data.value,
              entry.formId,
              scope.actorId,
              scope.selection,
            ).some((g) => g.actions.includes("create")))))
    );
  }
  function fail(message: string) {
    notify(message, "warning");
  }
  function savePayment(formId: string, config: PaymentConfig) {
    const form = open(formId);
    if (!form) return false;
    const normalized = parsePayment(config),
      issues = normalized.enabled
        ? paymentIssues(normalized, form.schema, data.value)
        : [];
    if (issues.length) {
      fail(issues[0]!);
      return false;
    }
    const before = form.extensions;
    form.extensions = { ...parseExtensions(before), payment: normalized };
    if (save(formId)) return true;
    form.extensions = before;
    return false;
  }
  function savePaymentMerchant(
    merchant: PaymentMerchant,
    expected?: PaymentMerchant | null,
  ) {
    if (
      expected !== undefined &&
      !sameWorkspaceValue(
        expected,
        data.value.paymentMerchants?.find((m) => m.id === merchant.id) || null,
      )
    ) {
      fail("该商户已更新，当前输入已保留，请重新打开核对。");
      return false;
    }
    const next = copy(merchant);
    next.name = next.name.trim();
    if (
      !next.id ||
      !next.name ||
      next.name.length > 60 ||
      !next.methods.length ||
      next.methods.some((m) => !Object.hasOwn(paymentMethods, m))
    ) {
      fail("请填写 1–60 字商户名称，并选择有效支付方式");
      return false;
    }
    const before = data.value.paymentMerchants || [];
    if (before.some((m) => m.id !== next.id && m.name === next.name)) {
      fail("商户名称已存在");
      return false;
    }
    if (before.length >= 50 && !before.some((m) => m.id === next.id)) {
      fail("最多保留 50 个演示商户");
      return false;
    }
    data.value.paymentMerchants = before.some((m) => m.id === next.id)
      ? before.map((m) => (m.id === next.id ? next : m))
      : [...before, next];
    if (persist()) return true;
    data.value.paymentMerchants = before;
    return false;
  }
  /** Replace immutable order snapshots and record history in the same local write. */
  function commit(
    order: PaymentOrder,
    message: string,
    now = Date.now(),
    actorId = actor(),
  ) {
    const rollback = recordCheckpoint(data.value),
      at = new Date(now).toISOString();
    const event = paymentResultEvent(
      order,
      data.value.paymentOrders?.find((o) => o.id === order.id),
    );
    const entry = data.value.entries.find((e) => e.id === order.entryId);
    if (event && entry) {
      try {
        entry.values = applyPaymentResults(order, entry, {
          ...data.value,
          organization: { ...data.value.organization, currentUserId: actorId },
        });
      } catch (e) {
        rollback();
        fail((e as Error).message);
        return false;
      }
    }
    order.history.push({ at, message });
    const before = data.value.paymentOrders || [];
    data.value.paymentOrders = before.some((o) => o.id === order.id)
      ? before.map((o) => (o.id === order.id ? order : o))
      : [order, ...before];
    if (entry) {
      entry.history.push({
        label: "在线支付 · 本地模拟",
        action: message,
        time: at,
      });
      entry.updatedAt = at;
    }
    try {
      if (event && entry) onResult(entry, event, actorId);
    } catch (e) {
      rollback();
      fail(`支付结果未保存：${(e as Error).message}`);
      return false;
    }
    if (persist()) return true;
    rollback();
    return false;
  }
  function startPayment(
    entryId: string,
    origin: "submit" | "detail" = "detail",
    scope?: PaymentMemberScope,
    now = Date.now(),
  ): PaymentOrder | undefined {
    const entry = data.value.entries.find((e) => e.id === entryId);
    if (!entry || !allowed(entry, scope, origin === "submit")) {
      fail("当前成员不能为这条记录发起支付");
      return;
    }
    const previous = (data.value.paymentOrders || []).filter(
        (o) => o.entryId === entry.id,
      ),
      settled = previous.find((o) => settledPayment(o.status));
    if (settled) return settled;
    const config = paymentDefinition(entry, data.value)?.extensions?.payment;
    if (
      !config ||
      (!previous.length && config.timing !== "both" && config.timing !== origin)
    ) {
      fail("当前入口未启用支付");
      return;
    }
    let quote;
    try {
      quote = quotePayment(entry, context(scope));
    } catch (e) {
      fail((e as Error).message);
      return;
    }
    const latest = previous[0];
    if (
      latest &&
      latest.payerId === actor(scope) &&
      ["pending", "failed"].includes(orderState(latest, now)) &&
      sameQuote(latest, quote)
    ) {
      if (latest.status === "pending") return latest;
      const retry = { ...copy(latest), status: "pending" as const };
      return commit(retry, "重新尝试支付", now) ? retry : undefined;
    }
    if ((data.value.paymentOrders?.length || 0) >= 2000) {
      fail("已达到当前演示环境的订单数量上限，暂时无法创建新订单");
      return;
    }
    const rollback = recordCheckpoint(data.value);
    // A requote closes all earlier pending attempts in the same persistence transaction.
    data.value.paymentOrders = (data.value.paymentOrders || []).map((o) =>
      o.entryId === entry.id && ["pending", "failed"].includes(o.status)
        ? {
            ...copy(o),
            status: orderState(o, now) === "expired" ? "expired" : "cancelled",
            history: [
              ...o.history,
              {
                at: new Date(now).toISOString(),
                message: "旧订单已关闭，请以新订单确认的金额为准",
              },
            ],
          }
        : o,
    );
    const order = createPaymentOrder(entry, quote, actor(scope), now);
    if (
      commit(
        order,
        order.status === "free" ? "零元订单，无需支付" : "已生成待支付订单",
        now,
        actor(scope),
      )
    )
      return order;
    rollback();
    return;
  }
  function finishPayment(
    id: string,
    method: PaymentMethod,
    outcome: "success" | "failed",
    scope?: PaymentMemberScope,
    now = Date.now(),
  ) {
    const existing = data.value.paymentOrders?.find((o) => o.id === id),
      entry = data.value.entries.find((e) => e.id === existing?.entryId);
    if (
      !existing ||
      !entry ||
      !allowed(entry, scope, true) ||
      (scope && existing.payerId !== scope.actorId)
    ) {
      fail("当前成员不能操作这笔订单");
      return false;
    }
    if (settledPayment(existing.status)) return true;
    if (existing.status !== "pending") {
      fail("请重新发起支付后再试");
      return false;
    }
    const order = copy(existing);
    if (orderState(order, now) === "expired") {
      order.status = "expired";
      commit(order, "订单已过期，请重新发起支付", now);
      fail("订单已过期，请重新发起支付");
      return false;
    }
    try {
      if (!sameQuote(order, quotePayment(entry, context(scope))))
        throw Error("记录金额或说明已变化，请重新确认订单");
    } catch (e) {
      order.status = "cancelled";
      commit(order, (e as Error).message, now);
      fail((e as Error).message);
      return false;
    }
    if (!order.methods.includes(method)) {
      fail("该订单不支持所选支付方式");
      return false;
    }
    order.attempts++;
    order.method = method;
    order.status = outcome === "success" ? "paid" : "failed";
    if (outcome === "success") {
      order.paidAt = new Date(now).toISOString();
      order.transactionId = uid("SIM_TX");
    }
    return commit(
      order,
      outcome === "success"
        ? "模拟支付成功，未发生真实扣款"
        : "模拟支付失败，可重新尝试",
      now,
      actor(scope),
    );
  }
  function cancelPayment(id: string, scope?: PaymentMemberScope) {
    const old = data.value.paymentOrders?.find((o) => o.id === id),
      entry = data.value.entries.find((e) => e.id === old?.entryId);
    if (
      !old ||
      !entry ||
      !allowed(entry, scope, true) ||
      !["pending", "failed"].includes(old.status)
    )
      return false;
    return commit({ ...copy(old), status: "cancelled" }, "主动取消本地订单");
  }
  function refundPayment(id: string, amount: string, reason: string) {
    const old = data.value.paymentOrders?.find((o) => o.id === id);
    if (!old || !["paid", "partially_refunded"].includes(old.status)) {
      fail("仅已支付订单可以退款");
      return false;
    }
    let cents: number;
    try {
      cents = paymentCents(amount);
    } catch (e) {
      fail((e as Error).message);
      return false;
    }
    if (
      cents <= 0 ||
      cents > old.amountCents - old.refundedCents ||
      !reason.trim()
    ) {
      fail("请填写退款原因，金额须大于零且不超过可退余额");
      return false;
    }
    const order = copy(old);
    order.refundedCents += cents;
    order.status =
      order.refundedCents === order.amountCents
        ? "refunded"
        : "partially_refunded";
    return commit(
      order,
      `模拟退款 ¥${(cents / 100).toFixed(2)}：${reason.trim()}`,
    );
  }
  return {
    savePayment,
    savePaymentMerchant,
    startPayment,
    finishPayment,
    cancelPayment,
    refundPayment,
  };
}
