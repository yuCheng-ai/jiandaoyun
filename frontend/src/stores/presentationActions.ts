import {
  collaborationIssues,
  type CollaborationSettings,
} from "../domain/collaboration";
import { copy } from "../domain/form";
import { parseExtensions } from "../domain/extensions";
import {
  presentationIssues,
  printTemplateIssues,
  type PrintTemplate,
  type DetailSettings,
} from "../domain/presentation";
import type { FormRecord, WorkspaceData } from "../domain/workspace";

export function presentationActions(
  open: (id: string) => FormRecord | undefined,
  save: (id: string) => boolean,
  notify: (message: string, type?: string) => void,
  getData: () => WorkspaceData,
) {
  function savePrintTemplate(formId: string, config: PrintTemplate) {
    const form = open(formId);
    if (!form) return false;
    const errors = config.archived
      ? []
      : printTemplateIssues(config, form.schema, getData());
    if (errors.length) {
      notify(errors[0]!, "warning");
      return false;
    }
    const previous = form.extensions;
    const ext = parseExtensions(form.extensions);
    const index = (ext.printTemplates ||= []).findIndex(
      (t) => t.id === config.id,
    );
    if (index >= 0) ext.printTemplates[index] = copy(config);
    else {
      if (ext.printTemplates.length >= 50) {
        notify("最多保留 50 个打印模板，请修改已有模板", "warning");
        return false;
      }
      ext.printTemplates.push(copy(config));
    }
    form.extensions = ext;
    if (save(formId)) return true;
    form.extensions = previous;
    return false;
  }
  function saveDetailSettings(formId: string, config: DetailSettings) {
    const form = open(formId);
    if (!form) return false;
    const errors = presentationIssues(config, form.schema);
    if (errors.length) {
      notify(errors[0]!, "warning");
      return false;
    }
    const previous = form.extensions;
    form.extensions = {
      ...parseExtensions(form.extensions),
      detail: copy(config),
    };
    if (save(formId)) return true;
    form.extensions = previous;
    return false;
  }
  function saveCollaboration(formId: string, config: CollaborationSettings) {
    const form = open(formId);
    if (!form) return false;
    const issues = collaborationIssues(config, form.schema);
    if (issues.length) {
      notify(issues[0]!, "warning");
      return false;
    }
    const previous = form.extensions;
    form.extensions = {
      ...parseExtensions(form.extensions),
      collaboration: copy(config),
    };
    if (save(formId)) return true;
    form.extensions = previous;
    return false;
  }
  return { savePrintTemplate, saveDetailSettings, saveCollaboration };
}
