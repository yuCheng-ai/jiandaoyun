import type { Ref } from "vue";
import { copy } from "../domain/form";
import { parseExtensions } from "../domain/extensions";
import {
  automationIssues,
  parseAutomations,
  type AutomationConfig,
} from "../domain/automation";
import type { FormRecord, WorkspaceData } from "../domain/workspace";

export function automationStoreActions(
  data: Ref<WorkspaceData>,
  open: (id: string) => FormRecord | undefined,
  save: (id: string) => boolean,
  notify: (message: string, type?: string) => void,
) {
  function saveAutomation(formId: string, config: AutomationConfig) {
    const form = open(formId);
    if (!form) return false;
    const issue =
      !config.archived && config.enabled
        ? automationIssues(config, form.schema, data.value)[0]
        : undefined;
    if (issue) {
      notify(issue.message, "warning");
      return false;
    }
    const before = form.extensions,
      extensions = parseExtensions(before),
      list = (extensions.automations ||= []);
    const index = list.findIndex((c) => c.id === config.id);
    if (index < 0 && list.length >= 50) {
      notify("每张表单最多保留 50 个智能助手，请修改已有配置", "warning");
      return false;
    }
    let normalized: AutomationConfig;
    try {
      normalized = parseAutomations([copy(config)])[0]!;
    } catch {
      notify("智能助手配置格式无效", "warning");
      return false;
    }
    if (index < 0) list.push(normalized);
    else list[index] = normalized;
    form.extensions = extensions;
    if (save(formId)) return true;
    form.extensions = before;
    return false;
  }
  return { saveAutomation };
}
