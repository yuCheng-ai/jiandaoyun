import { computed, ref, watch, type Ref } from "vue";
import { defineStore, storeToRefs } from "pinia";
import {
  directoryCanonical,
  type DirectorySnapshot,
  type DirectorySpec,
} from "@platform/contracts";
import { copy } from "../domain/form";
import { emptyOrganization, type Organization } from "../domain/organization";
import { platformApi, PlatformError } from "../repositories/platformApi";
import { organizationActions } from "./organizationActions";
import { usePlatformSession } from "./platformSession";
import { useNotices } from "./notices";

type Actions = Omit<ReturnType<typeof organizationActions>, "setCurrentUser">;
type AsyncActions = {
  [K in keyof Actions]: (...args: Parameters<Actions[K]>) => Promise<boolean>;
};
const specOf = ({ currentUserId: _, ...spec }: Organization): DirectorySpec =>
  copy(spec);

export const useOrganizationStore = defineStore("organization", () => {
  const session = usePlatformSession(),
    feedback = useNotices();
  const { notices } = storeToRefs(feedback);
  const organization = ref(emptyOrganization()) as Ref<Organization>;
  const snapshot = ref<DirectorySnapshot>();
  const loaded = ref(false),
    loading = ref(false),
    pending = ref(false),
    error = ref("");
  const namespace = computed(() => snapshot.value?.namespace || "");
  const ready = computed(() => loaded.value && session.user?.role === "admin");
  let generation = 0,
    inFlight: Promise<boolean> | undefined;
  let previous = "",
    requestId = "",
    initialNamespace = "";
  watch(
    () => (session.user ? `${session.user.id}:${session.user.role}` : ""),
    () => {
      generation++;
      organization.value = emptyOrganization();
      snapshot.value = undefined;
      loaded.value = loading.value = pending.value = false;
      error.value = previous = requestId = initialNamespace = "";
      inFlight = undefined;
    },
    { flush: "sync" },
  );
  function apply(saved: DirectorySnapshot | null) {
    snapshot.value = saved ? copy(saved) : undefined;
    // Directory member IDs are not login account IDs. Never infer the actor from a name or role.
    organization.value = saved
      ? { ...copy(saved.spec), currentUserId: "" }
      : emptyOrganization();
    loaded.value = true;
    error.value = "";
  }
  function load(): Promise<boolean> {
    if (inFlight) return inFlight;
    if (session.user?.role !== "admin") return Promise.resolve(false);
    const requested = generation;
    loading.value = true;
    error.value = "";
    const task = (async () => {
      try {
        const result = await platformApi<{
          directory: DirectorySnapshot | null;
        }>("/organization/directory");
        if (requested !== generation) return false;
        if (
          snapshot.value &&
          (!result.directory ||
            (snapshot.value.namespace === result.directory.namespace &&
              snapshot.value.revision > result.directory.revision))
        )
          return true;
        apply(result.directory);
        return true;
      } catch (cause) {
        if (requested === generation) error.value = (cause as Error).message;
        return false;
      } finally {
        if (requested === generation) {
          loading.value = false;
          inFlight = undefined;
        }
      }
    })();
    inFlight = task;
    return task;
  }
  const names: (keyof Actions)[] = [
    "saveDepartment",
    "archiveDepartment",
    "saveEmployee",
    "bulkEmployees",
    "saveRole",
    "archiveRole",
    "saveRoleGroup",
    "removeRoleGroup",
  ];
  const actions = Object.fromEntries(
    names.map((name) => [
      name,
      async (...args: any[]) => {
        if (pending.value || loading.value) {
          feedback.notify("通讯录正在保存或读取，请稍候", "warning");
          return false;
        }
        if (!ready.value) {
          feedback.notify("请先读取通讯录，再保存修改", "warning");
          return false;
        }
        const requested = generation;
        const candidate = ref(copy(organization.value)) as Ref<Organization>;
        const reducer = organizationActions(
          candidate,
          () => true,
          feedback.notify,
          false,
        );
        if (
          !(reducer[name] as (...args: any[]) => boolean)(
            ...args.map((item) =>
              item === undefined ? undefined : copy(item),
            ),
          )
        )
          return false;
        // A new installation starts empty. Create its directory only on the first explicit save.
        if (!snapshot.value && !initialNamespace)
          initialNamespace = crypto.randomUUID();
        const body = {
          namespace: snapshot.value?.namespace || initialNamespace,
          ...(snapshot.value ? { before: copy(snapshot.value.spec) } : {}),
          spec: specOf(candidate.value),
        };
        const fingerprint = directoryCanonical(body);
        if (fingerprint !== previous) {
          previous = fingerprint;
          requestId = crypto.randomUUID();
        }
        pending.value = true;
        try {
          const saved = await platformApi<DirectorySnapshot>(
            "/organization/directory",
            snapshot.value ? "PUT" : "POST",
            { ...body, requestId },
          );
          if (requested !== generation) return false;
          apply(saved);
          return true;
        } catch (cause) {
          if (requested !== generation) return false;
          // Refresh the committed baseline; the dialog retains its independent unsaved input.
          if (cause instanceof PlatformError && cause.status === 409)
            await load();
          if (requested === generation)
            feedback.notify((cause as Error).message, "warning");
          return false;
        } finally {
          if (requested === generation) pending.value = false;
        }
      },
    ]),
  ) as AsyncActions;
  return {
    organization,
    namespace,
    snapshot,
    ready,
    loading,
    pending,
    error,
    load,
    notices,
    notify: feedback.notify,
    ...actions,
  };
});
