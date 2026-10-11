import { allocateSerialValues } from "./serial";
import { automationEvents, type AutomationEvent } from "./events";
export { automationEvents, type AutomationEvent } from "./events";
import {
  copy,
  uid,
  prepareSubmission,
  validateValues,
  type FormSchema,
  type FormValues,
} from "./form";
import { parseFilters, type DataFilter } from "./fieldConfig";
import {
  buttonSources,
  buttonTargets,
  mapFieldValues,
  type ButtonMapping,
} from "./buttons";
import {
  matchesFilters,
  runtimeDefaults,
  displayValue,
  resolveRuntimeValues,
} from "./relations";
import { validateDynamicValues } from "./fieldValidation";
import { blockingFormValidation } from "./formValidation";
import {
  advanceEntry,
  type WorkspaceData,
  type FormEntry,
  type FormRecord,
} from "./workspace";
import {
  runPlugin,
  newInvocation,
  type ConfigIssue,
  type ExtensionRun,
} from "./extensions";

export const automationActions = {
  create: "新增记录",
  update: "更新记录",
  upsert: "更新或新增",
} as const;
export interface AutomationStep {
  id: string;
  name: string;
  action: keyof typeof automationActions;
  targetFormId: string;
  targetVersion: number;
  filters: DataFilter[];
  allowAll: boolean;
  onNoMatch: "skip" | "fail";
  mappings: ButtonMapping[];
}
export interface AutomationConfig {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  events: AutomationEvent[];
  filters: DataFilter[];
  steps: AutomationStep[];
}
export interface AutomationChange {
  stepId: string;
  entryId: string;
  formId: string;
  formTitle: string;
  version: number;
  action: "create" | "update";
  fields: { id: string; label: string; before: string; after: string }[];
}
export function newAutomationStep(): AutomationStep {
  return {
    id: uid("action"),
    name: "",
    action: "create",
    targetFormId: "",
    targetVersion: 0,
    filters: [],
    allowAll: false,
    onNoMatch: "skip",
    mappings: [],
  };
}
export function newAutomation(): AutomationConfig {
  return {
    id: uid("automation"),
    name: "",
    enabled: true,
    archived: false,
    events: ["data_create"],
    filters: [],
    steps: [newAutomationStep()],
  };
}
const safeId = (v: unknown): v is string =>
  typeof v === "string" &&
  !!v &&
  !["__proto__", "constructor", "prototype"].includes(v);
const eventNames = Object.keys(automationEvents) as AutomationEvent[];
export function parseAutomations(raw: any): AutomationConfig[] {
  const ids = new Set<string>();
  return (Array.isArray(raw) ? raw : []).slice(0, 50).map((c: any) => {
    if (!safeId(c?.id) || ids.has(c.id)) throw Error("智能助手 ID 无效或重复");
    ids.add(c.id);
    const stepIds = new Set<string>();
    return {
      id: c.id,
      name: String(c.name || ""),
      enabled: c.enabled === true,
      archived: c.archived === true,
      events: [
        ...new Set<AutomationEvent>(
          (Array.isArray(c.events) ? c.events : []).filter(
            (e: AutomationEvent) => eventNames.includes(e),
          ),
        ),
      ],
      filters: parseFilters(c.filters),
      steps: (Array.isArray(c.steps) ? c.steps : [])
        .slice(0, 20)
        .map((s: any) => {
          if (!safeId(s?.id) || stepIds.has(s.id))
            throw Error("智能助手动作 ID 无效或重复");
          stepIds.add(s.id);
          return {
            id: s.id,
            name: String(s.name || ""),
            action: Object.hasOwn(automationActions, s.action)
              ? s.action
              : "create",
            targetFormId: String(s.targetFormId || ""),
            targetVersion:
              Number.isSafeInteger(s.targetVersion) && s.targetVersion > 0
                ? s.targetVersion
                : 0,
            filters: parseFilters(s.filters),
            allowAll: s.allowAll === true,
            onNoMatch: s.onNoMatch === "fail" ? "fail" : "skip",
            mappings: (Array.isArray(s.mappings) ? s.mappings : [])
              .slice(0, 100)
              .map((m: any) => ({
                targetId: String(m?.targetId || ""),
                source: m?.source === "field" ? "field" : "constant",
                fieldId: String(m?.fieldId || ""),
                value: copy(m?.value ?? ""),
              })),
          };
        }),
    };
  });
}
export function automationDefinition(
  form: FormRecord | undefined,
  version: number,
) {
  if (!form || form.archived) return;
  return (
    form.versions.find((v) => v.version === version) ||
    (form.published?.version === version ? form.published : undefined)
  );
}
export function automationReferences(c: AutomationConfig) {
  return [
    ...c.filters.flatMap((f) => [
      f.sourceFieldId,
      ...(f.source === "field" ? [f.value] : []),
    ]),
    ...c.steps.flatMap((s) => [
      ...s.filters.filter((f) => f.source === "field").map((f) => f.value),
      ...s.mappings.filter((m) => m.source === "field").map((m) => m.fieldId),
    ]),
  ];
}
export function automationIssues(
  c: AutomationConfig,
  schema: FormSchema,
  data?: WorkspaceData,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [],
    sourceIds = new Set(buttonSources(schema).map((f) => f.id));
  const fail = (step: number, target: string, message: string) =>
    issues.push({ step, target, message });
  if (!c.name.trim()) fail(0, "automation-name", "请填写助手名称");
  if (!c.events.length || c.events.some((e) => !eventNames.includes(e)))
    fail(0, "automation-events", "至少选择一种有效的触发事件");
  if (
    c.filters.some(
      (f) =>
        !sourceIds.has(f.sourceFieldId) ||
        (f.source === "field" && !sourceIds.has(f.value)),
    )
  )
    fail(0, "automation-filters", "触发条件引用了不存在的来源字段");
  if (!c.steps.length || c.steps.length > 20)
    fail(1, "automation-steps", "请配置 1 至 20 个动作");
  const stepIds = new Set<string>();
  for (const s of c.steps) {
    const target = `automation-step-${s.id}`;
    if (!safeId(s.id) || stepIds.has(s.id))
      fail(1, target, "动作 ID 无效或重复");
    stepIds.add(s.id);
    const definition = automationDefinition(
      data?.forms.find((f) => f.id === s.targetFormId),
      s.targetVersion,
    );
    if (!s.targetFormId || !s.targetVersion || (data && !definition))
      fail(1, target, "请选择未归档目标表单的有效发布版本");
    if (!Object.hasOwn(automationActions, s.action))
      fail(1, target, "请选择有效动作");
    if (s.action !== "create" && !s.filters.length && !s.allowAll)
      fail(1, target, "请设置目标筛选条件，或明确允许更新全部记录");
    const fields = definition ? buttonSources(definition.schema) : [],
      writable = new Set(
        definition ? buttonTargets(definition.schema).map((f) => f.id) : [],
      );
    if (
      s.action !== "create" &&
      s.filters.some(
        (f) =>
          (definition && !fields.some((t) => t.id === f.sourceFieldId)) ||
          (f.source === "field" && !sourceIds.has(f.value)),
      )
    )
      fail(1, target, "目标筛选条件引用的字段已失效");
    if (!s.mappings.length || s.mappings.length > 100)
      fail(1, target, "每个动作需设置 1 至 100 个字段映射");
    const mapped = new Set<string>();
    for (const m of s.mappings) {
      if (
        !safeId(m.targetId) ||
        mapped.has(m.targetId) ||
        (definition && !writable.has(m.targetId))
      )
        fail(1, target, "目标字段不可写、已失效或重复");
      if (m.source === "field" && !sourceIds.has(m.fieldId))
        fail(1, target, "映射的来源字段不存在");
      mapped.add(m.targetId);
    }
  }
  return issues;
}

/** Prepare an isolated transaction. The caller commits entries only after every action succeeds. */
export function prepareAutomation(
  config: AutomationConfig,
  schema: FormSchema,
  values: FormValues,
  event: AutomationEvent,
  data: WorkspaceData,
  options: {
    formId?: string;
    entryId?: string;
    actorId?: string;
    now?: Date;
    trial?: boolean;
  } = {},
): {
  run: ExtensionRun;
  entries: FormEntry[];
  changes: AutomationChange[];
  serialCounters?: WorkspaceData["serialCounters"];
} {
  const time = (options.now || new Date()).toISOString(),
    source = copy(values);
  const run: ExtensionRun = {
    id: uid("run"),
    formId: options.formId || "",
    subjectId: config.id,
    name: config.name || "智能助手",
    kind: "automation",
    time,
    status: "success",
    mode: "local",
    origin: "trial",
    event,
    entryId: options.entryId,
    input: { event, entryId: options.entryId || "试运行样本", values: source },
    output: {},
    mappedValues: {},
    steps: [],
    snapshot: { config: copy(config), schema: copy(schema), values: source },
  };
  const changes: AutomationChange[] = [],
    changedIds = new Set<string>();
  const fail = (issue: ConfigIssue, label: string) => {
    run.status = "failed";
    run.error = issue;
    run.steps.push({ label, status: "failed", detail: issue.message });
    run.output = {
      committed: false,
      rolledBack: changes.length,
      message: "本助手的整组目标变更均未写入",
    };
    return { run, entries: [], changes: [] };
  };
  const issue = automationIssues(config, schema, data)[0];
  if (issue) return fail(issue, "检查配置");
  if (
    (!options.trial && (!config.enabled || config.archived)) ||
    !config.events.includes(event) ||
    !matchesFilters(config.filters, source, source, data, "all", buttonSources(schema))
  ) {
    run.status = "skipped";
    run.steps.push({
      label: "检查触发条件",
      status: "skipped",
      detail: "当前事件、启用状态或数据不满足触发条件",
    });
    run.output = { committed: false, changes: [] };
    return { run, entries: [], changes: [] };
  }
  run.steps.push({
    label: "检查触发条件",
    status: "success",
    detail: "事件与全部触发条件匹配",
  });
  const staged: WorkspaceData = { ...data, entries: copy(data.entries) };
  for (let index = 0; index < config.steps.length; index++) {
    const step = config.steps[index]!,
      label = `${index + 1}. ${step.name || automationActions[step.action]}`;
    try {
      const form = staged.forms.find((f) => f.id === step.targetFormId)!,
        definition = automationDefinition(form, step.targetVersion)!;
      const pinned = buttonSources(definition.schema);
      const matching =
        step.action === "create"
          ? []
          : staged.entries.filter((e) => {
              if (e.formId !== form.id || e.deletedAt || e.status === "draft")
                return false;
              const actual = automationDefinition(form, e.definitionVersion);
              if (!actual) throw Error("目标记录所属版本不存在");
              const actualFields = buttonSources(actual.schema);
              for (const filter of step.filters) {
                const a = actualFields.find(
                    (f) => f.id === filter.sourceFieldId,
                  ),
                  b = pinned.find((f) => f.id === filter.sourceFieldId);
                if (!a || a.type !== b?.type)
                  throw Error(
                    "目标历史记录的筛选字段与选定版本不兼容，请限定到兼容的表单",
                  );
              }
              return matchesFilters(step.filters, e.values, source, staged, "all", pinned, actualFields, buttonSources(schema));
            });
      if (matching.length > 200)
        throw Error("单个动作最多更新 200 条记录，请缩小筛选范围");
      if (!matching.length && step.action === "update") {
        if (step.onNoMatch === "fail")
          throw Error("没有找到符合条件的目标记录");
        run.steps.push({
          label,
          status: "skipped",
          detail: "未找到匹配记录，按配置跳过",
        });
        continue;
      }
      const creating =
        step.action === "create" ||
        (step.action === "upsert" && !matching.length);
      const actor = options.actorId || staged.organization.currentUserId;
      const targets: FormEntry[] = creating
        ? [
            {
              id: uid("entry"),
              formId: form.id,
              definitionVersion: definition.version,
              values: runtimeDefaults(definition.schema.fields, staged),
              createdAt: time,
              createdBy: actor,
              createdDepartmentIds: [
                ...(staged.organization.employees.find((e) => e.id === actor)
                  ?.departmentIds || []),
              ],
              status: "submitted",
              history: [],
            },
          ]
        : matching;
      let changed = 0;
      for (const entry of targets) {
        if (changes.length >= 500)
          throw Error("一组助手动作最多变更 500 条记录，请拆分规则");
        const actual = automationDefinition(form, entry.definitionVersion)!;
        const actualTargets = buttonTargets(actual.schema);
        for (const m of step.mappings) {
          if (
            !actualTargets.some(
              (f) =>
                f.id === m.targetId &&
                f.type === pinned.find((p) => p.id === m.targetId)?.type,
            )
          )
            throw Error("目标记录所属版本的映射字段不可写或类型不兼容");
        }
        const before = copy(entry.values);
        const mapped = mapFieldValues(
          step.mappings,
          schema,
          source,
          actual.schema,
          before,
          staged,
        );
        if (mapped.status !== "ready" || !mapped.values)
          throw Error(mapped.message);
        mapped.values = resolveRuntimeValues(
          actual.schema,
          mapped.values,
          staged,
          creating ? {} : before,
        );
        const others = () =>
          staged.entries
            .filter(
              (e) =>
                e.formId === form.id &&
                e.id !== entry.id &&
                !e.deletedAt &&
                e.status !== "draft",
            )
            .map((e) => e.values);
        const validate = (v: FormValues) => {
          const errors = [
            ...validateValues(actual.schema, v, others()),
            ...validateDynamicValues(actual.schema, v, staged),
          ];
          if (errors.length) throw Error(errors[0]!.message);
          if (form.kind !== "workflow") {
            const issue = blockingFormValidation(
              actual.schema,
              prepareSubmission(actual.schema, v, creating ? {} : before, true),
              { data: staged },
            )[0];
            if (issue) throw Error(issue);
          }
        };
        validate(mapped.values);
        entry.values = prepareSubmission(
          actual.schema,
          mapped.values,
          creating ? {} : before,
          true,
        );
        if (creating) {
          const allocation = allocateSerialValues(
            actual.schema,
            entry.values,
            staged,
            form.id,
            new Date(time),
          );
          entry.values = allocation.values;
          staged.serialCounters = allocation.counters;
        }
        if (creating && form.kind === "workflow") {
          advanceEntry(entry, actual.workflow, "start", (node, nodeValues) => {
            const result = runPlugin(
              node.data.pluginConfig || newInvocation(node.data.plugin),
              actual.schema,
              nodeValues,
              staged,
              false,
              node.id,
            );
            run.steps.push({
              label: `${label} · 流程插件「${node.data.label}」`,
              status: result.status,
              detail:
                result.error?.message ||
                (result.mode === "simulation"
                  ? "模拟外部响应，未发送网络请求或消息"
                  : "目标流程插件已在本地运算并回填"),
            });
            return result;
          });
          if (entry.pluginError)
            throw Error(`目标流程无法启动：${entry.pluginError}`);
          validate(entry.values);
        }
        if (
          !creating &&
          JSON.stringify(before) === JSON.stringify(entry.values)
        )
          continue;
        entry.updatedAt = time;
        entry.history.push({
          label: `智能助手「${config.name}」`,
          action: `${creating ? "新增" : "更新"}记录 · ${label}`,
          time,
        });
        if (creating) staged.entries.unshift(entry);
        changedIds.add(entry.id);
        changed++;
        changes.push({
          stepId: step.id,
          entryId: entry.id,
          formId: form.id,
          formTitle: actual.title,
          version: actual.version,
          action: creating ? "create" : "update",
          fields: buttonSources(actual.schema)
            .filter((f) =>
              creating
                ? entry.values[f.id] !== undefined
                : JSON.stringify(before[f.id]) !==
                  JSON.stringify(entry.values[f.id]),
            )
            .map((f) => ({
              id: f.id,
              label: f.label,
              before: creating ? "—" : displayValue(f, before[f.id], staged),
              after: displayValue(f, entry.values[f.id], staged),
            })),
        });
      }
      run.steps.push({
        label,
        status: "success",
        detail: `${form.title} · ${creating ? "新增" : "匹配"} ${targets.length} 条，${changed} 条产生变更`,
      });
    } catch (error) {
      return fail(
        {
          step: 1,
          target: `automation-step-${step.id}`,
          message: error instanceof Error ? error.message : "动作执行失败",
        },
        label,
      );
    }
  }
  run.output = { committed: false, affected: changedIds.size, changes };
  run.steps.push({
    label: "整组变更检查",
    status: "success",
    detail: `${changedIds.size} 条记录可写入；试运行不改变记录，正式事件将整组保存`,
  });
  return {
    run,
    entries: staged.entries.filter((e) => changedIds.has(e.id)),
    changes,
    serialCounters: staged.serialCounters,
  };
}
