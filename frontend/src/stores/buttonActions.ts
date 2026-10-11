import { copy, uid, type FormValues } from "../domain/form";
import { parseExtensions } from "../domain/extensions";
import { buttonIssues, type CustomButton } from "../domain/buttons";
import type { FormRecord, WorkspaceData } from "../domain/workspace";
import type { Ref } from "vue";

export function buttonActions(
  data: Ref<WorkspaceData>,
  open: (id: string) => FormRecord | undefined,
  save: (id: string) => boolean,
  notify: (message: string, type?: string) => void,
) {
  const prefills = new Map<
    string,
    { formId: string; version: number; values: FormValues }
  >();
  function saveButton(formId: string, config: CustomButton) {
    const form = open(formId);
    if (!form) return false;
    const issues =
      config.enabled && !config.archived
        ? buttonIssues(config, form.schema, data.value)
        : [];
    if (issues.length) {
      notify(issues[0]!.message, "warning");
      return false;
    }
    const previous = form.extensions,
      extensions = parseExtensions(previous),
      list = (extensions.buttons ||= []),
      index = list.findIndex((c) => c.id === config.id);
    if (index < 0 && list.length >= 50) {
      notify("每张表单最多保留 50 个按钮", "warning");
      return false;
    }
    if (index < 0) list.push(copy(config));
    else list[index] = copy(config);
    form.extensions = extensions;
    if (save(formId)) return true;
    form.extensions = previous;
    return false;
  }
  function queuePrefill(formId: string, version: number, values: FormValues) {
    const token = uid("prefill");
    if (prefills.size >= 20) prefills.delete(prefills.keys().next().value!);
    prefills.set(token, { formId, version, values: copy(values) });
    return token;
  }
  function consumePrefill(token: string, formId: string, version: number) {
    const item = prefills.get(token);
    prefills.delete(token);
    return item?.formId === formId && item.version === version
      ? copy(item.values)
      : undefined;
  }
  return { saveButton, queuePrefill, consumePrefill };
}
