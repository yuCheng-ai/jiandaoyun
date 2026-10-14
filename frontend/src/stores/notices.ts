import { ref } from "vue";

type NoticeType = "success" | "warning" | "error" | "info";

export interface NoticeItem {
  id: string;
  message: string;
  type: NoticeType;
}

const notices = ref<NoticeItem[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function dismiss(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  notices.value = notices.value.filter((notice) => notice.id !== id);
}

function notify(message: string, type = "success") {
  const text = message.trim();
  if (!text) return;
  const kind: NoticeType =
    type === "warning" || type === "error" || type === "info"
      ? type
      : "success";
  const existing = notices.value.find(
    (notice) => notice.message === text && notice.type === kind,
  );
  const id = existing?.id || crypto.randomUUID();
  if (existing) {
    clearTimeout(timers.get(id));
  } else {
    // 连续操作最多展示三条，避免提示堆满画布。
    if (notices.value.length >= 3) dismiss(notices.value[0]!.id);
    notices.value.push({ id, message: text, type: kind });
  }
  const duration = kind === "success" || kind === "info" ? 2500 : 6000;
  timers.set(
    id,
    setTimeout(() => dismiss(id), duration),
  );
}

/** 普通操作反馈统一去重和收起，不参与业务数据或表单校验状态。基于 Vue 原生响应式，无需 Pinia 运行时上下文。 */
export function useNotices() {
  return { notices, notify, dismiss };
}
