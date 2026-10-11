import type { Ref } from "vue";
import { sameWorkspaceValue } from "../domain/workspaceSync";
import {
  copy,
  prepareSubmission,
  validateValues,
  type FormSchema,
  type FormValues,
} from "../domain/form";
import {
  accessIssues,
  parseAccess,
  eligibleGroups,
  canEntry,
  creationSchema,
  fillingIssue,
  memberContext,
  prepareMemberUpdate,
  prepareMemberCreate,
  type FormAccess,
} from "../domain/access";
import { validateDynamicValues } from "../domain/fieldValidation";
import type { WorkspaceData, FormEntry } from "../domain/workspace";
export function accessActions(
  data: Ref<WorkspaceData>,
  persist: () => boolean,
  notify: (message: string, type?: string) => void,
  submit: (
    formId: string,
    values: FormValues,
    status?: FormEntry["status"],
    draftId?: string,
    actor?: string,
  ) => FormEntry | undefined,
  update: (
    id: string,
    values: FormValues,
    buttonName?: string,
    label?: string,
    actorId?: string,
  ) => boolean,
  recycle: (ids: string[], recycle: boolean, actorId?: string) => boolean,
) {
  function saveFormAccess(
    formId: string,
    config: FormAccess,
    expected?: FormAccess,
  ) {
    if (
      expected &&
      !sameWorkspaceValue(
        expected,
        parseAccess(data.value.formAccess?.[formId]),
      )
    ) {
      notify("该表单的访问设置已更新，当前修改已保留，请重新核对。", "warning");
      return false;
    }
    const form = data.value.forms.find((f) => f.id === formId && !f.archived);
    if (!form) return false;
    const errors = accessIssues(config, form, data.value);
    if (errors.length) {
      notify(errors[0]!, "warning");
      return false;
    }
    const previous = data.value.formAccess;
    data.value.formAccess = {
      ...previous,
      [formId]: parseAccess(copy(config)),
    };
    if (persist()) return true;
    data.value.formAccess = previous;
    return false;
  }
  function memberSubmit(
    formId: string,
    actor: string,
    selection: string,
    values: FormValues,
  ) {
    const form = data.value.forms.find((f) => f.id === formId);
    if (
      !form?.published ||
      !eligibleGroups(data.value, formId, actor, selection).some((g) =>
        g.actions.includes("create"),
      )
    ) {
      notify("当前成员没有添加权限", "warning");
      return;
    }
    const issue = fillingIssue(data.value, formId, actor);
    if (issue) {
      notify(issue, "warning");
      return;
    }
    const schema = creationSchema(form),
      context = memberContext(data.value, actor),
      resolved = prepareMemberCreate(schema, values, context);
    const others = data.value.entries
      .filter(
        (e) => e.formId === formId && !e.deletedAt && e.status !== "draft",
      )
      .map((e) => e.values);
    const errors = [
      ...validateValues(schema, resolved, others),
      ...validateDynamicValues(schema, resolved, context),
    ];
    if (errors.length) {
      notify(errors[0]!.message, "warning");
      return;
    }
    return submit(
      formId,
      prepareSubmission(schema, resolved),
      "submitted",
      undefined,
      actor,
    );
  }
  function memberUpdate(
    id: string,
    actor: string,
    selection: string,
    values: FormValues,
    expected: FormValues,
    expectedSchema?: FormSchema,
  ) {
    const entry = data.value.entries.find((e) => e.id === id);
    if (!entry) return false;
    if (JSON.stringify(expected) !== JSON.stringify(entry.values)) {
      notify("记录已被修改，请重新打开后编辑", "warning");
      return false;
    }
    const result = prepareMemberUpdate(
      data.value,
      entry,
      actor,
      selection,
      values,
      expectedSchema,
    );
    if (result.errors.length) {
      notify(result.errors[0]!, "warning");
      return false;
    }
    if (JSON.stringify(result.values) === JSON.stringify(entry.values))
      return true;
    return update(
      id,
      result.values,
      undefined,
      `成员 ${data.value.organization.employees.find((e) => e.id === actor)?.name || actor}`,
      actor,
    );
  }
  function memberDelete(id: string, actor: string, selection: string) {
    const entry = data.value.entries.find((e) => e.id === id);
    if (!entry || !canEntry(data.value, entry, actor, "delete", selection)) {
      notify("没有删除这条记录的权限", "warning");
      return false;
    }
    return recycle([id], true, actor);
  }
  return { saveFormAccess, memberSubmit, memberUpdate, memberDelete };
}
