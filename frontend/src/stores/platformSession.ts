import { accessGroupActor } from "../repositories/accessGroupState";
import { defineStore } from "pinia";
import { ref } from "vue";
import type { SessionUser } from "@platform/contracts";
import { platformApi, PlatformError } from "../repositories/platformApi";
export const usePlatformSession = defineStore("platform-session", () => {
  const user = ref<SessionUser | null>(null);
  async function restore() {
    try {
      user.value = await platformApi<SessionUser>("/auth/me");
      accessGroupActor(user.value.id);
    } catch (error) {
      user.value = null;
      accessGroupActor(null);
      if (!(error instanceof PlatformError) || error.status !== 401)
        throw error;
    }
  }
  async function login(username: string, password: string) {
    user.value = await platformApi<SessionUser>("/auth/login", "POST", {
      username,
      password,
    });
    accessGroupActor(user.value.id);
  }
  async function logout() {
    await platformApi("/auth/logout", "POST", {});
    user.value = null;
    accessGroupActor(null);
  }
  return { user, restore, login, logout };
});
