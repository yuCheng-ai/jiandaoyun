import { copy, uid } from "./form";
import { parseExtensions } from "./extensions";
import type { FormRecord } from "./workspace";

/** Copies design only. Published history and automatic extension actions never carry over. */
export function copyFormDesign(
  original: FormRecord,
  title = `${original.title} 副本`,
): FormRecord {
  const duplicate = copy(original);
  duplicate.id = uid("form");
  duplicate.title = title;
  duplicate.workflow.title = title;
  duplicate.published = undefined;
  duplicate.versions = [];
  duplicate.createdAt = duplicate.updatedAt = new Date().toISOString();
  duplicate.archived = false;
  duplicate.extensions = parseExtensions(duplicate.extensions);
  if (duplicate.extensions.quickFill)
    duplicate.extensions.quickFill.enabled = false;
  if (duplicate.extensions.payment)
    duplicate.extensions.payment.enabled = false;
  duplicate.extensions.automations?.forEach((c) => {
    c.id = uid("automation");
    c.enabled = false;
    c.steps.forEach((step) => {
      step.id = uid("action");
    });
  });
  duplicate.extensions.buttons?.forEach((c) => {
    c.id = uid("button");
    c.enabled = false;
  });
  duplicate.extensions.reminders?.forEach((c) => {
    c.id = uid("reminder");
    c.enabled = false;
  });
  duplicate.extensions.webhooks.forEach((c) => {
    c.id = uid("push");
    c.enabled = false;
  });
  duplicate.extensions.printTemplates?.forEach((c) => {
    c.id = uid("print");
  });
  return duplicate;
}
