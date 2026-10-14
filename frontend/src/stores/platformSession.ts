import { accessGroupActor } from "../repositories/accessGroupState";
import { defineStore } from "pinia";
import { ref } from "vue";
import type { SessionUser } from "@platform/contracts";
import { platformApi, PlatformError } from "../repositories/platformApi";
export const usePlatformSession = defineStore("platform-session", () => {
  const user = ref<SessionUser | null>(null);
  let revision = 0,
    restoring: Promise<void> | undefined;
  function setUser(account: SessionUser | null) {
    user.value = account;
    accessGroupActor(account?.id || null);
  }
  function restore(): Promise<void> {
    if (restoring) return restoring;
    const requestedRevision = revision;
    const pending = (async () => {
      try {
        const account = await platformApi<SessionUser>("/auth/me");
        if (requestedRevision === revision) setUser(account);
      } catch (error) {
        if (requestedRevision !== revision) return;
        // 只有鉴权失败才清空身份，服务故障不能被当作退出登录。
        if (!(error instanceof PlatformError) || error.status !== 401)
          throw error;
        setUser(null);
      }
    })();
    restoring = pending;
    void pending
      .finally(() => {
        if (restoring === pending) restoring = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async function login(username: string, password: string) {
    const requestedRevision = ++revision;
    restoring = undefined;
    const account = await platformApi<SessionUser>("/auth/login", "POST", {
      username,
      password,
    });
    if (requestedRevision === revision) setUser(account);
  }
  async function logout() {
    const requestedRevision = ++revision;
    restoring = undefined;
    await platformApi("/auth/logout", "POST", {});
    if (requestedRevision === revision) setUser(null);
  }
  return { user, restore, login, logout };
});
