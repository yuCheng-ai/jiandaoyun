/** Current submission rules belong to the shared data object, across page versions. */
export interface CollectionRules {
  enabled: boolean;
  startsAt: string;
  endsAt: string;
  limit: number;
  allowRepeat: boolean;
}
export interface CollectionConfiguration {
  revision: number;
  rules: CollectionRules;
  submittedRecords: number;
}
export interface CollectionStatus {
  accepting: boolean;
  code: "open" | "paused" | "not-started" | "ended" | "full" | "repeated";
  reason?: string;
  checkedAt: string;
}
export const defaultCollectionRules = (): CollectionRules => ({
  enabled: true,
  startsAt: "",
  endsAt: "",
  limit: 0,
  allowRepeat: true,
});
