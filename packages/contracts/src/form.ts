import type { LocationValue, LocationSettings } from "./location";
import type { DateRange } from "./date-range";
import type { ExternalFormStyle } from "./form-appearance";
import type { SubformPermissions } from "./subform";
// Stable form schema shared by designer and server. Runtime rules remain explicit.
export interface DataFilter {
  id: string;
  sourceFieldId: string;
  operator:
    "equals" | "notEquals" | "contains" | "greater" | "less" | "notEmpty";
  source: "constant" | "field" | "currentUser" | "currentDepartment";
  value: string;
  valueType?: "text" | "choice";
}
export interface ChoiceSource {
  mode: "manual" | "form";
  formId: string;
  labelFieldId: string;
  valueFieldId: string;
  filters: DataFilter[];
  sort: "none" | "asc" | "desc";
  deduplicate: boolean;
}
export interface ReferenceConfig {
  mode: "forward" | "reverse";
  filters: DataFilter[];
  columns: string[];
  columnLabels?: Record<string, string>;
  mappings: { sourceFieldId: string; targetFieldId: string }[];
  reverseFieldId: string;
  displayColumns?: string[];
  match?: "all" | "any";
  sort?: { fieldId: string; direction: "asc" | "desc" };
}
export interface DefaultLink {
  enabled: boolean;
  formId: string;
  fieldId: string;
  filters: DataFilter[];
  match: "all" | "any";
  /** Whole-subform links map stable source columns to local child fields. */
  mappings?: { sourceFieldId: string; targetFieldId: string }[];
}

export interface SelectionScope {
  mode: "all" | "custom" | "currentDepartment" | "fieldDepartment";
  departmentIds: string[];
  roleIds: string[];
  employeeIds: string[];
  includeChildren: boolean;
  fieldId: string;
}
export interface OrganizationFieldConfig {
  scope: SelectionScope;
  defaultMode:
    "none" | "currentUser" | "currentDepartment" | "departmentManager";
  defaultIds: string[];
}

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "datetime"
  | "radio"
  | "checkbox"
  | "select"
  | "multiselect"
  | "member"
  | "members"
  | "department"
  | "departments"
  | "divider"
  | "tabs"
  | "image"
  | "file"
  | "address"
  | "location"
  | "subform"
  | "query"
  | "lookup"
  | "signature"
  | "serial"
  | "phone"
  | "ocr"
  | "button"
  | "calculated"
  | "richtext"
  | "relation"
  | "relationTable";
export interface FieldOption {
  id: string;
  label: string;
  other?: boolean;
}
/** Fill-only text; predefined selections continue to use their original option IDs. */
export interface ChoiceTextValue {
  text: string;
  optionId?: string;
}
export type ChoiceValue = string | ChoiceTextValue;
export type SerialResetCycle = "none" | "day" | "month" | "year";
export type AddressValue = Partial<
  Record<"province" | "city" | "district" | "detail", string>
>;
export type SerialRule =
  | { id: string; type: "counter" }
  | { id: string; type: "date"; mode: "preset" | "custom"; format: string }
  | { id: string; type: "text"; value: string }
  | { id: string; type: "field"; fieldId: string };
export interface SerialSettings {
  digits: number;
  fixed: boolean;
  reset: SerialResetCycle;
  initial: number;
  rules: SerialRule[];
}
export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  showLabel: boolean;
  description: string;
  placeholder: string;
  defaultValue: string | number | string[] | AddressValue | LocationValue;
  /** Absent on historical text-only location fields. */
  location?: LocationSettings;
  /** Absent on historical OCR fields that only stored text. */
  ocr?: import("./ocr").OcrSettings;
  defaultLink?: DefaultLink;
  /** Literal initial rows; omitted on older definitions. */
  defaultRows?: FormValues[];
  /** Filling permissions; submitted records use their applicable access group. */
  subformPermissions?: SubformPermissions;
  /** Spreadsheet filling is opt-in; historical forms keep their original entry points. */
  subformQuickFill?: boolean;
  /** Display only; the counts refer to the original child-field order. */
  subformFixedColumns?: { desktop: number; mobile: number };
  /** Mobile presentation only; omitted historical forms retain their table. */
  subformMobile?: {
    layout: "vertical" | "table";
    summary: "first" | "custom";
    fieldIds: string[];
  };
  /** Runtime access projection only; never configured or parsed as a form setting. */
  rowEditAccess?: { existing: boolean; append: boolean; insert: boolean };
  /** Uses the existing expression; switching source preserves the expression. */
  defaultFormula?: boolean;
  formulaRemark?: string;
  /** Current calculation rules; absent historical definitions keep their original semantics. */
  calculationVersion?: 1;
  required: boolean;
  unique: boolean;
  /** Duplicate checks within one submitted record's subform rows. */
  uniqueInRecord?: boolean;
  duplicateMessage?: string;
  visible: boolean;
  editable: boolean;
  width: number;
  /** Subform presentation only; a number selects a custom pixel width. */
  subformWidth?: "half" | "standard" | "double" | number;
  options: FieldOption[];
  /** Internal compatibility for pre-conversion conditions; never rewrites published schemas. */
  choiceConversion?: {
    initialType: "text" | "choice";
    options: FieldOption[];
    sources?: Pick<ChoiceSource, "formId" | "labelFieldId" | "valueFieldId">[];
  };
  coloredOptions?: boolean;
  optionColors?: Record<string, string>;
  choiceLayout?: "vertical" | "horizontal";
  selectionLimit?: { enabled: boolean; min?: number; max?: number };
  allowCustomChoices?: boolean;
  children: FormField[];
  tabs: FieldOption[];
  tabId?: string;
  tabStyle?: "line" | "top" | "card" | "solid" | "slant";
  tabCustomColor?: boolean;
  tabColor?: string;
  dividerColor?: string;
  dividerTitleColor?: string;
  dividerStyle?:
    | "none"
    | "dashed"
    | "thin"
    | "thick"
    | "style1"
    | "style2"
    | "style3"
    | "style4"
    | "style5"
    | "style6"
    | "style7"
    | "style8"
    | "style9";
  format: string;
  dateDefault?: "custom" | "now";
  dateRange?: DateRange;
  /** Missing in historical schemas: keep their optional, partial addresses valid. */
  addressComplete?: boolean;
  min?: number;
  max?: number;
  precision: number;
  retainPrecision?: boolean;
  numberGrouping?: boolean;
  limitRange?: boolean;
  maxLength: number;
  rows: number;
  expression: string;
  accept: string;
  multiple: boolean;
  limitFileTypes?: boolean;
  maxFileSize?: number;
  uploadStyle?: "card" | "list";
  choiceSource: ChoiceSource;
  organization: OrganizationFieldConfig;
  reference: ReferenceConfig;
  referenceFormId: string;
  referenceFieldId: string;
  buttonText: string;
  masked: boolean;
  /** Absent in historical schemas: retain their existing SN numbering behavior. */
  serial?: SerialSettings;
}
export interface VisibilityCondition {
  valueType?: "text" | "choice";
  sourceId: string;
  operator: "equals" | "notEquals" | "contains" | "greater" | "empty";
  value: string;
}
/** Historical single conditions combine with AND for each target. */
export interface LegacyVisibilityRule extends VisibilityCondition {
  id: string;
  targetIds: string[];
}
export interface ConditionalVisibilityRule {
  id: string;
  conditions: VisibilityCondition[];
  match: "all" | "any";
  targetIds: string[];
  /** Preserves historical rules whose hidden sources still participated. */
  cascade?: false;
}
export type VisibilityRule = LegacyVisibilityRule | ConditionalVisibilityRule;
export interface FormValidationRule {
  id: string;
  expression: string;
  message: string;
  realtime: boolean;
  mode: "block" | "warn";
  remark?: string;
}
export type HiddenValueMode = "retain" | "clear" | "recalculate";
export interface FormTitleLayout {
  labelPosition: "top" | "left";
  labelWidth: number;
  labelAlignment: "left" | "right";
  descriptionMode: "show" | "popover";
}
export interface FormSchema {
  version: 1;
  fields: FormField[];
  settings: {
    description: string;
    layout: 1 | 2 | 3 | 4;
    labelPosition: "top" | "left";
    labelWidth: number;
    labelAlignment?: FormTitleLayout["labelAlignment"];
    descriptionMode?: FormTitleLayout["descriptionMode"];
    inputWidth?: "standard" | "auto";
    /** Absent in historical forms, whose mobile titles remain above the control. */
    mobileLayout?: FormTitleLayout;
    /** Theme IDs follow the fixed external-form template catalogue. */
    externalStyle?: ExternalFormStyle;
    frontendEvents?: import("./frontend-events").FrontendEvent[];
    cacheDraft: boolean;
    hiddenValues: HiddenValueMode;
    /** Absent in historical definitions; an empty map opts into the current assignment rules. */
    hiddenValueRules?: Record<string, HiddenValueMode>;
    submitLabel: string;
    allowSubmit?: boolean;
    allowDraft: boolean;
    draftLabel?: string;
    successMessage: string;
    successMode: "inline" | "page";
    allowAnotherSubmission: boolean;
    rules: VisibilityRule[];
    validations?: FormValidationRule[];
  };
}

export type FormValues = Record<string, unknown>;
