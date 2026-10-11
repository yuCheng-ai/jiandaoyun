import { sameWorkspaceValue } from "../domain/workspaceSync";
import { recordCheckpoint } from "./recordTransaction";
import { prepareInlineEdit } from "../domain/collaboration";
import type { Ref } from "vue";
import {
  copy,
  prepareSubmission,
  validateValues,
  type FormValues,
  uid,
} from "../domain/form";
import {
  prepareImportRows,
  type RecordImportRequest,
  type ImportResult,
} from "../domain/recordImport";
import { allocateSerialValues } from "../domain/serial";
import { validateDynamicValues } from "../domain/fieldValidation";
import { resolveRuntimeValues } from "../domain/relations";
import { blockingFormValidation } from "../domain/formValidation";
import { parseRecordView, type RecordViewSettings } from "../domain/records";
import type { FormEntry, FormRecord, WorkspaceData } from "../domain/workspace";
import type { PushEvent } from "../domain/extensions";
import {
  prepareRecordBatch,
  recordBatchFields,
  type RecordBatchChange,
  type RecordBatchSelection,
} from "../domain/recordBatch";

export function recordActions(
  data: Ref<WorkspaceData>,
  persist: () => boolean,
  notify: (message: string, type?: string) => void,
  emit: (
    form: FormRecord,
    entry: FormEntry,
    event: PushEvent,
    previousValues?: FormValues,
    actorId?: string,
  ) => void,
  startImported?: (form: FormRecord, entry: FormEntry) => void,
) {
  function importEntries(
    formId: string,
    request: RecordImportRequest,
  ): ImportResult | false {
    const form = data.value.forms.find((f) => f.id === formId && !f.archived);
    if (!form?.published) {
      notify("请先发布表单后再导入数据", "warning");
      return false;
    }
    let rows: ReturnType<typeof prepareImportRows>;
    try {
      rows = prepareImportRows(form, request, data.value);
      const targets = new Map(request.targets.map((item) => [item.id, item]));
      for (const row of rows.filter((row) => row.kind === "update")) {
        const entry = data.value.entries.find((entry) => entry.id === row.id)!;
        const original = targets.get(entry.id);
        if (
          !original ||
          original.definitionVersion !== entry.definitionVersion ||
          !sameWorkspaceValue(original.values, entry.values)
        )
          throw Error(
            "待更新记录已变化，文件和字段匹配已保留；请重新核对数据后导入",
          );
      }
    } catch (error) {
      notify((error as Error).message, "warning");
      return false;
    }
    const rollback = recordCheckpoint(data.value),
      now = new Date(),
      time = now.toISOString();
    const actor =
      request.member?.actorId || data.value.organization.currentUserId;
    const historyLabel = request.member
      ? data.value.organization.employees.find((e) => e.id === actor)?.name ||
        "成员"
      : "数据管理";
    let created = 0,
      updated = 0;
    try {
      const records = new Map(
        data.value.entries.map((entry) => [entry.id, entry]),
      );
      const additions: FormEntry[] = [];
      for (const row of rows) {
        if (row.kind === "update") {
          const entry = records.get(row.id!)!;
          entry.values = row.values!;
          entry.updatedAt = time;
          entry.history.push({
            label: historyLabel,
            action: `导入更新（Excel 第 ${row.row} 行）`,
            time,
          });
          updated++;
        } else if (row.kind === "create") {
          const allocation = allocateSerialValues(
            form.published.schema,
            row.values!,
            data.value,
            formId,
            now,
            { calculate: false },
          );
          data.value.serialCounters = allocation.counters;
          const entry: FormEntry = {
            id: uid("entry"),
            formId,
            definitionVersion: form.published.version,
            values: allocation.values,
            createdBy: actor,
            createdDepartmentIds: [
              ...(data.value.organization.employees.find((e) => e.id === actor)
                ?.departmentIds || []),
            ],
            createdAt: time,
            status: form.kind === "workflow" ? "approved" : "submitted",
            history: [{ label: historyLabel, action: "导入新增", time }],
          };
          for (const field of form.published.schema.fields.filter(
            (f) => f.type === "serial" && !f.serial,
          ))
            entry.values[field.id] = `SN${now.getTime()}${entry.id.slice(-4)}`;
          additions.push(entry);
          if (request.triggerWorkflow) {
            if (!startImported) throw Error("当前流程无法启动，数据尚未导入");
            startImported(form, entry);
          }
          created++;
        }
      }
      data.value.entries = [...additions.reverse(), ...data.value.entries];
      if (!created && !updated) return { created, updated, rows };
      if (persist()) return { created, updated, rows };
      rollback();
      return false;
    } catch (error) {
      rollback();
      notify((error as Error).message, "warning");
      return false;
    }
  }
  function saveRecordView(formId: string, config: RecordViewSettings) {
    const before = data.value.recordViews;
    data.value.recordViews = { ...before, [formId]: parseRecordView(config) };
    if (persist()) return true;
    data.value.recordViews = before;
    return false;
  }
  function updateEntry(
    id: string,
    values: FormValues,
    buttonName?: string,
    historyLabel = "数据管理",
    actorId = data.value.organization.currentUserId,
    expectedValues?: FormValues,
  ) {
    const entry = data.value.entries.find((e) => e.id === id && !e.deletedAt),
      form = data.value.forms.find(
        (f) => f.id === entry?.formId && !f.archived,
      );
    if (!entry || !form || entry.status === "draft") return false;
    if (expectedValues && !sameWorkspaceValue(expectedValues, entry.values)) {
      notify(
        "这条记录已被修改，当前输入已保留，请重新打开记录核对。",
        "warning",
      );
      return false;
    }
    const definition =
      form.versions.find((v) => v.version === entry.definitionVersion) ||
      form.published;
    if (!definition) return false;
    const resolved = resolveRuntimeValues(
      definition.schema,
      values,
      data.value,
      entry.values,
    );
    const others = data.value.entries
      .filter(
        (e) =>
          e.id !== id &&
          e.formId === form.id &&
          e.status !== "draft" &&
          !e.deletedAt,
      )
      .map((e) => e.values);
    const errors = [
      ...validateValues(definition.schema, resolved, others, entry.values),
      ...validateDynamicValues(definition.schema, resolved, data.value),
    ];
    if (errors.length) {
      notify(errors[0]!.message, "warning");
      return false;
    }
    if (form.kind !== "workflow") {
      const issue = blockingFormValidation(
        definition.schema,
        prepareSubmission(definition.schema, resolved, entry.values, true),
        { data: data.value },
      )[0];
      if (issue) {
        notify(issue, "warning");
        return false;
      }
    }
    const before = copy(entry),
      rollback = recordCheckpoint(data.value);
    entry.values = prepareSubmission(
      definition.schema,
      resolved,
      entry.values,
      true,
    );
    entry.updatedAt = new Date().toISOString();
    entry.history.push({
      label: buttonName ? `按钮「${buttonName}」` : historyLabel,
      action: "修改记录",
      time: entry.updatedAt,
    });
    emit(form, entry, "data_update", before.values, actorId);
    if (persist()) return true;
    rollback();
    return false;
  }
  function recycleEntries(
    ids: string[],
    recycle: boolean,
    actorId = data.value.organization.currentUserId,
  ) {
    const unique = new Set(ids),
      selected = data.value.entries.filter(
        (e) => unique.has(e.id) && !!e.deletedAt !== recycle,
      );
    if (!selected.length || selected.length !== unique.size) {
      notify("记录已发生变化，请重新选择", "warning");
      return false;
    }
    if (
      selected.some(
        (e) => !data.value.forms.some((f) => f.id === e.formId && !f.archived),
      )
    )
      return false;
    if (!recycle) {
      for (const entry of selected.filter((e) => e.status !== "draft")) {
        const form = data.value.forms.find((f) => f.id === entry.formId)!;
        const definition =
          form.versions.find((v) => v.version === entry.definitionVersion) ||
          form.published;
        if (!definition) continue;
        const others = data.value.entries
          .filter(
            (e) =>
              e.id !== entry.id &&
              e.formId === entry.formId &&
              e.status !== "draft" &&
              (!e.deletedAt || unique.has(e.id)),
          )
          .map((e) => e.values);
        const errors = validateValues(definition.schema, entry.values, others);
        if (errors.length) {
          notify(`无法恢复：${errors[0]!.message}`, "warning");
          return false;
        }
      }
    }
    const rollback = recordCheckpoint(data.value),
      time = new Date().toISOString();
    for (const entry of selected) {
      if (recycle) entry.deletedAt = time;
      else delete entry.deletedAt;
      entry.history.push({
        label: "数据管理",
        action: recycle ? "移入回收站" : "恢复记录",
        time,
      });
      if (entry.status !== "draft")
        emit(
          data.value.forms.find((f) => f.id === entry.formId)!,
          entry,
          recycle ? "data_remove" : "data_recover",
          undefined,
          actorId,
        );
    }
    if (persist()) return true;
    rollback();
    return false;
  }
  function updateEntryField(
    id: string,
    fieldId: string,
    value: unknown,
    expectedValues: FormValues,
  ) {
    const entry = data.value.entries.find((e) => e.id === id);
    if (!entry) return false;
    if (JSON.stringify(entry.values) !== JSON.stringify(expectedValues)) {
      notify("记录已发生变化，请取消后重新编辑，避免覆盖其他修改", "warning");
      return false;
    }
    const result = prepareInlineEdit(entry, fieldId, value, data.value);
    if (result.errors.length) {
      notify(result.errors[0]!, "warning");
      return false;
    }
    if (!result.changes.length) return true;
    return updateEntry(id, result.values, undefined, "表格快捷编辑");
  }
  function batchUpdateEntries(
    formId: string,
    selection: RecordBatchSelection[],
    change: RecordBatchChange,
  ) {
    const form = data.value.forms.find(
        (form) => form.id === formId && !form.archived,
      ),
      records = new Map(data.value.entries.map((entry) => [entry.id, entry]));
    if (
      !form ||
      !selection.length ||
      selection.length > 50000 ||
      new Set(selection.map((item) => item.id)).size !== selection.length
    ) {
      notify("请选择1至50000条已提交记录", "warning");
      return false;
    }
    const now = new Date(),
      updates: { entry: FormEntry; values: FormValues; label: string }[] = [];
    let targetType = "",
      parentId: string | undefined;
    try {
      for (const item of selection) {
        const entry = records.get(item.id);
        if (
          !entry ||
          entry.formId !== formId ||
          entry.deletedAt ||
          entry.status === "draft" ||
          entry.definitionVersion !== item.definitionVersion ||
          !sameWorkspaceValue(entry.values, item.values)
        )
          throw Error("所选记录已变化，请重新选择；当前修改内容已保留");
        const definition = form.versions.find(
          (version) => version.version === entry.definitionVersion,
        );
        if (!definition) throw Error("记录的原表单版本不可用");
        const target = recordBatchFields(definition.schema).find(
          (target) => target.field.id === change.fieldId,
        );
        if (!target) throw Error("该字段不支持批量修改，唯一值字段不能批改");
        if (
          updates.length &&
          (targetType !== target.field.type || parentId !== target.parent?.id)
        )
          throw Error("所选记录中的字段类型不同，请分别修改");
        targetType = target.field.type;
        parentId = target.parent?.id;
        updates.push({
          entry,
          values: prepareRecordBatch(
            definition.schema,
            entry.values,
            change,
            data.value,
            now,
          ),
          label: target.label,
        });
      }
    } catch (error) {
      notify((error as Error).message, "warning");
      return false;
    }
    const rollback = recordCheckpoint(data.value),
      time = now.toISOString();
    for (const { entry, values, label } of updates) {
      entry.values = values;
      entry.updatedAt = time;
      entry.history.push({
        label: "数据管理",
        action: `批量修改「${label}」`,
        time,
      });
    }
    if (persist()) return true;
    rollback();
    return false;
  }
  return {
    saveRecordView,
    updateEntry,
    recycleEntries,
    updateEntryField,
    batchUpdateEntries,
    importEntries,
  };
}
