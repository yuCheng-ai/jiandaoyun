import type { Ref } from "vue";
import { copy } from "../domain/form";
import { parseExtensions, type ExtensionRun } from "../domain/extensions";
import {
  reminderIssues,
  reminderDueAt,
  reminderOccurrence,
  runReminder,
  type ReminderConfig,
} from "../domain/reminders";
import type { FormRecord, WorkspaceData } from "../domain/workspace";

export function reminderActions(
  data: Ref<WorkspaceData>,
  open: (id: string) => FormRecord | undefined,
  save: (id: string) => boolean,
  persist: () => boolean,
  notify: (message: string, type?: string) => void,
  append: (
    run: ExtensionRun,
    formId: string,
    origin: ExtensionRun["origin"],
  ) => ExtensionRun,
) {
  function saveReminder(formId: string, config: ReminderConfig) {
    const form = open(formId);
    if (!form) return false;
    const issues =
      config.archived || !config.enabled
        ? []
        : reminderIssues(config, form.schema);
    if (issues.length) {
      notify(issues[0]!.message, "warning");
      return false;
    }
    const previous = form.extensions,
      extensions = parseExtensions(previous);
    const list = (extensions.reminders ||= []),
      index = list.findIndex((r) => r.id === config.id);
    if (index < 0 && list.length >= 50) {
      notify("每张表单最多保留 50 条提醒，请修改已有配置", "warning");
      return false;
    }
    if (index < 0) list.push(copy(config));
    else list[index] = copy(config);
    form.extensions = extensions;
    if (save(formId)) return true;
    form.extensions = previous;
    return false;
  }
  function checkDueReminders(formId: string, now = new Date()) {
    const form = data.value.forms.find(
      (f) => f.id === formId && !f.archived && f.published,
    );
    if (!form || !Number.isFinite(now.getTime())) {
      notify("请先发布表单，再检查已提交记录的到期提醒", "warning");
      return;
    }
    const stats = {
      success: 0,
      failed: 0,
      skipped: 0,
      already: 0,
      future: 0,
      invalidDate: 0,
    };
    const previousRuns = data.value.extensionRuns;
    const receipts = new Map<string, string[] | undefined>();
    for (const entry of data.value.entries.filter(
      (e) => e.formId === formId && !e.deletedAt && e.status !== "draft",
    )) {
      const version =
        form.versions.find((v) => v.version === entry.definitionVersion) ||
        (form.published?.version === entry.definitionVersion
          ? form.published
          : undefined);
      if (!version) continue;
      for (const c of version.extensions?.reminders || []) {
        if (!c.enabled || c.archived || c.trigger !== "date") continue;
        const due = reminderDueAt(c, entry.values),
          occurrence = reminderOccurrence(c, version.version, entry.values);
        if (!due || !occurrence) {
          stats.invalidDate++;
          continue;
        }
        if (due.getTime() > now.getTime()) {
          stats.future++;
          continue;
        }
        if (entry.reminderReceipts?.includes(occurrence)) {
          stats.already++;
          continue;
        }
        const run = runReminder(c, version.schema, entry.values, data.value, {
          now,
          entryId: entry.id,
        });
        stats[
          run.status === "success"
            ? "success"
            : run.status === "failed"
              ? "failed"
              : "skipped"
        ]++;
        append(run, form.id, "schedule");
        if (run.status === "success") {
          if (!receipts.has(entry.id))
            receipts.set(entry.id, entry.reminderReceipts);
          entry.reminderReceipts = [
            ...(entry.reminderReceipts || []),
            occurrence,
          ];
        }
      }
    }
    if (data.value.extensionRuns !== previousRuns && !persist()) {
      data.value.extensionRuns = previousRuns;
      for (const entry of data.value.entries)
        if (receipts.has(entry.id))
          entry.reminderReceipts = receipts.get(entry.id);
      return;
    }
    return stats;
  }
  return { saveReminder, checkDueReminders };
}
