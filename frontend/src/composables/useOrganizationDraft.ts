import { ref, watch } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { useWorkspaceStore } from "../stores/workspace";
import {
  organizationEditContext,
  type OrganizationEditScope,
} from "../domain/organizationDraftAdapters";
import { useDraftDismiss } from "./useDraftDismiss";

/** Shared recovery and write acknowledgement for organization editors. */
export function useOrganizationDraft(options: {
  active: () => boolean;
  key: () => string;
  title: () => string;
  value: () => unknown;
  restore: (value: unknown) => void;
  close: () => void;
}) {
  const store = useWorkspaceStore(),
    router = useRouter();
  const busy = ref(false),
    error = ref(""),
    destination = ref("");
  let baseline = "",
    initial = "";
  const context = () => {
    const [, kind, id] = options.key().split(":");
    return organizationEditContext(store.data, {
      kind: kind?.startsWith("bulk-")
        ? "bulk"
        : (kind as OrganizationEditScope["kind"]),
      ids: (id || "new").split(","),
    });
  };
  watch(
    options.active,
    (open) => {
      if (open) {
        baseline = context();
        initial = JSON.stringify(options.value());
        error.value = "";
        destination.value = "";
      }
    },
    { flush: "sync" },
  );
  function close() {
    options.close();
    const target = destination.value;
    destination.value = "";
    if (target) void router.push(target);
  }
  const recovery = useDraftDismiss(options.active, options.value, close, {
    key: options.key,
    title: options.title,
    context,
    restore(value) {
      options.restore(value);
      recovery.confirmDiscard.value = false;
      error.value = "";
    },
  });
  function requestClose() {
    if (!busy.value) recovery.requestClose();
  }
  async function save(
    action: (expectedContext: string) => Promise<unknown>,
    onSuccess: () => void,
  ) {
    if (busy.value) return false;
    error.value = "";
    if (context() !== baseline) {
      error.value =
        "组织或授权对象已变化，当前输入已保留。请重新打开编辑器核对后保存。";
      return false;
    }
    busy.value = true;
    const previousNotices = new Set(
      (store.notices || []).map((notice) => notice.id),
    );
    try {
      if ((await action(baseline)) !== true) {
        const issue = (store.notices || []).find(
          (notice) =>
            !previousNotices.has(notice.id) && notice.type !== "success",
        );
        error.value = issue
          ? issue.message
          : "保存未完成，请稍后重试；当前修改已保留。";
        return false;
      }
      recovery.markSaved();
      onSuccess();
      options.close();
      return true;
    } catch {
      error.value = "保存失败，当前修改已保留，请重试。";
      return false;
    } finally {
      busy.value = false;
    }
  }
  onBeforeRouteLeave((to) => {
    if (busy.value) return false;
    if (options.active() && JSON.stringify(options.value()) !== initial) {
      destination.value = to.fullPath;
      recovery.requestClose();
      return false;
    }
    return true;
  });
  function continueEditing() {
    destination.value = "";
    recovery.confirmDiscard.value = false;
  }
  return { ...recovery, busy, error, requestClose, save, continueEditing };
}
