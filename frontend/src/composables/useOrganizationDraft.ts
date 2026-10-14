import { ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { useOrganizationStore } from "../stores/organization";
import {
  directoryEditContext,
  type DirectoryEditScope,
} from "@platform/contracts";
import { usePlatformSession } from "../stores/platformSession";
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
  const store = useOrganizationStore();
  const session = usePlatformSession();
  const owner = () => `${session.user?.id || ""}:${store.namespace || "new"}`;
  // The first save assigns a server namespace; keep its recovery copy attached
  // to the editor that created it until the save acknowledgement clears it.
  const draftOwner = ref(owner());
  const key = () => `${draftOwner.value}:${options.key()}`;
  let baselineOwner = "";
  const busy = ref(false),
    error = ref("");
  let baseline = "";
  const context = () => {
    const [, kind, id] = options.key().split(":");
    return directoryEditContext(store.organization, {
      kind: kind?.startsWith("bulk-")
        ? "bulk"
        : (kind as DirectoryEditScope["kind"]),
      ids: (id || "new").split(","),
    });
  };
  watch(
    options.active,
    (open) => {
      if (open) {
        baseline = context();
        baselineOwner = owner();
        draftOwner.value = baselineOwner;
        error.value = "";
      }
    },
    { flush: "sync" },
  );
  const recovery = useDraftDismiss(options.active, options.value, options.close, {
    key,
    title: options.title,
    context: () => ({ owner: owner(), directory: context() }),
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
    if (owner() !== baselineOwner || context() !== baseline) {
      error.value =
        "组织或授权对象已变化，当前输入已保留。请重新打开编辑器核对后保存。";
      return false;
    }
    busy.value = true;
    try {
      if ((await action(baseline)) !== true) {
        error.value =
          store.actionError || "保存未完成，请稍后重试；当前修改已保留。";
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
  const confirmLeave = () => !busy.value && recovery.confirmLeave();
  onBeforeRouteLeave(confirmLeave);
  onBeforeRouteUpdate(confirmLeave);
  function continueEditing() {
    recovery.confirmDiscard.value = false;
  }
  return { ...recovery, busy, error, requestClose, save, continueEditing };
}
