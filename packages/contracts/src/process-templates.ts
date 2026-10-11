import type { ProcessSpec, TaskSpec } from "./index";
import type { AssigneeSelector } from "./organization";

export interface ProcessBindingSpec { id: string; title: string; definitionId: string; definitionVersion: number }
export interface ProcessTemplateTask {
  id: string;
  title: string;
  recordBinding: string;
  assigneeId: string;
  assigneeSelector?: AssigneeSelector;
  pageId: string;
  pageVersion: number;
  subformId?: string;
  dependsOn: string[];
  requiredFields: string[];
  waitFor?: { recordBinding: string; fieldId: string; subformId?: string; equals: string | number | boolean | string[] };
}
export interface ProcessTemplateSpec { title: string; bindings: ProcessBindingSpec[]; tasks: ProcessTemplateTask[] }
export interface ProcessTemplateDraft { id: string; applicationId: string; revision: number; latestVersion: number; spec: ProcessTemplateSpec; hasDraftChanges: boolean }
export interface PublishedProcessTemplate { id: string; applicationId: string; version: number; spec: ProcessTemplateSpec }
export interface ProcessStartPreview {
  template: PublishedProcessTemplate;
  bindings: Record<string, string>;
  recordRevisions: Record<string, number>;
  participantsToken?: string;
  tasks: { key: string; title: string; assigneeName: string; assigneeId?: string; recordId: string; pageTitle: string; rowId?: string; subformId?: string; dependsOn: string[] }[];
}
export interface ProcessRuntimeSource { templateId: string; templateVersion: number; applicationId: string }
export interface ExpandedProcess extends ProcessSpec { tasks: TaskSpec[] }
