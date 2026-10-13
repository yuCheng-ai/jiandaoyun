import type { ProcessSpec, TaskSpec } from "./index";
import type { AssigneeSelector } from "./organization";

export interface ProcessBindingSpec {
  id: string;
  title: string;
  definitionId: string;
  definitionVersion: number;
}
export interface ProcessTemplateTask {
  id: string;
  title: string;
  kind?: "approval" | "copy";
  fieldPermissions?: Record<string, "edit" | "read" | "hidden">;
  position?: { x: number; y: number };
  recordBinding: string;
  assigneeId: string;
  assigneeSelector?: AssigneeSelector;
  pageId: string;
  pageVersion: number;
  subformId?: string;
  dependsOn: string[];
  requiredFields: string[];
  waitFor?: {
    recordBinding: string;
    fieldId: string;
    subformId?: string;
    equals: string | number | boolean | string[];
  };
}
export interface ProcessTemplateSpec {
  title: string;
  bindings: ProcessBindingSpec[];
  tasks: ProcessTemplateTask[];
  // 起止连线由用户明确指定；未配置表示未连线，不从任务依赖推断。
  startTaskIds?: string[];
  endTaskIds?: string[];
  // 画布位置不参与流转判断。
  layout?: { start?: { x: number; y: number }; end?: { x: number; y: number } };
}

/** 发布前检查所有节点都位于“发起 → 结束”的路径上，前后端共用。 */
export function processTemplateConnectionError(
  spec: ProcessTemplateSpec,
): string {
  if (!spec.tasks.length) return "请先添加流程节点，并连接发起节点与结束节点。";
  const tasks = new Map(spec.tasks.map((task) => [task.id, task]));
  const next = new Map(spec.tasks.map((task) => [task.id, [] as string[]]));
  const previous = new Map(spec.tasks.map((task) => [task.id, task.dependsOn]));
  const starts = spec.startTaskIds || [];
  const ends = spec.endTaskIds || [];
  if ([...starts, ...ends].some((id) => !tasks.has(id))) {
    return "起止连线引用了不存在的节点，请重新连接。";
  }
  for (const task of spec.tasks) {
    for (const source of task.dependsOn) {
      if (!tasks.has(source))
        return `「${task.title}」引用了不存在的前置节点。`;
      next.get(source)!.push(task.id);
    }
  }
  function reachable(roots: string[], links: Map<string, string[]>) {
    const visited = new Set<string>();
    const pending = [...roots];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(links.get(id) || []));
    }
    return visited;
  }
  const fromStart = reachable(starts, next);
  const toEnd = reachable(ends, previous);
  const withoutStart = spec.tasks.filter((task) => !fromStart.has(task.id));
  if (withoutStart.length) {
    return `「${withoutStart.map((task) => task.title).join("、")}」未接入流程发起节点，请补齐连线后启用。`;
  }
  const withoutEnd = spec.tasks.filter((task) => !toEnd.has(task.id));
  if (withoutEnd.length) {
    return `「${withoutEnd.map((task) => task.title).join("、")}」无法到达流程结束节点，请补齐连线后启用。`;
  }
  return "";
}
export interface ProcessTemplateDraft {
  id: string;
  applicationId: string;
  startPageId?: string;
  enabled: boolean;
  revision: number;
  latestVersion: number;
  spec: ProcessTemplateSpec;
  hasDraftChanges: boolean;
}
export interface PublishedProcessTemplate {
  id: string;
  applicationId: string;
  version: number;
  spec: ProcessTemplateSpec;
}
export interface ProcessStartPreview {
  template: PublishedProcessTemplate;
  bindings: Record<string, string>;
  recordRevisions: Record<string, number>;
  participantsToken?: string;
  tasks: {
    key: string;
    title: string;
    assigneeName: string;
    assigneeId?: string;
    recordId: string;
    pageTitle: string;
    rowId?: string;
    subformId?: string;
    dependsOn: string[];
  }[];
}
export interface ProcessRuntimeSource {
  templateId: string;
  templateVersion: number;
  applicationId: string;
}
export interface ExpandedProcess extends ProcessSpec {
  tasks: TaskSpec[];
}
