import { checkedDraftValue } from "./editorDrafts";
import { parseInvocation } from "./extensions";
import { automationActions, parseAutomations } from "./automation";
import { parseReminders, reminderChannels } from "./reminders";
import { buttonActions, buttonPositions, parseButtons } from "./buttons";
import { parseFilters } from "./fieldConfig";
import { pushEvents } from "./extensions";
import { parsePrintTemplates } from "./presentation";
import {
  parsePayment,
  parsePaymentMerchants,
  paymentMethods,
  paymentResults,
} from "./payments";
import { parseQuickFill } from "./quickFill";

function object(value: unknown): Record<string, any> {
  const raw = checkedDraftValue(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("扩展配置暂存格式无效");
  return raw as Record<string, any>;
}

/** Validate shape without requiring a finished configuration; business validation runs on save. */
export function restorePluginDraft(value: unknown) {
  const raw = object(value);
  if (
    typeof raw.actionId !== "string" ||
    !raw.inputs ||
    typeof raw.inputs !== "object" ||
    Array.isArray(raw.inputs) ||
    !Array.isArray(raw.outputs) ||
    Object.values(raw.inputs).some(
      (binding: any) =>
        !binding ||
        !["constant", "field", "template"].includes(binding.source) ||
        typeof binding.value !== "string",
    ) ||
    raw.outputs.some(
      (mapping: any) =>
        !mapping ||
        typeof mapping.outputKey !== "string" ||
        typeof mapping.fieldId !== "string",
    )
  )
    throw Error("插件参数或回填关系格式无效");
  const parsed = parseInvocation(raw);
  if (parsed.outputs.length !== raw.outputs.length)
    throw Error("插件回填关系格式无效");
  return parsed;
}

export function restoreAutomationDraft(value: unknown, expectedId?: string) {
  const raw = object(value);
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    (expectedId && raw.id !== expectedId)
  )
    throw Error("智能助手暂存不属于此配置");
  if (
    !Array.isArray(raw.steps) ||
    raw.steps.length > 20 ||
    raw.steps.some(
      (step: any) =>
        !step ||
        !Object.hasOwn(automationActions, step.action) ||
        !Array.isArray(step.mappings) ||
        step.mappings.length > 100 ||
        step.mappings.some(
          (mapping: any) =>
            !mapping || !["field", "constant"].includes(mapping.source),
        ),
    )
  )
    throw Error("智能助手动作或字段映射格式无效");
  return parseAutomations([raw])[0]!;
}

function configId(
  raw: Record<string, any>,
  expectedId: string | undefined,
  name: string,
) {
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    (expectedId && raw.id !== expectedId)
  )
    throw Error(`${name}暂存不属于此配置`);
}
function filters(raw: any) {
  if (
    !Array.isArray(raw) ||
    raw.some(
      (f: any) =>
        !f ||
        typeof f.sourceFieldId !== "string" ||
        typeof f.value !== "string",
    )
  )
    throw Error("筛选条件暂存格式无效");
  const parsed = parseFilters(raw);
  if (parsed.length !== raw.length) throw Error("筛选条件暂存格式无效");
  return parsed;
}
export function restoreReminderDraft(value: unknown, expectedId?: string) {
  const raw = object(value);
  configId(raw, expectedId, "提醒");
  if (
    !["name", "dateFieldId", "time", "title", "message"].every(
      (k) => typeof raw[k] === "string",
    ) ||
    !["event", "date"].includes(raw.trigger) ||
    !Object.hasOwn(reminderChannels, raw.channel) ||
    !Array.isArray(raw.events) ||
    raw.events.some((event: string) => !Object.hasOwn(pushEvents, event)) ||
    (typeof raw.offsetDays !== "number" && raw.offsetDays !== "") ||
    !raw.recipients ||
    !["fixed", "field"].includes(raw.recipients.source) ||
    !Array.isArray(raw.recipients.ids) ||
    raw.recipients.ids.some((id: unknown) => typeof id !== "string") ||
    typeof raw.recipients.fieldId !== "string"
  )
    throw Error("提醒条件或接收人暂存格式无效");
  return {
    ...parseReminders([raw])[0]!,
    filters: filters(raw.filters),
    // Empty date/number controls are legitimate unfinished edits, not defaults.
    time: raw.time,
    offsetDays: raw.offsetDays,
  };
}
export function restoreButtonDraft(value: unknown, expectedId?: string) {
  const raw = object(value);
  configId(raw, expectedId, "按钮");
  const binding = (b: any) =>
    b &&
    ["constant", "field"].includes(b.source) &&
    typeof b.fieldId === "string" &&
    Object.hasOwn(b, "value");
  if (
    !["name", "url", "targetFormId", "confirmation"].every(
      (k) => typeof raw[k] === "string",
    ) ||
    !Object.hasOwn(buttonActions, raw.action) ||
    !Array.isArray(raw.positions) ||
    raw.positions.some(
      (position: string) => !Object.hasOwn(buttonPositions, position),
    ) ||
    !Array.isArray(raw.mappings) ||
    raw.mappings.length > 100 ||
    raw.mappings.some(
      (m: any) => !binding(m) || typeof m.targetId !== "string",
    ) ||
    !Array.isArray(raw.params) ||
    raw.params.length > 30 ||
    raw.params.some(
      (p: any) => !p || typeof p.name !== "string" || !binding(p.binding),
    )
  )
    throw Error("按钮动作或字段映射暂存格式无效");
  const parsed = parseButtons([raw])[0]!;
  parsed.filters = filters(raw.filters);
  // Preserve typed constant values, including an intentionally cleared null.
  parsed.mappings.forEach((m, i) => (m.value = raw.mappings[i].value));
  parsed.params.forEach(
    (p, i) => (p.binding.value = raw.params[i].binding.value),
  );
  return parsed;
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const booleans = (raw: Record<string, any>, keys: string[]) =>
  keys.every((key) => typeof raw[key] === "boolean");

export function restorePrintTemplateDraft(value: unknown, expectedId?: string) {
  const raw = object(value);
  configId(raw, expectedId, "打印模板");
  if (
    !Object.entries({ name: 80, title: 120, subtitle: 300, footer: 300 }).every(
      ([key, limit]) =>
        typeof raw[key] === "string" && raw[key].length <= limit,
    ) ||
    !strings(raw.fieldIds) ||
    raw.fieldIds.length > 300 ||
    new Set(raw.fieldIds).size !== raw.fieldIds.length ||
    !["all", "custom"].includes(raw.fieldMode) ||
    ![1, 2].includes(raw.columns) ||
    ![12, 14, 16].includes(raw.fontSize) ||
    !["A4", "A5"].includes(raw.paper) ||
    !["portrait", "landscape"].includes(raw.orientation) ||
    (raw.fileName !== undefined &&
      (!raw.fileName ||
        !["default", "title", "custom"].includes(raw.fileName.mode) ||
        typeof raw.fileName.value !== "string")) ||
    !booleans(raw, ["hideEmpty", "showMetadata", "showHistory", "archived"])
  )
    throw Error("打印模板暂存格式无效");
  return parsePrintTemplates([raw])[0]!;
}

function checkedMethods(value: unknown) {
  return (
    strings(value) &&
    value.every((method) => Object.hasOwn(paymentMethods, method)) &&
    new Set(value).size === value.length
  );
}
export function restoreMerchantDraft(value: unknown, expectedId?: string) {
  const raw = object(value);
  configId(raw, expectedId, "演示商户");
  if (
    typeof raw.name !== "string" ||
    typeof raw.note !== "string" ||
    typeof raw.enabled !== "boolean" ||
    !checkedMethods(raw.methods)
  )
    throw Error("演示商户暂存格式无效");
  return parsePaymentMerchants([raw])[0]!;
}

export function restorePaymentDraft(value: unknown) {
  const raw = object(value);
  const binding = (v: any) =>
    v && ["fixed", "field"].includes(v.source) && typeof v.value === "string";
  if (
    !booleans(raw, ["enabled"]) ||
    typeof raw.merchantId !== "string" ||
    !binding(raw.amount) ||
    !binding(raw.description) ||
    !["submit", "detail", "both"].includes(raw.timing) ||
    !checkedMethods(raw.methods) ||
    (raw.expiresMinutes !== "" &&
      (typeof raw.expiresMinutes !== "number" ||
        !Number.isFinite(raw.expiresMinutes))) ||
    !Array.isArray(raw.resultMappings) ||
    raw.resultMappings.some(
      (m: any) =>
        !m ||
        !Object.hasOwn(paymentResults, m.source) ||
        typeof m.targetId !== "string",
    )
  )
    throw Error("支付配置暂存格式无效");
  return {
    ...parsePayment(raw),
    filters: filters(raw.filters),
    expiresMinutes: raw.expiresMinutes,
  };
}

export function restoreQuickFillDraft(value: unknown) {
  const raw = object(value),
    config = object(raw.config),
    aliasText = object(raw.aliasText);
  if (
    !booleans(config, ["enabled", "allowText", "allowImages"]) ||
    typeof config.example !== "string" ||
    !Array.isArray(config.fields) ||
    config.fields.length > 30 ||
    config.fields.some(
      (f: any) =>
        !f ||
        typeof f.fieldId !== "string" ||
        !strings(f.aliases) ||
        typeof f.instruction !== "string",
    ) ||
    new Set(config.fields.map((f: any) => f.fieldId)).size !==
      config.fields.length ||
    Object.values(aliasText).some((text) => typeof text !== "string")
  )
    throw Error("快捷填报暂存格式无效");
  return {
    config: parseQuickFill(config),
    aliasText: aliasText as Record<string, string>,
  };
}
