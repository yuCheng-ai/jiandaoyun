import { checkedDraftValue, draftBytes } from "../domain/editorDrafts";

/** Move the old per-form cache only after the replacement has been durably retained. */
export function migrateLegacyFillCache(
  key: string,
  retain: (value: unknown) => boolean,
  storage?: Pick<Storage, "getItem" | "removeItem">,
): string {
  try {
    const target = storage || sessionStorage;
    const raw = target.getItem(key);
    if (!raw) return "";
    if (draftBytes(raw) > 1_000_000) throw Error("旧内容过大");
    if (!retain(checkedDraftValue(JSON.parse(raw))))
      return "上次填写内容暂未完成迁移，原内容已保留。";
    if (target.getItem(key) === raw) target.removeItem(key);
    return "";
  } catch {
    return "上次填写内容暂时无法恢复，原内容已保留，当前填写不受影响。";
  }
}
