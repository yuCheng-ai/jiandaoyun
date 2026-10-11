export interface LegacyRecordLifecycle {
  status: "draft" | "submitted" | "approved" | "rejected";
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  currentNodeId?: string;
  history: { label: string; action: string; time: string }[];
}
export interface RecordOrigin extends LegacyRecordLifecycle {
  sourceRecordId: string;
  sourceFormId: string;
  sourceApplicationName: string;
  sourceFormName: string;
  sourceVersion: number;
  sourceCreatorName: string;
  sourceDepartments: { sourceId: string; name: string; targetId: string }[] | null;
  importedAt: string;
  importedBy: string;
}
export const legacyRecordStatusLabel = (status: LegacyRecordLifecycle["status"]): string => ({ draft: "草稿", submitted: "已提交", approved: "已通过", rejected: "已退回" })[status];
