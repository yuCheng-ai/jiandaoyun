import type { FieldType, FormField, FormSchema } from "./form";

/** Data identity and business constraints, independent of any page layout. */
export type DataKind =
  | Exclude<
      FieldType,
      | "divider"
      | "tabs"
      | "button"
      | "textarea"
      | "radio"
      | "select"
      | "checkbox"
      | "multiselect"
    >
  | "choice"
  | "choices";
export const dataSettingKeys = [
  "defaultValue",
  "defaultLink",
  "defaultRows",
  "defaultFormula",
  "formulaRemark",
  "serial",
  "unique",
  "uniqueInRecord",
  "duplicateMessage",
  "options",
  "format",
  "dateDefault",
  "min",
  "max",
  "precision",
  "retainPrecision",
  "numberGrouping",
  "limitRange",
  "maxLength",
  "expression",
  "accept",
  "multiple",
  "limitFileTypes",
  "maxFileSize",
  "choiceSource",
  "allowCustomChoices",
  "organization",
  "reference",
  "referenceFormId",
  "referenceFieldId",
] as const;
export const pagePropertyKeys = [
  "label",
  "showLabel",
  "description",
  "placeholder",
  "required",
  "visible",
  "editable",
  "width",
  "subformWidth",
  "subformPermissions",
  "subformQuickFill",
  "subformFixedColumns",
  "subformMobile",
  "tabs",
  "tabId",
  "tabStyle",
  "tabCustomColor",
  "tabColor",
  "dividerColor",
  "dividerTitleColor",
  "dividerStyle",
  "rows",
  "buttonText",
  "masked",
  "dateRange",
  "addressComplete",
  "location",
  "ocr",
  "coloredOptions",
  "optionColors",
  "choiceLayout",
  "selectionLimit",
  "uploadStyle",
] as const;
export type DataFieldSettings = Pick<
  FormField,
  (typeof dataSettingKeys)[number]
>;
export type PageProperties = Omit<
  Pick<FormField, (typeof pagePropertyKeys)[number]>,
  "label"
> & { label: string | null };
export interface DataField {
  id: string;
  name: string;
  kind: DataKind;
  required: boolean;
  settings: DataFieldSettings;
  children: DataField[];
}
export interface DataModel {
  version: 1;
  fields: DataField[];
}
export interface PageControl {
  id: string;
  type: FieldType;
  binding?: { fieldId: string };
  properties: PageProperties;
  children: PageControl[];
  /** Layout/action/query-only controls have configuration but do not own a value. */
  unboundSettings?: DataFieldSettings;
}
export interface FormPageSchema {
  version: 1;
  controls: PageControl[];
  settings: FormSchema["settings"];
}
export interface PageSummary {
  id: string;
  applicationId?: string;
  title: string;
  definitionId: string;
  definitionVersion: number;
  revision: number;
  latestVersion: number;
  archivedAt?: string | null;
}
export interface DataFieldAddition {
  parentId?: string;
  field: DataField;
}
export interface PageDraft extends PageSummary {
  schema: FormPageSchema;
  additions: DataFieldAddition[];
  baseDefinitionRevision: number | null;
}
export interface PublishedPage {
  id: string;
  title: string;
  version: number;
  definitionId: string;
  definitionVersion: number;
  schema: FormPageSchema;
}
export interface DataObjectDraft {
  id: string;
  applicationId?: string;
  title: string;
  revision: number;
  latestVersion: number;
  model: DataModel;
  hasDraftChanges?: boolean;
}
export interface PageEditorData {
  draft: PageDraft;
  model: DataModel;
  object: DataObjectDraft;
}
export interface PublishedDataModel {
  object: DataObjectDraft;
  model: DataModel;
}
/** Saved page additions only; never exposes field defaults or other configuration values. */
export interface PendingPageFields {
  definitionId: string;
  pages: {
    id: string;
    title: string;
    revision: number;
    definitionVersion: number;
    archivedAt?: string | null;
    fields: {
      id: string;
      name: string;
      kind: DataKind;
      parentId?: string;
      parentName?: string;
    }[];
    warnings: string[];
  }[];
}
export interface PageLifecycleImpact {
  token: string;
  pageId: string;
  title: string;
  revision: number;
  action: "archive" | "restore";
  archivedAt: string | null;
  publishedVersion: number;
  pendingFieldCount: number;
  references: {
    id: string;
    title: string;
    state: "draft" | "published";
    version: number;
    tasks: { title: string; pageVersion: number }[];
  }[];
  tasks: { version: number; active: number; completed: number }[];
  warnings: string[];
}
export interface ApplicationSummary {
  id: string;
  title: string;
}
export interface ModelFieldChange {
  id: string;
  name: string;
  parentName?: string;
  beforeName?: string;
  details: string[];
}
export interface DataModelImpact {
  organizationCheck?: string;
  token: string;
  definitionId: string;
  title: string;
  revision: number;
  fromVersion: number;
  toVersion: number;
  titleChanged: boolean;
  defaultPageWillPublish?: boolean;
  changes: {
    added: ModelFieldChange[];
    removed: ModelFieldChange[];
    changed: ModelFieldChange[];
    renamed: ModelFieldChange[];
  };
  references: {
    kind: "page" | "relation" | "process" | "permission";
    id: string;
    title: string;
    state: "draft" | "published";
    version: number;
    fields: string[];
    effect: "blocks" | "review" | "retained";
    detail: string;
  }[];
  records: {
    version: number;
    count: number;
    archived: number;
    incompatible: number;
  }[];
  tasks: { version: number; active: number; completed: number }[];
  blockers: string[];
}
export interface PagePublishImpact {
  token: string;
  pageId: string;
  title: string;
  revision: number;
  fromVersion: number;
  toVersion: number;
  definitionId: string;
  definitionTitle: string;
  definitionRevision: number;
  fromDataVersion: number;
  toDataVersion: number;
  newFields: { id: string; name: string; parentName?: string }[];
  controls: {
    added: string[];
    removed: string[];
    changed: string[];
    layoutChanged: boolean;
    titleChanged: boolean;
  };
  references: {
    kind: "page" | "relation" | "process";
    id: string;
    title: string;
    state: "draft" | "published";
    version: number;
    detail: string;
  }[];
  records: { version: number; count: number }[];
  tasks: { version: number; active: number; completed: number }[];
  authorizedMembers: number;
}

export function dataFields(
  model: DataModel,
): { field: DataField; parentId?: string }[] {
  return model.fields.flatMap((field) => [
    { field },
    ...field.children.map((child) => ({ field: child, parentId: field.id })),
  ]);
}
const normalized = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, normalized(item)]),
        )
      : value;
/** Names and display order do not change the meaning of persisted values. */
export function dataModelChanges(before: DataModel, after: DataModel) {
  const old = new Map(dataFields(before).map((item) => [item.field.id, item]));
  const next = new Map(dataFields(after).map((item) => [item.field.id, item]));
  const signature = (item: { field: DataField; parentId?: string }) =>
    JSON.stringify(
      normalized({
        kind: item.field.kind,
        parentId: item.parentId,
        required: item.field.required,
        settings: item.field.settings,
      }),
    );
  return {
    added: [...next.values()].filter((item) => !old.has(item.field.id)),
    removed: [...old.values()].filter((item) => !next.has(item.field.id)),
    changed: [...next.values()].filter(
      (item) =>
        old.has(item.field.id) &&
        signature(item) !== signature(old.get(item.field.id)!),
    ),
    renamed: [...next.values()].filter(
      (item) =>
        old.has(item.field.id) &&
        item.field.name !== old.get(item.field.id)!.field.name,
    ),
  };
}

// Schemas are JSON documents. JSON copying also accepts Vue's reactive wrappers.
const copy = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, copy(source[key])]),
  ) as Pick<T, K>;
}
export function dataKind(type: FieldType): DataKind | undefined {
  if (type === "tabs" || type === "divider" || type === "button")
    return undefined;
  if (type === "textarea") return "text";
  if (type === "radio" || type === "select") return "choice";
  if (type === "checkbox" || type === "multiselect") return "choices";
  return type;
}
export function defaultControlType(kind: DataKind): FieldType {
  return kind === "choice"
    ? "select"
    : kind === "choices"
      ? "multiselect"
      : kind;
}
/** Converts an already validated legacy schema without regenerating field or tab IDs. */
export function separateFormSchema(schema: FormSchema): {
  model: DataModel;
  page: FormPageSchema;
} {
  const fields: DataField[] = [];
  const visit = (field: FormField, scope: DataField[]): PageControl => {
    const kind = dataKind(field.type);
    const ownsValue =
      !!kind &&
      !(field.type === "relationTable" && field.reference?.mode === "reverse");
    const control: PageControl = {
      id: field.id,
      type: field.type,
      properties: pick(field, pagePropertyKeys),
      children: [],
    };
    if (ownsValue) {
      const data: DataField = {
        id: field.id,
        name: field.label,
        kind: kind!,
        required: field.required,
        settings: pick(field, dataSettingKeys),
        children: [],
      };
      scope.push(data);
      control.binding = { fieldId: field.id };
      // The default label follows the model until a page explicitly overrides it.
      control.properties.label = null;
      control.children = field.children.map((child) =>
        visit(child, field.type === "subform" ? data.children : scope),
      );
    } else {
      control.unboundSettings = pick(field, dataSettingKeys);
      control.children = field.children.map((child) => visit(child, scope));
    }
    return control;
  };
  return {
    model: { version: 1, fields },
    page: {
      version: 1,
      controls: schema.fields.map((field) => visit(field, fields)),
      settings: copy(schema.settings),
    },
  };
}

export function defaultPageSettings(): FormSchema["settings"] {
  return {
    description: "",
    layout: 1,
    labelPosition: "top",
    labelWidth: 100,
    cacheDraft: false,
    hiddenValues: "retain",
    submitLabel: "提交",
    allowSubmit: true,
    allowDraft: true,
    draftLabel: "保存草稿",
    successMessage: "提交成功",
    successMode: "inline",
    allowAnotherSubmission: true,
    rules: [],
    validations: [],
  };
}
export function defaultPageProperties(): PageProperties {
  return {
    label: null,
    showLabel: true,
    description: "",
    placeholder: "",
    required: false,
    visible: true,
    editable: true,
    width: 12,
    tabs: [],
    rows: 3,
    buttonText: "按钮",
    masked: false,
  };
}
export function pageForModel(model: DataModel): FormPageSchema {
  const visit = (field: DataField): PageControl => ({
    id: field.id,
    type: defaultControlType(field.kind),
    binding: { fieldId: field.id },
    properties: defaultPageProperties(),
    children: field.children.map(visit),
  });
  return {
    version: 1,
    controls: model.fields.map(visit),
    settings: defaultPageSettings(),
  };
}
/** Compatibility rendering only. Data writes continue to address bound field IDs. */
export function composeFormSchema(
  model: DataModel,
  page: FormPageSchema,
): FormSchema {
  const controlIds = new Set<string>(),
    bindings = new Set<string>();
  const visit = (control: PageControl, scope: DataField[]): FormField => {
    if (controlIds.has(control.id)) throw new Error("页面控件 ID 重复");
    controlIds.add(control.id);
    const data = control.binding
      ? scope.find((field) => field.id === control.binding!.fieldId)
      : undefined;
    if (control.binding && !data)
      throw new Error("页面引用的字段不存在或不属于当前明细");
    if (data && dataKind(control.type) !== data.kind)
      throw new Error("控件类型与数据字段不兼容");
    if (
      !data &&
      dataKind(control.type) &&
      !(
        control.type === "relationTable" &&
        control.unboundSettings?.reference?.mode === "reverse"
      )
    )
      throw new Error("数据控件缺少字段绑定");
    // Legacy FormSchema renderers use field IDs as control IDs. Reject ambiguity instead of silently duplicating inputs.
    if (data && bindings.has(data.id))
      throw new Error("当前页面重复使用同一字段，请保留一个输入位置");
    if (data) bindings.add(data.id);
    return {
      ...copy(data?.settings || control.unboundSettings!),
      ...copy(control.properties),
      id: data?.id || control.id,
      type: control.type,
      label: control.properties.label ?? data?.name ?? "",
      required: !!(data?.required || control.properties.required),
      children: control.children.map((child) =>
        visit(child, data?.kind === "subform" ? data.children : scope),
      ),
    } as FormField;
  };
  return {
    version: 1,
    fields: page.controls.map((control) => visit(control, model.fields)),
    settings: copy(page.settings),
  };
}
/** Runtime validation projection contains all data fields and no user-page layout. */
export function modelFormSchema(model: DataModel): FormSchema {
  return composeFormSchema(model, pageForModel(model));
}
