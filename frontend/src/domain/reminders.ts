import { hasFieldValue } from "@platform/contracts";
import { copy, uid, type FormSchema, type FormValues } from "./form";
import { parseFilters, type DataFilter } from "./fieldConfig";
import { displayValue, matchesFilters, scopeFields } from "./relations";
import { resolveIdentities } from "./organization";
import type { WorkspaceData } from "./workspace";
import type { ConfigIssue, ExtensionRun, PushEvent } from "./extensions";

export interface ReminderConfig {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  trigger: "event" | "date";
  events: PushEvent[];
  dateFieldId: string;
  offsetDays: number;
  time: string;
  filters: DataFilter[];
  recipients: { source: "fixed" | "field"; ids: string[]; fieldId: string };
  channel: "inapp" | "email" | "enterprise";
  title: string;
  message: string;
}
export const reminderChannels = {
  inapp: "站内消息",
  email: "邮件",
  enterprise: "企业消息",
} as const;
export const recipientFieldTypes = [
  "member",
  "members",
  "department",
  "departments",
];
const events: PushEvent[] = [
  "data_create",
  "data_update",
  "data_remove",
  "data_recover",
];
const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string"))]
    : [];
export function newReminder(): ReminderConfig {
  return {
    id: uid("reminder"),
    name: "",
    enabled: false,
    archived: false,
    trigger: "event",
    events: ["data_create"],
    dateFieldId: "",
    offsetDays: 0,
    time: "09:00",
    filters: [],
    recipients: { source: "fixed", ids: [], fieldId: "" },
    channel: "inapp",
    title: "",
    message: "",
  };
}
export function parseReminders(raw: unknown): ReminderConfig[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 50) throw Error("每张表单最多配置 50 条提醒");
  const seen = new Set<string>();
  return raw.map((c) => {
    if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id))
      throw Error("提醒 ID 无效或重复");
    seen.add(c.id);
    return {
      id: c.id,
      name: String(c.name || ""),
      enabled: c.enabled === true,
      archived: c.archived === true,
      trigger: c.trigger === "date" ? "date" : "event",
      events: strings(c.events).filter((e): e is PushEvent =>
        events.includes(e as PushEvent),
      ),
      dateFieldId: String(c.dateFieldId || ""),
      offsetDays:
        c.offsetDays === undefined
          ? 0
          : typeof c.offsetDays === "number" && Number.isFinite(c.offsetDays)
            ? c.offsetDays
            : 366,
      time: String(c.time || "09:00"),
      filters: parseFilters(c.filters),
      recipients: {
        source: c.recipients?.source === "field" ? "field" : "fixed",
        ids: strings(c.recipients?.ids),
        fieldId: String(c.recipients?.fieldId || ""),
      },
      channel: Object.hasOwn(reminderChannels, c.channel) ? c.channel : "inapp",
      title: String(c.title || ""),
      message: String(c.message || ""),
    };
  });
}
export function reminderFields(schema: FormSchema) {
  return scopeFields(schema.fields).filter(hasFieldValue);
}
export function templateReferences(text: string): string[] {
  return [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]!.trim());
}
export function reminderReferences(c: ReminderConfig): string[] {
  return [
    ...(c.trigger === "date" ? [c.dateFieldId] : []),
    ...(c.recipients.source === "field" ? [c.recipients.fieldId] : []),
    ...templateReferences(c.title),
    ...templateReferences(c.message),
    ...c.filters.flatMap((f) => [
      f.sourceFieldId,
      ...(f.source === "field" && f.operator !== "notEmpty" ? [f.value] : []),
    ]),
  ];
}
export function reminderIssues(
  c: ReminderConfig,
  schema: FormSchema,
): ConfigIssue[] {
  const result: ConfigIssue[] = [],
    fields = reminderFields(schema);
  const issue = (step: number, target: string, message: string) =>
    result.push({ step, target, message });
  if (!c.name.trim()) issue(0, "reminder-name", "请填写提醒名称");
  if (c.trigger === "event" && !c.events.length)
    issue(0, "reminder-trigger", "至少选择一种触发事件");
  if (c.trigger === "date") {
    if (!fields.some((f) => f.id === c.dateFieldId && f.type === "datetime"))
      issue(0, "reminder-date", "请选择可用的日期字段");
    if (!Number.isInteger(c.offsetDays) || Math.abs(c.offsetDays) > 365)
      issue(0, "reminder-offset", "提前或延后天数需为 -365 至 365 的整数");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time))
      issue(0, "reminder-time", "请选择有效的提醒时间");
  }
  for (const f of c.filters) {
    if (
      !fields.some((a) => a.id === f.sourceFieldId) ||
      (f.operator !== "notEmpty" &&
        f.source === "field" &&
        !fields.some((a) => a.id === f.value))
    )
      issue(0, "reminder-filters", "筛选条件引用了不存在的字段");
    else if (
      f.operator !== "notEmpty" &&
      f.source === "constant" &&
      !f.value.trim()
    )
      issue(0, "reminder-filters", "请填写筛选条件的比较值");
  }
  if (c.recipients.source === "fixed" && !c.recipients.ids.length)
    issue(1, "reminder-recipients", "请选择接收成员、部门或角色");
  if (
    c.recipients.source === "field" &&
    !fields.some(
      (f) =>
        f.id === c.recipients.fieldId && recipientFieldTypes.includes(f.type),
    )
  )
    issue(1, "reminder-recipient-field", "请选择可用的成员或部门字段");
  for (const [key, text, label, max] of [
    ["title", c.title, "消息标题", 200],
    ["message", c.message, "消息内容", 4000],
  ] as const) {
    if (!text.trim()) issue(2, `reminder-${key}`, `请填写${label}`);
    if (text.length > max)
      issue(2, `reminder-${key}`, `${label}最多 ${max} 个字符`);
    if (templateReferences(text).some((id) => !fields.some((f) => f.id === id)))
      issue(2, `reminder-${key}`, `${label}引用了已删除或不在当前层级的字段`);
    if (/[{}]/.test(text.replace(/\{\{([^{}]+)\}\}/g, "")))
      issue(2, `reminder-${key}`, `${label}的字段占位符不完整，请使用插入字段`);
  }
  return result;
}
export function reminderRecipients(
  c: ReminderConfig,
  values: FormValues,
  data: WorkspaceData,
) {
  const value = values[c.recipients.fieldId];
  const ids =
    c.recipients.source === "fixed"
      ? c.recipients.ids
      : Array.isArray(value)
        ? strings(value)
        : typeof value === "string" && value
          ? [value]
          : [];
  // Ignore archived organizational units instead of expanding stale scopes.
  return resolveIdentities(
    data.organization,
    ids.filter(
      (id) =>
        !data.organization.departments.some((d) => d.id === id && d.archived) &&
        !data.organization.roles.some((r) => r.id === id && r.archived),
    ),
  );
}
export function renderReminderText(
  text: string,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
): string {
  const fields = reminderFields(schema);
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, id: string) => {
    const field = fields.find((f) => f.id === id.trim());
    return field
      ? displayValue(field, values[field.id], data)
      : "【字段已失效】";
  });
}
/** Date fields supply a calendar day. The configured local time replaces any time in that field. */
export function reminderDueAt(
  c: ReminderConfig,
  values: FormValues,
): Date | undefined {
  if (
    c.trigger !== "date" ||
    !Number.isInteger(c.offsetDays) ||
    Math.abs(c.offsetDays) > 365 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time)
  )
    return;
  const raw = values[c.dateFieldId];
  if (typeof raw !== "string") return;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  if (!match) return;
  const year = Number(match[1]),
    month = Number(match[2]) - 1,
    day = Number(match[3]);
  const date = new Date(year, month, day, 12);
  if (
    year < 100 ||
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  )
    return;
  date.setDate(date.getDate() + c.offsetDays);
  const [h, m] = c.time.split(":").map(Number);
  date.setHours(h!, m!, 0, 0);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
export function reminderTemplateLabel(
  text: string,
  schema: FormSchema,
): string {
  const fields = reminderFields(schema);
  return text.replace(
    /\{\{([^{}]+)\}\}/g,
    (_, id: string) =>
      `【${fields.find((f) => f.id === id.trim())?.label || "字段已失效"}】`,
  );
}
export function reminderOccurrence(
  c: ReminderConfig,
  version: number,
  values: FormValues,
): string | undefined {
  const date = reminderDueAt(c, values);
  return date ? JSON.stringify([version, c.id, date.toISOString()]) : undefined;
}
export function runReminder(
  c: ReminderConfig,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  context: {
    event?: PushEvent;
    now?: Date;
    entryId?: string;
    forceFailure?: boolean;
  } = {},
): ExtensionRun {
  const now = context.now || new Date();
  const run: ExtensionRun = {
    id: uid("run"),
    formId: "",
    subjectId: c.id,
    name: c.name || "推送提醒",
    kind: "reminder",
    time: new Date().toISOString(),
    status: "success",
    mode: "simulation",
    origin: "trial",
    event: context.event,
    entryId: context.entryId,
    input: {},
    output: {},
    mappedValues: {},
    steps: [],
    snapshot: { config: copy(c), schema: copy(schema), values: copy(values) },
  };
  const fail = (error: ConfigIssue, label: string) => {
    run.status = "failed";
    run.error = error;
    run.steps.push({ label, status: "failed", detail: error.message });
    return run;
  };
  const skip = (detail: string) => {
    run.status = "skipped";
    run.steps.push({ label: "判断触发条件", status: "skipped", detail });
    return run;
  };
  const issue = reminderIssues(c, schema)[0];
  if (issue) return fail(issue, "检查提醒配置");
  if (!Number.isFinite(now.getTime()))
    return fail(
      { step: 3, target: "reminder-test-time", message: "检查时间无效" },
      "计算提醒时间",
    );
  if (c.trigger === "event") {
    if (!context.event || !c.events.includes(context.event))
      return skip("这次数据事件不在所选触发范围内");
  } else {
    const due = reminderDueAt(c, values);
    run.input.checkedAt = now.toISOString();
    if (!due)
      return fail(
        {
          step: 3,
          target: "reminder-sample",
          message: "样本的日期为空或无效，请调整测试数据",
        },
        "计算提醒时间",
      );
    run.input.dueAt = due.toISOString();
    if (due.getTime() > now.getTime())
      return skip(`尚未到提醒时间：${due.toLocaleString("zh-CN")}`);
  }
  if (!matchesFilters(c.filters, values, values, data, "all", scopeFields(schema.fields)))
    return skip("记录未满足全部筛选条件");
  run.steps.push({
    label: "判断触发条件",
    status: "success",
    detail: "触发时间或事件及筛选条件均满足",
  });
  const recipients = reminderRecipients(c, values, data);
  if (!recipients.length)
    return fail(
      {
        step: 1,
        target: "reminder-recipients",
        message: "接收范围内没有在职成员，请检查选择范围或字段值",
      },
      "解析接收人",
    );
  run.input.recipients = recipients.map((r) => ({ id: r.id, name: r.name }));
  run.input.channel = reminderChannels[c.channel];
  run.input.title = renderReminderText(c.title, schema, values, data);
  run.input.message = renderReminderText(c.message, schema, values, data);
  run.steps.push({
    label: "组装消息",
    status: "success",
    detail: `已去重并解析 ${recipients.length} 位在职成员；字段已替换为显示内容`,
  });
  if (context.forceFailure)
    return fail(
      {
        step: 3,
        target: "reminder-scenario",
        message: "模拟消息通道失败，可切换正常场景重新测试",
      },
      "模拟消息通道",
    );
  run.output = {
    count: recipients.length,
    message: "模拟提醒成功；未发送真实消息",
  };
  run.steps.push({
    label: "模拟消息通道",
    status: "success",
    detail: `${reminderChannels[c.channel]}使用本地模拟，没有向成员发送消息`,
  });
  return run;
}
