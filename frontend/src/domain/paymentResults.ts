import { copy, validateValues, type FormValues } from "./form";
import { applyFieldChange, scopeFields } from "./relations";
import { validateDynamicValues } from "./fieldValidation";
import { blockingFormValidation } from "./formValidation";
import {
  paymentDefinition,
  paymentMappingIssues,
  paymentMethods,
  paymentStates,
  type PaymentEvent,
  type PaymentOrder,
} from "./payments";
import type { FormEntry, WorkspaceData } from "./workspace";
import { dateValueAt } from "@platform/contracts";

export function paymentResultEvent(
  order: PaymentOrder,
  previous?: PaymentOrder,
): PaymentEvent | undefined {
  if (order.status === "paid" && previous?.status !== "paid")
    return "payment_paid";
  if (order.status === "free" && previous?.status !== "free")
    return "payment_free";
  if (
    ["partially_refunded", "refunded"].includes(order.status) &&
    order.refundedCents > (previous?.refundedCents || 0)
  )
    return "payment_refunded";
}

/** System-authored result fields may be read-only to members. The published mapping is the authority. */
export function applyPaymentResults(
  order: PaymentOrder,
  entry: FormEntry,
  data: WorkspaceData,
): FormValues {
  const definition = paymentDefinition(entry, data);
  if (!definition) throw Error("支付记录所属表单版本不存在");
  const config = definition.extensions?.payment;
  if (!config?.resultMappings?.length) return copy(entry.values);
  const issue = paymentMappingIssues(config, definition.schema)[0];
  if (issue) throw Error(issue);
  if (entry.deletedAt) throw Error("记录已在回收站，请恢复后再同步支付结果");
  const result = {
    status: paymentStates[order.status],
    orderId: order.id,
    transactionId: order.transactionId || "",
    amount: order.amountCents / 100,
    refundedAmount: order.refundedCents / 100,
    paidAt: order.paidAt || "",
    method: order.method ? paymentMethods[order.method] : "",
    merchantName: order.merchantName,
  };
  const fields = scopeFields(definition.schema.fields),
    mapped = new Map<string, unknown>();
  for (const m of config.resultMappings) {
    const target = fields.find((f) => f.id === m.targetId)!;
    let value: unknown = result[m.source];
    if (m.source === "paidAt" && value) {
      value = dateValueAt(target.format, new Date(String(value)));
    }
    mapped.set(target.id, value);
  }
  let values = { ...copy(entry.values), ...Object.fromEntries(mapped) };
  for (const [id, value] of mapped)
    values = applyFieldChange(
      definition.schema.fields,
      values,
      id,
      value,
      data,
    );
  const others = data.entries
    .filter(
      (e) =>
        e.formId === entry.formId &&
        e.id !== entry.id &&
        !e.deletedAt &&
        e.status !== "draft",
    )
    .map((e) => e.values);
  // Validate system targets even when their display rule hides them from the user.
  const targetSchema = copy(definition.schema);
  targetSchema.fields = fields
    .filter((f) => mapped.has(f.id))
    .map((f) => ({ ...copy(f), visible: true }));
  targetSchema.settings.rules = [];
  const errors = [
    ...validateValues(targetSchema, values, others),
    ...validateValues(definition.schema, values, others),
    ...validateDynamicValues(definition.schema, values, data),
  ];
  if (errors.length) throw Error(`支付结果无法回填：${errors[0]!.message}`);
  if (
    data.forms.find((form) => form.id === entry.formId)?.kind !== "workflow"
  ) {
    const issue = blockingFormValidation(definition.schema, values, {
      data,
    })[0];
    if (issue) throw Error(`支付结果无法回填：${issue}`);
  }
  return values;
}
