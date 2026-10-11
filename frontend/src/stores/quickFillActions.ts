import { parseExtensions } from "../domain/extensions";
import {
  parseQuickFill,
  quickFillDesignSchema,
  quickFillIssues,
  type QuickFillConfig,
} from "../domain/quickFill";
import type { FormRecord } from "../domain/workspace";

export function quickFillActions(
  open: (id: string) => FormRecord | undefined,
  save: (id: string) => boolean,
  notify: (message: string, type?: string) => void,
) {
  function saveQuickFill(formId: string, config: QuickFillConfig) {
    const form = open(formId);
    if (!form) return false;
    const normalized = parseQuickFill(config);
    const issues = normalized.enabled
      ? quickFillIssues(normalized, quickFillDesignSchema(form))
      : [];
    if (issues.length) {
      notify(issues[0]!, "warning");
      return false;
    }
    const before = form.extensions;
    form.extensions = { ...parseExtensions(before), quickFill: normalized };
    if (save(formId)) return true;
    form.extensions = before;
    return false;
  }
  return { saveQuickFill };
}
