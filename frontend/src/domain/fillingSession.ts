import type {
  FormEntry,
  PublishedDefinition,
  WorkspaceData,
} from "./workspace";

export interface FillingSession {
  definition?: PublishedDefinition;
  draft?: FormEntry;
  issue?: string;
}

/** A saved filling draft keeps its identity, owner and original publication. */
export function fillingSession(
  data: WorkspaceData,
  formId: string,
  draftId: string | undefined,
  actor: string,
): FillingSession {
  const form = data.forms.find((f) => f.id === formId && !f.archived);
  if (!form?.published) return { issue: "表单尚未发布或已停用" };
  if (!draftId) return { definition: form.published };
  const draft = data.entries.find(
    (e) => e.id === draftId && e.formId === formId,
  );
  if (!draft || draft.deletedAt)
    return { issue: "这份填写草稿已不存在，请返回记录管理检查。" };
  if (draft.createdBy !== actor)
    return { issue: "只能继续填写自己保存的草稿。" };
  if (draft.status !== "draft")
    return { issue: "这份草稿已经提交，请到记录管理查看记录。" };
  const definition =
    form.versions.find((v) => v.version === draft.definitionVersion) ||
    (form.published.version === draft.definitionVersion
      ? form.published
      : undefined);
  if (!definition)
    return { issue: "草稿对应的表单版本无法读取，原内容已保留。" };
  return { definition, draft };
}
