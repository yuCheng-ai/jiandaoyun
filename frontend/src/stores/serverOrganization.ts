import { ref, type Ref } from "vue";
import {
  directoryCanonical,
  type DirectorySnapshot,
  type DirectorySpec,
} from "@platform/contracts";
import type { WorkspaceData } from "../domain/workspace";
import { copy } from "../domain/form";
import { organizationActions } from "./organizationActions";
import { platformApi, PlatformError } from "../repositories/platformApi";
import { LocalWorkspaceRepository } from "../repositories/workspaceRepository";
import {
  memberAccountNamespace,
  setMemberAccountNamespace,
} from "../repositories/memberAccounts";
import { withWorkspaceWriteLock } from "../repositories/workspaceWriteLock";
import type { Organization } from "../domain/organization";

const specOf = (org: Organization): DirectorySpec => {
  const { currentUserId: _current, ...spec } = copy(org);
  return spec;
};
type Actions = Omit<ReturnType<typeof organizationActions>, "setCurrentUser">;
type AsyncActions = {
  [K in keyof Actions]: (...args: Parameters<Actions[K]>) => Promise<boolean>;
};

export function serverOrganization(
  data: Ref<WorkspaceData>,
  accept: (org: Organization) => void,
  notify: (message: string, type?: string) => void,
) {
  const snapshot = ref<DirectorySnapshot>(),
    loading = ref(false),
    error = ref(""),
    pending = ref(false);
  let inFlight: Promise<boolean> | undefined;
  async function apply(saved: DirectorySnapshot) {
    snapshot.value = saved;
    const currentUserId = saved.spec.employees.some(
      (item) =>
        item.id === data.value.organization.currentUserId &&
        item.status === "active",
    )
      ? data.value.organization.currentUserId
      : saved.spec.employees.find((item) => item.status === "active")?.id || "";
    const organization = { ...copy(saved.spec), currentUserId };
    accept(organization);
    try {
      await withWorkspaceWriteLock(() => {
        const repository = new LocalWorkspaceRepository(),
          latest = repository.load() || copy(data.value);
        latest.organization = copy(organization);
        repository.save(latest);
      });
    } catch {
      // A cache failure must not turn an already committed server command into a failed save.
      notify("通讯录已保存，重新打开页面可读取最新内容", "warning");
    }
  }
  function load(): Promise<boolean> {
    if (inFlight) return inFlight;
    loading.value = true;
    error.value = "";
    const task = (async () => {
      try {
        let { directory: saved } = await platformApi<{
          directory: DirectorySnapshot | null;
        }>("/organization/directory");
        const repository = new LocalWorkspaceRepository(),
          local = repository.load();
        if (!saved) {
          const namespace = await memberAccountNamespace();
          saved = await platformApi<DirectorySnapshot>(
            "/organization/directory",
            "POST",
            {
              requestId: crypto.randomUUID(),
              namespace,
              spec: specOf(local?.organization || data.value.organization),
            },
          );
        } else {
          const namespace = await memberAccountNamespace();
          if (namespace !== saved.namespace && local)
            throw Error(
              "此浏览器保留另一份通讯录，原资料已保留，暂不能覆盖保存",
            );
          await setMemberAccountNamespace(saved.namespace);
        }
        await apply(saved);
        return true;
      } catch (cause) {
        error.value = (cause as Error).message;
        return false;
      } finally {
        loading.value = false;
        inFlight = undefined;
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
  let previous = "",
    requestId = "";
  const actions = Object.fromEntries(
    names.map((name) => [
      name,
      async (...args: any[]) => {
        if (pending.value || loading.value) {
          notify("通讯录正在保存或读取，请稍候", "warning");
          return false;
        }
        if (!snapshot.value) {
          notify("请先读取通讯录，再保存修改", "warning");
          return false;
        }
        const captured = args.map((item) =>
            item === undefined ? undefined : copy(item),
          ),
          candidate = ref(copy(data.value)) as Ref<WorkspaceData>;
        const reducer = organizationActions(
          candidate,
          () => true,
          notify,
          false,
        );
        if (!(reducer[name] as (...args: any[]) => boolean)(...captured))
          return false;
        const body = {
          namespace: snapshot.value.namespace,
          before: copy(snapshot.value.spec),
          spec: specOf(candidate.value.organization),
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
            "PUT",
            { ...body, requestId },
          );
          await apply(saved);
          return true;
        } catch (cause) {
          // Refresh committed data only. The open dialog keeps its independent draft;
          // reopening it must not start again from the rejected server baseline.
          if (cause instanceof PlatformError && cause.status === 409)
            await load();
          notify((cause as Error).message, "warning");
          return false;
        } finally {
          pending.value = false;
        }
      },
    ]),
  ) as AsyncActions;
  return { snapshot, loading, error, pending, load, actions };
}
