import { computed, ref, toRef, watchEffect, type Ref } from "vue";
import {
  createField,
  fieldDepth,
  duplicateField,
  fieldDefinition,
  findField,
  findFieldContainer,
  flattenFields,
  countFormFields,
  moveField,
  type FieldType,
  type FormField,
  type VisibilityRule,
} from "../../domain/form";
import { visibilityConditions } from "../../domain/visibility";
import { formFieldLimitError, type FormRecord } from "../../domain/workspace";
import { useEditorHistory } from "../../composables/useEditorHistory";
export interface FieldDrop {
  type?: FieldType;
  id?: string;
  parentId?: string;
  index: number;
  tabId?: string;
}
export function useFormDesigner(
  form: Ref<FormRecord>,
  report: (message: string) => void = () => {},
  forms: () => readonly FormRecord[] = () => [],
) {
  const selectedIds = ref<string[]>([]);
  const activeParent = ref<string | null>(null);
  const activeTabId = ref<string | undefined>();
  function canAddFields(additions: FormField[]) {
    if (
      !flattenFields(additions).some((field) =>
        ["calculated", "richtext"].includes(field.type),
      )
    )
      return true;
    const error = formFieldLimitError(
      {
        ...form.value,
        schema: {
          ...form.value.schema,
          fields: [...form.value.schema.fields, ...additions],
        },
      },
      [...forms().filter((item) => item.id !== form.value.id), form.value],
    );
    if (error) report(error);
    return !error;
  }
  function reconcileContext() {
    const parent = activeParent.value
      ? findField(form.value.schema.fields, activeParent.value)
      : undefined;
    if (!parent || !fieldDefinition(parent.type).container)
      activeParent.value = null;
    const tabs = form.value.schema.fields.find(
      (field) => field.type === "tabs",
    );
    const owner =
      parent && tabs?.children.find((child) => !!findField([child], parent.id));
    if (owner) activeTabId.value = owner.tabId || tabs?.tabs[0]?.id;
    if (!tabs?.tabs.some((tab) => tab.id === activeTabId.value))
      activeTabId.value = tabs?.tabs[0]?.id;
  }
  watchEffect(reconcileContext, { flush: "sync" });
  function setContext(parentId: string | null, tabId?: string) {
    activeParent.value = parentId;
    // Entering a subform or the main form does not change the visible tab.
    if (tabId !== undefined) activeTabId.value = tabId;
    reconcileContext();
  }
  const trash = toRef(() => form.value.fieldTrash || []);
  const selected = computed(() =>
    selectedIds.value.length === 1
      ? findField(form.value.schema.fields, selectedIds.value[0]!)
      : undefined,
  );
  const history = useEditorHistory(
    () => ({ schema: form.value.schema, fieldTrash: trash.value }),
    (value) => {
      form.value.schema = value.schema;
      form.value.fieldTrash = value.fieldTrash;
      reconcileContext();
    },
  );
  function select(id: string, event?: MouseEvent | KeyboardEvent) {
    const all = flattenFields(form.value.schema.fields);
    const current = selectedIds.value.at(-1);
    if (event?.shiftKey && current) {
      const a = all.findIndex((f) => f.id === current),
        b = all.findIndex((f) => f.id === id);
      selectedIds.value = all
        .slice(Math.min(a, b), Math.max(a, b) + 1)
        .map((f) => f.id);
    } else if (event?.metaKey || event?.ctrlKey)
      selectedIds.value = selectedIds.value.includes(id)
        ? selectedIds.value.filter((value) => value !== id)
        : [...selectedIds.value, id];
    else selectedIds.value = [id];
    const field = findField(
      form.value.schema.fields,
      selectedIds.value.at(-1) || "",
    );
    if (!field) return;
    const container = findFieldContainer(form.value.schema.fields, field.id);
    const parent = fieldDefinition(field.type).container
      ? field
      : all.find((item) => item.children === container);
    activeParent.value = parent?.id || null;
    if (parent?.type === "tabs")
      activeTabId.value = field === parent ? activeTabId.value : field.tabId;
  }
  function add(
    type: FieldType,
    parentId = activeParent.value,
    tabId = activeTabId.value,
    index?: number,
    overrides: Partial<FormField> = {},
  ) {
    const parent = parentId
      ? findField(form.value.schema.fields, parentId)
      : undefined;
    if (parentId && (!parent || !fieldDefinition(parent.type).container)) {
      report("请选择表单、子表单或标签页中的添加位置");
      return;
    }
    if (type === "tabs") {
      if (parentId) {
        report("多标签页只能添加在主表中");
        return;
      }
      if (
        flattenFields(form.value.schema.fields).some(
          (field) => field.type === "tabs",
        )
      ) {
        report("一个表单只能添加一个多标签页字段");
        return;
      }
    }
    if (type === "serial") {
      if (parent?.type === "subform") {
        report("流水号只能添加在主表中");
        return;
      }
      if (
        flattenFields(form.value.schema.fields).some((f) => f.type === "serial")
      ) {
        report("一个表单只能添加一个流水号字段");
        return;
      }
    }
    if (parent?.type === "subform" && !fieldDefinition(type).subform) {
      report(`子表单不支持添加${fieldDefinition(type).label}`);
      return;
    }
    if (
      countFormFields(form.value.schema.fields) +
        (["tabs", "divider"].includes(type) ? 0 : 1) +
        countFormFields(overrides.children || []) >
      300
    ) {
      report("单个表单最多 300 个字段");
      return;
    }
    if (parentId && fieldDepth(form.value.schema.fields, parentId) >= 4) {
      report("字段嵌套最多四层");
      return;
    }
    const target =
      parent && fieldDefinition(parent.type).container
        ? parent.children
        : form.value.schema.fields;
    const field = createField(type, {
      ...(type === "calculated" ? { calculationVersion: 1 as const } : {}),
      ...overrides,
      tabId:
        parent?.type === "tabs"
          ? parent.tabs.some((tab) => tab.id === tabId)
            ? tabId
            : parent.tabs[0]?.id
          : undefined,
    });
    if (!canAddFields([field])) return;
    history.transact(() => target.splice(index ?? target.length, 0, field));
    select(field.id);
    return field;
  }
  function drop(payload: FieldDrop) {
    const parent = payload.parentId
      ? findField(form.value.schema.fields, payload.parentId)
      : undefined;
    const moving = payload.id
      ? findField(form.value.schema.fields, payload.id)
      : undefined;
    if (
      parent?.type === "subform" &&
      moving &&
      !fieldDefinition(moving.type).subform &&
      findFieldContainer(form.value.schema.fields, moving.id) !==
        parent.children
    ) {
      report(`子表单不支持添加${fieldDefinition(moving.type).label}`);
      return;
    }
    if (
      parent &&
      moving &&
      flattenFields([moving]).some((field) => field.type === "tabs")
    ) {
      report("多标签页只能添加在主表中");
      return;
    }
    // Drop indices from a tab are relative to its visible children.
    if (parent?.type === "tabs") {
      const visible = parent.children.filter(
        (c) => !c.tabId || c.tabId === payload.tabId,
      );
      const before = visible[payload.index];
      payload.index = before
        ? parent.children.indexOf(before)
        : parent.children.length;
    }
    if (payload.type)
      add(payload.type, payload.parentId || null, payload.tabId, payload.index);
    else if (payload.id) {
      const source = findFieldContainer(form.value.schema.fields, payload.id);
      const previousTabId = moving?.tabId;
      let moved = false;
      history.transact(() => {
        moved = moveField(
          form.value.schema.fields,
          payload.id!,
          payload.parentId || null,
          payload.index,
          payload.tabId,
        );
      });
      if (
        moved &&
        (source !== (parent?.children || form.value.schema.fields) ||
          previousTabId !== moving?.tabId)
      )
        select(payload.id);
    }
  }
  function remove(ids = selectedIds.value) {
    const removed = new Set<string>();
    // A selected container already owns its children; archive it once.
    const roots = ids.filter(
      (id) =>
        !ids.some(
          (other) =>
            other !== id &&
            flattenFields(
              findField(form.value.schema.fields, other)?.children || [],
            ).some((child) => child.id === id),
        ),
    );
    history.transact(() => {
      const previousRules = JSON.parse(
        JSON.stringify(form.value.schema.settings.rules),
      ) as VisibilityRule[];
      const archivedRules = [
        ...previousRules,
        ...trash.value.flatMap((item) => item.rules),
      ].filter(
        (rule, index, rules) =>
          rules.findIndex((item) => item.id === rule.id) === index,
      );
      const nextTrash = [...trash.value];
      for (const id of roots) {
        const field = findField(form.value.schema.fields, id);
        const container = findFieldContainer(form.value.schema.fields, id);
        if (!field || !container) continue;
        const parent = flattenFields(form.value.schema.fields).find(
          (f) => f.children === container,
        );
        const index = container.indexOf(field);
        const fieldIds = flattenFields([field]).map((child) => child.id);
        fieldIds.forEach((id) => removed.add(id));
        const rules = archivedRules.filter(
          (rule) =>
            rule.targetIds.some((id) => fieldIds.includes(id)) ||
            visibilityConditions(rule).some((condition) =>
              fieldIds.includes(condition.sourceId),
            ),
        );
        nextTrash.unshift({ field, parentId: parent?.id || null, rules });
        container.splice(index, 1);
      }
      form.value.fieldTrash = nextTrash;
      form.value.schema.settings.rules = previousRules
        .filter((rule) =>
          visibilityConditions(rule).every(
            (condition) => !removed.has(condition.sourceId),
          ),
        )
        .map((rule) => ({
          ...rule,
          targetIds: rule.targetIds.filter((id) => !removed.has(id)),
        }))
        .filter((rule) => rule.targetIds.length);
    });
    selectedIds.value = selectedIds.value.filter((id) => !removed.has(id));
    if (
      activeParent.value &&
      !findField(form.value.schema.fields, activeParent.value)
    )
      activeParent.value = null;
  }
  function restore(index: number) {
    const item = trash.value[index];
    if (!item) return false;
    const parent = item.parentId
      ? findField(form.value.schema.fields, item.parentId)
      : undefined;
    if (item.parentId && (!parent || !fieldDefinition(parent.type).container)) {
      report("请先恢复原子表单或标签页，再恢复该字段");
      return false;
    }
    const existing = new Set(
      flattenFields(form.value.schema.fields).map((f) => f.id),
    );
    const restoring = flattenFields([item.field]);
    if (
      restoring.some((field) => field.type === "tabs") &&
      (parent ||
        item.field.type !== "tabs" ||
        restoring.filter((field) => field.type === "tabs").length > 1 ||
        flattenFields(form.value.schema.fields).some(
          (field) => field.type === "tabs",
        ))
    ) {
      report("多标签页只能作为一个主字段，请先整理现有标签页再恢复");
      return false;
    }
    if (
      restoring.some((f) => f.type === "serial") &&
      (parent?.type === "subform" ||
        flattenFields(form.value.schema.fields).some(
          (f) => f.type === "serial",
        ))
    ) {
      report(
        parent?.type === "subform"
          ? "流水号只能添加在主表中"
          : "一个表单只能添加一个流水号字段",
      );
      return false;
    }
    if (restoring.some((f) => existing.has(f.id))) {
      report("表单中已有同一字段，请检查后再恢复");
      return false;
    }
    if (
      countFormFields(form.value.schema.fields) +
        countFormFields([item.field]) >
      300
    ) {
      report("单个表单最多 300 个字段，请先整理字段再恢复");
      return false;
    }
    if (!canAddFields([item.field])) return false;
    history.transact(() => {
      const target = parent?.children || form.value.schema.fields;
      if (
        parent?.type === "tabs" &&
        !parent.tabs.some((tab) => tab.id === item.field.tabId)
      )
        item.field.tabId = parent.tabs[0]?.id;
      target.push(item.field);
      const available = new Set(
        flattenFields(form.value.schema.fields).map((field) => field.id),
      );
      const restored = new Set(
        flattenFields([item.field]).map((field) => field.id),
      );
      for (const archived of item.rules) {
        if (
          !visibilityConditions(archived).every((condition) =>
            available.has(condition.sourceId),
          )
        )
          continue;
        const targets = archived.targetIds.filter((id) => available.has(id));
        if (!targets.length) continue;
        const current = form.value.schema.settings.rules.find(
          (rule) => rule.id === archived.id,
        );
        if (!current)
          form.value.schema.settings.rules.push({
            ...archived,
            targetIds: targets,
          });
        else if (
          JSON.stringify({ ...current, targetIds: [] }) ===
          JSON.stringify({ ...archived, targetIds: [] })
        )
          current.targetIds = [
            ...archived.targetIds.filter(
              (id) =>
                current.targetIds.includes(id) ||
                (restored.has(id) && available.has(id)),
            ),
            ...current.targetIds.filter(
              (id) => !archived.targetIds.includes(id),
            ),
          ];
      }
      trash.value.splice(index, 1);
    });
    select(item.field.id);
    return true;
  }
  function duplicate(id: string, selectCopy = true) {
    const field = findField(form.value.schema.fields, id),
      container = findFieldContainer(form.value.schema.fields, id);
    if (!field || !container) return;
    if (
      !fieldDefinition(field.type).subform &&
      flattenFields(form.value.schema.fields).some(
        (parent) => parent.type === "subform" && parent.children === container,
      )
    ) {
      report(`子表单不支持添加${fieldDefinition(field.type).label}`);
      return;
    }
    if (flattenFields([field]).some((child) => child.type === "tabs")) {
      report("一个表单只能添加一个多标签页字段，请在字段属性中复制标签页");
      return;
    }
    if (flattenFields([field]).some((f) => f.type === "serial")) {
      report("一个表单只能添加一个流水号字段");
      return;
    }
    if (
      countFormFields(form.value.schema.fields) + countFormFields([field]) >
      300
    ) {
      report("单个表单最多 300 个字段");
      return;
    }
    if (!canAddFields([field])) return;
    const copied = duplicateField(field);
    history.transact(() =>
      container.splice(container.indexOf(field) + 1, 0, copied),
    );
    if (selectCopy) select(copied.id);
  }
  function move(id: string, direction: -1 | 1) {
    const container = findFieldContainer(form.value.schema.fields, id);
    if (!container) return;
    const index = container.findIndex((f) => f.id === id),
      to = index + direction;
    if (to < 0 || to >= container.length) return;
    history.transact(() => {
      const [field] = container.splice(index, 1);
      container.splice(to, 0, field!);
    });
  }
  return {
    selectedIds,
    selected,
    activeParent,
    activeTabId,
    setContext,
    trash,
    ...history,
    select,
    add,
    drop,
    remove,
    restore,
    duplicate,
    move,
  };
}
