import type { DataFilter, FormValues } from "./form";
import type { FieldPermission } from "./index";

/** A business relationship is independent from its visual form placement. */
export interface RelationSpec {
  title: string;
  sourceDefinitionId: string;
  targetDefinitionId: string;
  sourceSubformId?: string;
  cardinality: "one" | "many";
  inverseCardinality: "one" | "many";
  labelFieldId: string;
  columns: string[];
  filters: DataFilter[];
  mappings: { fromTargetFieldId: string; toSourceFieldId: string }[];
  valueMode: "live" | "snapshot";
}
export interface RelationDefinition {
  id: string;
  revision: number;
  latestVersion: number;
  spec: RelationSpec;
  hasDraftChanges?: boolean;
}
export interface RelationCandidate {
  recordId: string;
  label: string;
  definitionVersion: number;
  values: FormValues;
  displayValues?: Record<string, string>;
  revision: number;
  mappings?: { fieldId: string; label: string; before: unknown; value: unknown; beforeLabel?: string; valueLabel?: string }[];
}
export interface RelationLinkView {
  id: string;
  relationId: string;
  relationVersion: number;
  targetRecordId: string;
  sourceRecordId?: string;
  sourceRowId?: string;
  label: string;
  values: FormValues;
  displayValues?: Record<string, string>;
  restricted: boolean;
  valueMode: "live" | "snapshot";
  createdAt: string;
}
export interface RecordRelationGroup {
  relation: RelationDefinition;
  permission: FieldPermission;
  columnLabels: Record<string, string>;
  links: RelationLinkView[];
  direction?: "outgoing" | "incoming";
  canLink?: boolean;
  unavailableReason?: string;
}
export interface RelationCandidatesPage { items: RelationCandidate[]; nextCursor: string | null; columnLabels: Record<string, string>; relationVersion: number }
