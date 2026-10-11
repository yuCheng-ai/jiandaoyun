import { ref } from "vue";
import { copy } from "../domain/form";
import { withWorkspaceWriteLock } from "../repositories/workspaceWriteLock";

type Action = (...args: any[]) => any;
type SynchronousActions<T extends Record<string, Action>> = {
  [K in keyof T]: Extract<ReturnType<T[K]>, PromiseLike<unknown>> extends never
    ? T[K]
    : never;
};
type GuardedActions<T extends Record<string, Action>> = {
  [K in keyof T]: (
    ...args: Parameters<T[K]>
  ) => Promise<ReturnType<T[K]> | undefined>;
};

/** Only public persistence actions cross the asynchronous boundary. Internal calls stay synchronous. */
export function workspaceWrites<T extends Record<string, Action>>(
  actions: T & SynchronousActions<T>,
  onError: (message: string) => void,
  beforeAction?: (name: keyof T, args: any[]) => void,
) {
  const writePending = ref(false);
  const guarded = Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      async (...args: unknown[]) => {
        if (writePending.value) {
          onError("本页正在保存，请等待完成后再操作。");
          return;
        }
        writePending.value = true;
        try {
          // Dialog inputs can be reactive; capture their values before the lock request yields.
          const captured = args.map((value) =>
            value === undefined
              ? undefined
              : value instanceof Date
                ? new Date(value)
                : copy(value),
          );
          return await withWorkspaceWriteLock(() => {
            beforeAction?.(name, captured);
            return action(...captured);
          });
        } catch (error) {
          onError(
            error instanceof Error
              ? error.message
              : "保存未完成，当前输入已保留，请重试。",
          );
          return;
        } finally {
          writePending.value = false;
        }
      },
    ]),
  ) as unknown as GuardedActions<T>;
  return { guarded, writePending };
}
