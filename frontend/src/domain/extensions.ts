import { hasFieldValue, isNumericField } from "@platform/contracts";
import {
  parseQuickFill,
  quickFillDesignSchema,
  quickFillIssues,
  type QuickFillConfig,
} from "./quickFill";
import {
  parseAutomations,
  automationIssues,
  automationReferences,
  type AutomationConfig,
} from "./automation";
import {
  parseCollaboration,
  collaborationIssues,
  type CollaborationSettings,
} from "./collaboration";
import {
  parseButtons,
  buttonIssues,
  buttonReferences,
  type CustomButton,
} from "./buttons";
import {
  parseReminders,
  reminderIssues,
  reminderReferences,
  type ReminderConfig,
} from "./reminders";
import {
  parseDetailSettings,
  parsePrintTemplates,
  presentationIssues,
  printTemplateIssues,
  printTemplateReferences,
  type PrintTemplate,
  type DetailSettings,
} from "./presentation";
import {
  copy,
  defaultValues,
  uid,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { parseFilters, type DataFilter } from "./fieldConfig";
import { matchesFilters, scopeFields } from "./relations";
import type { WorkspaceData, FormRecord } from "./workspace";
import type {
  ValueBinding,
  PluginInvocation,
  FrontendRequest,
  FrontendDataSelection,
} from "@platform/contracts";
export type { ValueBinding, PluginInvocation } from "@platform/contracts";
import { resolveIdentities } from "./organization";

import { pushEvents, type PushEvent, type AutomationEvent } from "./events";
export { pushEvents, type PushEvent } from "./events";
/** 配置预览只需要凭证标识，浏览器不生成或保存推送密钥。 */
export interface WebhookCredential {
  id: string;
}
export interface WebhookConfig {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  events: PushEvent[];
  filters: DataFilter[];
  url: string;
  credentialRef: string;
  fieldIds: string[];
  note: string;
}
export interface FormExtensions {
  quickFill?: QuickFillConfig;
  automations?: AutomationConfig[];
  collaboration?: CollaborationSettings;
  webhooks: WebhookConfig[];
  reminders?: ReminderConfig[];
  buttons?: CustomButton[];
  printTemplates?: PrintTemplate[];
  detail?: DetailSettings;
}
export type ValueType = "text" | "number" | "json" | "members";
export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  mode: "local" | "simulation";
  inputs: { key: string; label: string; type: ValueType; hint: string }[];
  outputs: { key: string; label: string; type: ValueType }[];
}
export const pluginRegistry: PluginDefinition[] = [
  {
    id: "webhook",
    name: "发送 HTTP 请求",
    description: "将流程数据发送至业务系统，并接收处理结果",
    icon: "link",
    mode: "simulation",
    inputs: [
      {
        key: "url",
        label: "请求地址",
        type: "text",
        hint: "https://example.com/api/orders",
      },
      {
        key: "body",
        label: "请求内容",
        type: "json",
        hint: "输入 JSON，或选择一个字段作为内容",
      },
    ],
    outputs: [
      { key: "statusCode", label: "响应状态码", type: "number" },
      { key: "message", label: "响应说明", type: "text" },
    ],
  },
  {
    id: "notification",
    name: "通知成员",
    description: "向指定成员发送包含表单信息的消息",
    icon: "bell",
    mode: "simulation",
    inputs: [
      {
        key: "recipients",
        label: "接收成员",
        type: "members",
        hint: "选择成员、部门或角色",
      },
      {
        key: "message",
        label: "消息内容",
        type: "text",
        hint: "支持插入表单字段",
      },
    ],
    outputs: [
      { key: "count", label: "接收人数", type: "number" },
      { key: "message", label: "处理说明", type: "text" },
    ],
  },
  {
    id: "multiply",
    name: "计算金额",
    description: "用数量乘以单价，将结果写回金额字段",
    icon: "calculator",
    mode: "local",
    inputs: [
      {
        key: "quantity",
        label: "数量",
        type: "number",
        hint: "选择数量字段或输入数字",
      },
      {
        key: "price",
        label: "单价",
        type: "number",
        hint: "选择单价字段或输入数字",
      },
    ],
    outputs: [{ key: "amount", label: "计算金额", type: "number" }],
  },
  {
    id: "update",
    name: "组合文本并回填",
    description: "将固定文字与字段内容组合，写回指定字段",
    icon: "document",
    mode: "local",
    inputs: [
      {
        key: "text",
        label: "文本内容",
        type: "text",
        hint: "例如：采购单 · {{字段ID}}",
      },
    ],
    outputs: [{ key: "value", label: "组合结果", type: "text" }],
  },
];
export interface ConfigIssue {
  step: number;
  target: string;
  message: string;
}
export interface RunStep {
  label: string;
  status: "success" | "failed" | "skipped";
  detail: string;
}
export interface ExtensionRun {
  id: string;
  formId: string;
  subjectId: string;
  name: string;
  kind: "webhook" | "plugin" | "reminder" | "automation";
  time: string;
  status: "success" | "failed" | "skipped";
  mode: "local" | "simulation";
  origin: "trial" | "record" | "schedule";
  event?: AutomationEvent;
  entryId?: string;
  retryOf?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  mappedValues: FormValues;
  steps: RunStep[];
  error?: ConfigIssue;
  snapshot: {
    config:
      | WebhookConfig
      | PluginInvocation
      | ReminderConfig
      | AutomationConfig
      | FrontendRequest
      | FrontendDataSelection;
    schema: FormSchema;
    values: FormValues;
  };
}
const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string"))]
    : [];
const safeKey = (s: string) =>
  !["__proto__", "constructor", "prototype"].includes(s);
export function newWebhook(): WebhookConfig {
  return {
    id: uid("push"),
    name: "",
    enabled: false,
    archived: false,
    events: ["data_create"],
    filters: [],
    url: "",
    credentialRef: "",
    fieldIds: [],
    note: "",
  };
}
export function parseExtensions(raw: any): FormExtensions {
  const seen = new Set<string>();
  return {
    ...(raw?.quickFill !== undefined
      ? { quickFill: parseQuickFill(raw.quickFill) }
      : {}),
    ...(raw?.automations !== undefined
      ? { automations: parseAutomations(raw.automations) }
      : {}),
    ...(raw?.collaboration !== undefined
      ? { collaboration: parseCollaboration(raw.collaboration) }
      : {}),
    ...(raw?.buttons !== undefined
      ? { buttons: parseButtons(raw.buttons) }
      : {}),
    ...(raw?.reminders !== undefined
      ? { reminders: parseReminders(raw.reminders) }
      : {}),
    ...(raw?.printTemplates !== undefined
      ? { printTemplates: parsePrintTemplates(raw.printTemplates) }
      : {}),
    ...(raw?.detail !== undefined
      ? { detail: parseDetailSettings(raw.detail) }
      : {}),
    webhooks: (Array.isArray(raw?.webhooks) ? raw.webhooks : [])
      .slice(0, 100)
      .map((c: any) => {
        if (!c || typeof c.id !== "string" || seen.has(c.id))
          throw Error("数据推送 ID 无效或重复");
        seen.add(c.id);
        return {
          id: c.id,
          name: String(c.name || ""),
          enabled: c.enabled === true,
          archived: c.archived === true,
          events: strings(c.events).filter((e): e is PushEvent =>
            Object.hasOwn(pushEvents, e),
          ),
          filters: parseFilters(c.filters),
          url: String(c.url || ""),
          credentialRef: String(c.credentialRef || ""),
          fieldIds: strings(c.fieldIds),
          note: String(c.note || ""),
        };
      }),
  };
}
export function newInvocation(actionId = ""): PluginInvocation {
  const def = pluginRegistry.find((p) => p.id === actionId);
  return {
    actionId,
    inputs: Object.fromEntries(
      (def?.inputs || []).map((p) => [
        p.key,
        { source: "constant", value: p.type === "json" ? "{}" : "" },
      ]),
    ),
    outputs: [],
  };
}
export function parseInvocation(raw: any, legacy = ""): PluginInvocation {
  const config = newInvocation(
    typeof raw?.actionId === "string" ? raw.actionId : legacy,
  );
  for (const [key, value] of Object.entries(raw?.inputs || {})) {
    const b = value as any;
    if (
      safeKey(key) &&
      b &&
      ["constant", "field", "template"].includes(b.source) &&
      typeof b.value === "string"
    )
      config.inputs[key] = { source: b.source, value: b.value };
  }
  config.outputs = Array.isArray(raw?.outputs)
    ? raw.outputs
        .filter(
          (m: any) =>
            typeof m?.outputKey === "string" &&
            safeKey(m.outputKey) &&
            typeof m.fieldId === "string" &&
            safeKey(m.fieldId),
        )
        .map((m: any) => ({ outputKey: m.outputKey, fieldId: m.fieldId }))
    : [];
  return config;
}
export function configurableFields(schema: FormSchema): FormField[] {
  return scopeFields(schema.fields).filter(hasFieldValue);
}
export function fieldValueType(f: FormField): ValueType {
  if (isNumericField(f)) return "number";
  if (["member", "members", "department", "departments"].includes(f.type))
    return "members";
  if (
    [
      "subform",
      "relationTable",
      "checkbox",
      "multiselect",
      "image",
      "file",
      "address",
      "location",
    ].includes(f.type)
  )
    return "json";
  return "text";
}
export function compatibleField(f: FormField, type: ValueType, output = false) {
  if (!hasFieldValue(f)) return false;
  if (
    output &&
    [
      "calculated",
      "serial",
      "query",
      "lookup",
      "relation",
      "relationTable",
      "subform",
    ].includes(f.type)
  )
    return false;
  if (output)
    return type === "number"
      ? f.type === "number"
      : type === "text"
        ? ["text", "textarea"].includes(f.type)
        : false;
  return (
    type === "json" ||
    (type === "text" && ["text", "number"].includes(fieldValueType(f))) ||
    fieldValueType(f) === type
  );
}
export function bindingReferences(binding: ValueBinding): string[] {
  return binding.source === "field"
    ? [binding.value]
    : binding.source === "template"
      ? [...binding.value.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) =>
          m[1]!.trim(),
        )
      : [];
}
function print(v: unknown): string {
  return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}
export function resolveBinding(
  binding: ValueBinding,
  values: FormValues,
  type: ValueType,
): unknown {
  const raw =
    binding.source === "field"
      ? values[binding.value]
      : binding.source === "template"
        ? binding.value.replace(/\{\{([^{}]+)\}\}/g, (_, id: string) =>
            print(values[id.trim()]),
          )
        : binding.value;
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && !raw.trim())
  )
    throw Error("输入值为空");
  if (type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || Array.isArray(raw) || typeof raw === "object")
      throw Error("需要有效数字");
    return n;
  }
  if (type === "json") {
    if (typeof raw !== "string") return copy(raw);
    try {
      return JSON.parse(raw);
    } catch {
      throw Error("请求内容不是有效 JSON");
    }
  }
  if (type === "members") {
    if (Array.isArray(raw)) return raw;
    return String(raw)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return print(raw);
}
export function validEndpoint(url: string) {
  try {
    const u = new URL(url);
    return (
      ["https:", "http:"].includes(u.protocol) &&
      !!u.hostname &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function validateWebhook(
  config: WebhookConfig,
  schema: FormSchema,
  credentials?: WebhookCredential[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [],
    ids = new Set(configurableFields(schema).map((f) => f.id));
  if (!config.name.trim())
    issues.push({ step: 0, target: "push-name", message: "请填写推送名称" });
  if (!config.events.length)
    issues.push({ step: 0, target: "events", message: "至少选择一种触发事件" });
  config.filters.forEach((f) => {
    if (
      !ids.has(f.sourceFieldId) ||
      (f.source === "field" && !ids.has(f.value))
    )
      issues.push({
        step: 0,
        target: "filters",
        message: "筛选条件引用了不存在的字段，请重新选择",
      });
  });
  if (!validEndpoint(config.url))
    issues.push({
      step: 1,
      target: "push-url",
      message: "请输入完整的 HTTP 或 HTTPS 地址，不包含账号密码",
    });
  if (
    !config.credentialRef ||
    config.credentialRef === "demo-signature" ||
    (credentials && !credentials.some((c) => c.id === config.credentialRef))
  )
    issues.push({
      step: 1,
      target: "credential",
      message: "请在此处生成 Secret；旧演示凭证不能用于签名校验",
    });
  if (!config.fieldIds.length)
    issues.push({
      step: 2,
      target: "payload-fields",
      message: "至少选择一个发送字段",
    });
  if (config.fieldIds.some((id) => !ids.has(id)))
    issues.push({
      step: 2,
      target: "payload-fields",
      message: "发送字段已被删除，请移除失效引用或恢复字段",
    });
  return issues;
}
export function validateInvocation(
  config: PluginInvocation,
  schema: FormSchema,
): ConfigIssue[] {
  const def = pluginRegistry.find((p) => p.id === config.actionId),
    fields = configurableFields(schema),
    issues: ConfigIssue[] = [];
  if (!def)
    return [{ step: 0, target: "action", message: "请选择一个可用动作" }];
  for (const p of def.inputs) {
    const binding = config.inputs[p.key];
    let error = "";
    if (!binding?.value.trim()) error = "请配置输入值";
    else if (
      bindingReferences(binding).some((id) => !fields.some((f) => f.id === id))
    )
      error = "引用字段不存在";
    else if (
      binding.source === "field" &&
      !compatibleField(
        fields.find((f) => f.id === binding.value)!,
        p.type,
      )
    )
      error = "字段类型不兼容";
    else if (binding.source === "constant") {
      try {
        resolveBinding(binding, {}, p.type);
        if (p.key === "url" && !validEndpoint(binding.value))
          error = "请求地址无效";
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error)
      issues.push({
        step: 1,
        target: `input-${p.key}`,
        message: `${p.label}：${error}`,
      });
  }
  const targets = new Set<string>();
  for (const m of config.outputs) {
    const output = def.outputs.find((o) => o.key === m.outputKey),
      field = fields.find((f) => f.id === m.fieldId);
    if (!output || !field || !compatibleField(field, output.type, true))
      issues.push({
        step: 2,
        target: "output-mapping",
        message: "回填字段不存在或类型不兼容，请重新选择",
      });
    if (targets.has(m.fieldId))
      issues.push({
        step: 2,
        target: "output-mapping",
        message: "同一字段不能同时接收多个返回值",
      });
    targets.add(m.fieldId);
  }
  if (def.mode === "local" && !config.outputs.length)
    issues.push({
      step: 2,
      target: "output-mapping",
      message: "请设置至少一个结果回填字段",
    });
  return issues;
}
export function sampleValues(schema: FormSchema): FormValues {
  const values = defaultValues(schema.fields);
  for (const f of configurableFields(schema)) {
    const value = values[f.id];
    if (
      value !== "" &&
      value != null &&
      !(Array.isArray(value) && !value.length)
    )
      continue;
    values[f.id] =
      f.type === "number"
        ? 100
        : f.type === "datetime"
          ? new Date().toISOString().slice(0, 10)
          : f.options.length
            ? ["multiselect", "checkbox"].includes(f.type)
              ? [f.options[0]!.id]
              : f.options[0]!.id
            : ["member", "members", "department", "departments"].includes(
                  f.type,
                )
              ? ""
              : fieldValueType(f) === "json"
                ? []
                : `示例${f.label}`;
  }
  return values;
}
export function webhookPayload(
  config: WebhookConfig,
  values: FormValues,
  event: PushEvent,
  entryId = "example-record",
) {
  return {
    op: event,
    opTime: Date.now(),
    data:
      event === "data_remove"
        ? { _id: entryId }
        : {
            _id: entryId,
            ...Object.fromEntries(
              config.fieldIds
                .filter(safeKey)
                .map((id) => [id, copy(values[id] ?? null)]),
            ),
          },
  };
}
function baseRun(
  kind: ExtensionRun["kind"],
  subjectId: string,
  name: string,
  config: WebhookConfig | PluginInvocation,
  schema: FormSchema,
  values: FormValues,
): ExtensionRun {
  return {
    id: uid("run"),
    formId: "",
    subjectId,
    name,
    kind,
    time: new Date().toISOString(),
    status: "success",
    mode: "simulation",
    origin: "trial",
    input: {},
    output: {},
    mappedValues: {},
    steps: [],
    snapshot: copy({ config, schema, values }),
  };
}
function fail(run: ExtensionRun, issue: ConfigIssue, label: string) {
  run.status = "failed";
  run.error = issue;
  run.steps.push({ label, status: "failed", detail: issue.message });
  return run;
}
export function runWebhook(
  config: WebhookConfig,
  schema: FormSchema,
  values: FormValues,
  event: PushEvent,
  data: WorkspaceData,
  forceFailure = false,
  entryId?: string,
): ExtensionRun {
  const run = baseRun(
    "webhook",
    config.id,
    config.name,
    config,
    schema,
    values,
  );
  run.event = event;
  run.entryId = entryId;
  const issue = validateWebhook(
    config,
    schema,
    data.webhookCredentials || [],
  )[0];
  if (issue) return fail(run, issue, "检查配置");
  if (
    !config.events.includes(event) ||
    !matchesFilters(config.filters, values, values, data, "all", scopeFields(schema.fields))
  ) {
    run.status = "skipped";
    run.steps.push({
      label: "判断触发条件",
      status: "skipped",
      detail: "事件或筛选条件不匹配，本次不推送",
    });
    return run;
  }
  run.steps.push({
    label: "判断触发条件",
    status: "success",
    detail: `${pushEvents[event]}，符合全部筛选条件`,
  });
  run.input = {
    method: "POST",
    url: config.url,
    credentialRef: config.credentialRef,
    body: webhookPayload(config, values, event, entryId),
  };
  run.steps.push({
    label: "生成请求内容",
    status: "success",
    detail:
      event === "data_remove"
        ? "删除事件只发送记录标识"
        : `包含 ${config.fieldIds.length} 个业务字段`,
  });
  if (forceFailure)
    return fail(
      run,
      {
        step: 3,
        target: "test-scenario",
        message: "模拟目标服务器超时。未发送网络请求，可切换成功场景后重试。",
      },
      "模拟服务器响应",
    );
  run.output = { statusCode: 200, message: "模拟接收成功" };
  run.steps.push({
    label: "模拟服务器响应",
    status: "success",
    detail: "模拟 HTTP 200；未向外部服务器发送数据",
  });
  return run;
}
export function runPlugin(
  config: PluginInvocation,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  forceFailure = false,
  nodeId = "",
): ExtensionRun {
  const def = pluginRegistry.find((p) => p.id === config.actionId),
    run = baseRun(
      "plugin",
      nodeId,
      def?.name || "插件动作",
      config,
      schema,
      values,
    );
  run.mode = def?.mode || "simulation";
  const issue = validateInvocation(config, schema)[0];
  if (issue) return fail(run, issue, "检查配置");
  for (const p of def!.inputs) {
    try {
      run.input[p.key] = resolveBinding(config.inputs[p.key]!, values, p.type);
    } catch (e) {
      return fail(
        run,
        {
          step: 1,
          target: `input-${p.key}`,
          message: `${p.label}：${(e as Error).message}`,
        },
        "读取输入参数",
      );
    }
  }
  if (config.actionId === "webhook" && !validEndpoint(String(run.input.url)))
    return fail(
      run,
      { step: 1, target: "input-url", message: "解析后的请求地址无效" },
      "检查请求地址",
    );
  if (config.actionId === "notification") {
    const recipients = resolveIdentities(
      data.organization,
      run.input.recipients as string[],
    );
    if (!recipients.length)
      return fail(
        run,
        {
          step: 1,
          target: "input-recipients",
          message: "接收范围内没有在职成员",
        },
        "解析接收成员",
      );
    run.input.recipients = recipients;
  }
  run.steps.push({
    label: "读取输入参数",
    status: "success",
    detail: `已解析 ${def!.inputs.length} 个参数`,
  });
  if (forceFailure)
    return fail(
      run,
      {
        step: 3,
        target: "test-scenario",
        message: "已模拟执行失败；未回填任何字段。可切换成功场景重试。",
      },
      "执行动作",
    );
  if (config.actionId === "multiply") {
    const amount =
      Math.round(Number(run.input.quantity) * Number(run.input.price) * 100) /
      100;
    if (!Number.isFinite(amount))
      return fail(
        run,
        {
          step: 1,
          target: "input-quantity",
          message: "计算结果超出有效数字范围",
        },
        "计算金额",
      );
    run.output = { amount };
  } else if (config.actionId === "update")
    run.output = { value: run.input.text };
  else if (config.actionId === "notification")
    run.output = {
      count: (run.input.recipients as string[]).length,
      message: "模拟通知成功",
    };
  else run.output = { statusCode: 200, message: "模拟接收成功" };
  run.steps.push({
    label: "执行动作",
    status: "success",
    detail:
      run.mode === "local"
        ? "已在本地完成运算"
        : "外部响应使用模拟结果，未发送请求或消息",
  });
  for (const mapping of config.outputs)
    run.mappedValues[mapping.fieldId] = copy(run.output[mapping.outputKey]);
  run.steps.push({
    label: "结果回填",
    status: "success",
    detail: config.outputs.length
      ? `${config.outputs.length} 个字段可回填；试运行不修改原始记录`
      : "无需回填，继续下一节点",
  });
  return run;
}
export function extensionIssues(
  form: FormRecord,
  credentials?: WebhookCredential[],
  data?: WorkspaceData,
): ConfigIssue[] {
  const issues = (form.extensions?.webhooks || [])
    .filter((c) => c.enabled && !c.archived)
    .flatMap((c) =>
      validateWebhook(c, form.schema, credentials).map((i) => ({
        ...i,
        message: `${c.name || "数据推送"}：${i.message}`,
      })),
    );
  if (form.extensions?.quickFill?.enabled)
    issues.push(
      ...quickFillIssues(
        form.extensions.quickFill,
        quickFillDesignSchema(form),
      ).map((message) => ({
        step: 0,
        target: "quickFill",
        message: `AI 快捷填报：${message}`,
      })),
    );
  if (form.extensions?.collaboration)
    issues.push(
      ...collaborationIssues(form.extensions.collaboration, form.schema).map(
        (message) => ({
          step: 0,
          target: "collaboration",
          message: `数据协作：${message}`,
        }),
      ),
    );
  for (const c of form.extensions?.automations || [])
    if (c.enabled && !c.archived)
      issues.push(
        ...automationIssues(c, form.schema, data).map((i) => ({
          ...i,
          message: `智能助手「${c.name}」：${i.message}`,
        })),
      );
  for (const c of form.extensions?.buttons || [])
    if (c.enabled && !c.archived)
      issues.push(
        ...buttonIssues(c, form.schema, data).map((i) => ({
          ...i,
          message: `按钮「${c.name}」：${i.message}`,
        })),
      );
  for (const c of form.extensions?.reminders || [])
    if (c.enabled && !c.archived)
      issues.push(
        ...reminderIssues(c, form.schema).map((i) => ({
          ...i,
          message: `提醒「${c.name}」：${i.message}`,
        })),
      );
  for (const n of form.workflow.nodes.filter((n) => n.data.kind === "plugin"))
    issues.push(
      ...validateInvocation(
        n.data.pluginConfig || newInvocation(n.data.plugin),
        form.schema,
      ).map((i) => ({ ...i, message: `${n.data.label}：${i.message}` })),
    );
  for (const c of form.extensions?.printTemplates || [])
    if (!c.archived)
      issues.push(
        ...printTemplateIssues(c, form.schema, data).map((message) => ({
          step: 0,
          target: "print",
          message: `打印模板「${c.name}」：${message}`,
        })),
      );
  if (form.extensions?.detail)
    issues.push(
      ...presentationIssues(form.extensions.detail, form.schema).map(
        (message) => ({
          step: 0,
          target: "detail",
          message: `数据详情：${message}`,
        }),
      ),
    );
  return issues;
}
export function fieldExtensionImpacts(
  form: FormRecord,
  ids: string[],
): string[] {
  const set = new Set(ids),
    uses = (b: ValueBinding) => bindingReferences(b).some((id) => set.has(id)),
    result: string[] = [];
  if (form.extensions?.quickFill?.fields.some((f) => set.has(f.fieldId)))
    result.push("AI 快捷填报的目标字段");
  if (
    form.extensions?.collaboration?.titleMode === "custom" &&
    form.extensions.collaboration.titleParts.some(
      (p) => p.kind === "field" && set.has(p.value),
    )
  )
    result.push("数据标题的字段内容");
  for (const c of form.extensions?.automations || [])
    if (!c.archived && automationReferences(c).some((id) => set.has(id)))
      result.push(`智能助手「${c.name}」的触发条件或来源映射`);
  for (const c of form.extensions?.buttons || [])
    if (!c.archived && buttonReferences(c).some((id) => set.has(id)))
      result.push(`按钮「${c.name}」的显示条件、参数或更新字段`);
  for (const c of form.extensions?.reminders || [])
    if (!c.archived && reminderReferences(c).some((id) => set.has(id)))
      result.push(`提醒「${c.name}」的触发条件、接收人或消息内容`);
  for (const c of form.extensions?.webhooks || [])
    if (
      !c.archived &&
      (c.fieldIds.some((id) => set.has(id)) ||
        c.filters.some(
          (f) =>
            set.has(f.sourceFieldId) ||
            (f.source === "field" && set.has(f.value)),
        ))
    )
      result.push(`数据推送「${c.name}」的发送内容或条件`);
  for (const n of form.workflow.nodes) {
    const c = n.data.pluginConfig;
    if (
      n.data.kind === "plugin" &&
      c &&
      (Object.values(c.inputs).some(uses) ||
        c.outputs.some((m) => set.has(m.fieldId)))
    )
      result.push(`插件节点「${n.data.label}」的输入或回填`);
  }
  for (const c of form.extensions?.printTemplates || [])
    if (
      !c.archived &&
      printTemplateReferences(c, form.schema).some((id) => set.has(id))
    )
      result.push(
        `打印模板「${c.name}」的展示字段${c.fileName?.mode === "custom" ? "或文件名称" : ""}`,
      );
  if (
    form.extensions?.detail?.fieldMode === "custom" &&
    form.extensions.detail.fieldIds.some((id) => set.has(id))
  )
    result.push("数据详情的展示字段");
  return result;
}
