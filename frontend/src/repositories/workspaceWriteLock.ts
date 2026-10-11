/** All workspace writers, including recovery, use the same origin-scoped lock. */
export const WORKSPACE_WRITE_LOCK = "workflow-studio-workspace-write-v1";
let holdingWriteLock = false;

export function assertWorkspaceWriteLock() {
  if (!holdingWriteLock)
    throw Error("工作空间写入必须在受保护的保存操作内执行");
}

/** The callback stays synchronous: mutation, comparison, write and rollback cannot yield. */
export async function withWorkspaceWriteLock<T>(action: () => T): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request)
    throw Error(
      "当前环境不支持安全保存。请在 HTTPS 或本机地址使用支持 Web Locks 的浏览器；当前修改仍可导出备份。",
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    return await navigator.locks.request(
      WORKSPACE_WRITE_LOCK,
      { mode: "exclusive", signal: controller.signal },
      (lock) => {
        if (!lock)
          throw Error(
            "其他页面正在保存，本次操作尚未执行。请稍后重试，当前输入仍保留。",
          );
        holdingWriteLock = true;
        try {
          return action();
        } finally {
          holdingWriteLock = false;
        }
      },
    );
  } catch (error) {
    if (controller.signal.aborted)
      throw Error("保存等待超时，当前输入已保留，请重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
