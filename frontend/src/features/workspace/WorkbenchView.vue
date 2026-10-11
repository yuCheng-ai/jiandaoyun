<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ApplicationSummary } from "@platform/contracts";
import { useWorkspaceStore } from "../../stores/workspace";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import { signInDestination } from "../../router/sessionGuard";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import WorkspaceHeader from "../../components/shared/WorkspaceHeader.vue";
import PlatformLogin from "../session/PlatformLogin.vue";
import ProcessWorkspace from "../processes/ProcessWorkspace.vue";
import WorkbenchProcessStart from "../processes/WorkbenchProcessStart.vue";
import "../collaboration/collaboration.css";
const store = useWorkspaceStore(),
  session = usePlatformSession();
const router = useRouter(),
  route = useRoute();
const query = ref(""),
  tab = ref("apps");
const workMenu = [
  { id: "todo", title: "我的待办", icon: "bell" },
  { id: "started", title: "我发起的", icon: "start" },
  { id: "handled", title: "我处理的", icon: "archive" },
  { id: "copied", title: "抄送我的", icon: "copy" },
  { id: "launch", title: "发起流程", icon: "logout" },
  { id: "delegation", title: "待办委托", icon: "people" },
];
const processScope = computed(() =>
  ["todo", "started", "handled"].includes(tab.value)
    ? (tab.value as "todo" | "started" | "handled")
    : undefined,
);
const applications = ref<ApplicationSummary[]>([]),
  busy = ref(false),
  error = ref("");
const ready = ref(false),
  loadedActor = ref("");
const dialog = ref(false),
  appName = ref(""),
  saving = ref(false),
  saveError = ref("");
const apps = computed(() =>
  [
    ...(session.user?.role === "admin"
      ? store.data.apps.map((app) => ({
          id: `local:${app.id}`,
          title: app.name,
          color: app.color,
          icon: app.icon,
          path: `/apps/${app.id}`,
        }))
      : []),
    ...applications.value.map((app) => ({
      id: `server:${app.id}`,
      title: app.title,
      color: "#56ae72",
      icon: "department",
      path: `/applications/${app.id}`,
    })),
  ].filter((app) =>
    app.title.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
let disposed = false;
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.restore();
    if (disposed) return;
    if (!session.user || loadedActor.value !== session.user.id) {
      applications.value = [];
      dialog.value = false;
      tab.value = "apps";
    }
    loadedActor.value = session.user?.id || "";
    if (!session.user) return;
    const next = signInDestination(router, route.query.next);
    if (next) {
      await router.replace(next);
      return;
    }
    const actor = session.user.id;
    const result = await platformApi<ApplicationSummary[]>("/applications");
    if (!disposed && actor === session.user?.id) applications.value = result;
  } catch (cause) {
    applications.value = [];
    if (cause instanceof PlatformError && cause.status === 401) {
      try {
        await session.restore();
      } catch (failure) {
        error.value = (failure as Error).message;
      }
    } else error.value = (cause as Error).message;
  } finally {
    busy.value = false;
    ready.value = true;
  }
}
async function logout() {
  if (busy.value || saving.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.logout();
    applications.value = [];
    loadedActor.value = "";
    dialog.value = false;
    tab.value = "apps";
    await router.replace("/");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
function openCreate() {
  dialog.value = true;
  appName.value = saveError.value = "";
}
async function createApp() {
  if (saving.value || !appName.value.trim() || session.user?.role !== "admin")
    return;
  saving.value = true;
  saveError.value = "";
  try {
    const app = await store.createApp(appName.value.trim(), "#56ae72");
    if (!app) throw new Error(store.storageError || "创建失败，请重试");
    dialog.value = false;
    await router.push(`/apps/${app.id}`);
  } catch (cause) {
    saveError.value = (cause as Error).message;
  } finally {
    saving.value = false;
  }
}
// Recheck the session and authorized app list when returning from another tab.
function focused() {
  if (!dialog.value && tab.value === "apps") void load();
}
onMounted(() => {
  void load();
  window.addEventListener("focus", focused);
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("focus", focused);
});
</script>
<template>
  <div class="workspace-page">
    <WorkspaceHeader
      v-if="session.user && ready"
      :account="session.user"
      :busy="busy"
      @home="tab = 'apps'"
      @directory="router.push('/admin/organization')"
      @logout="logout"
    />
    <header v-else class="workspace-header">
      <div class="workspace-brand">
        <AppIcon name="cloud" :size="27" class="brand-cloud" /><strong
          >工作台</strong
        >
      </div>
    </header>
    <main class="workbench-scroll">
      <div class="workbench-content">
        <p v-if="error" class="collab-error workbench-message" role="alert">
          {{ error }}
          <button class="button" :disabled="busy" @click="load">重试</button>
        </p>
        <p v-if="busy" class="workbench-message" role="status">正在读取…</p>
        <PlatformLogin
          v-show="ready && !session.user && !busy && !error"
          @signed-in="load"
        />
        <div
          v-if="ready && session.user && loadedActor === session.user.id"
          class="workbench-columns"
        >
          <aside class="workbench-menu panel-card" aria-label="工作台导航">
            <button
              v-for="item in workMenu"
              :key="item.id"
              :class="{
                active: tab === item.id,
                'menu-separator': item.id === 'launch',
              }"
              :aria-current="tab === item.id ? 'page' : undefined"
              @click="tab = item.id"
            >
              <AppIcon :name="item.icon" :size="18" />{{ item.title }}
            </button>
          </aside>
          <div class="workbench-main">
            <p
              v-if="route.query.notice === 'access-denied'"
              class="collab-error"
              role="alert"
            >
              当前账号没有访问此页面的权限。
            </p>
            <button
              v-if="tab !== 'apps'"
              class="text-button workbench-back"
              @click="tab = 'apps'"
            >
              返回我的应用
            </button>
            <ProcessWorkspace
              v-if="processScope"
              :key="`${session.user.id}-${processScope}`"
              :scope="processScope"
            />
            <WorkbenchProcessStart
              v-else-if="tab === 'launch'"
              :applications="applications"
            />
            <section
              v-else-if="tab === 'copied' || tab === 'delegation'"
              class="panel-card apps-panel"
            >
              <header class="section-heading">
                <h2>{{ tab === "copied" ? "抄送我的" : "待办委托" }}</h2>
              </header>
              <p class="workspace-empty">
                {{
                  tab === "copied"
                    ? "抄送功能尚未接通。"
                    : "待办委托尚未接通，任务仍由原处理人办理。"
                }}
              </p>
            </section>
            <section v-else class="panel-card apps-panel">
              <header class="section-heading">
                <h2>我的应用</h2>
                <div class="section-actions">
                  <div class="search-input">
                    <AppIcon name="search" /><input
                      v-model="query"
                      aria-label="搜索应用"
                      placeholder="搜索应用"
                    />
                  </div>
                  <button class="button" :disabled="busy" @click="load">
                    刷新
                  </button>
                  <button
                    v-if="session.user.role === 'admin'"
                    class="button primary"
                    @click="openCreate"
                  >
                    <AppIcon name="add" />新建应用
                  </button>
                </div>
              </header>
              <div class="app-grid">
                <button
                  v-for="app in apps"
                  :key="app.id"
                  class="application-card"
                  @click="router.push(app.path)"
                >
                  <span
                    class="application-tile"
                    :style="{ background: app.color }"
                    ><AppIcon :name="app.icon" :size="29" /></span
                  ><span>{{ app.title }}</span>
                </button>
              </div>
              <p v-if="!busy && !error && !apps.length" class="workspace-empty">
                {{
                  query
                    ? "没有找到匹配的应用"
                    : session.user.role === "admin"
                      ? "还没有应用，点击“新建应用”开始。"
                      : "暂无可访问的应用，请联系管理员分配权限。"
                }}
              </p>
            </section>
          </div>
        </div>
      </div>
    </main>
    <BaseDialog
      :open="!!dialog"
      :busy="saving"
      title="新建应用"
      @close="dialog = false"
    >
      <form id="workbench-create-app" @submit.prevent="createApp">
        <div class="form-group">
          <label for="new-app-name">应用名称</label
          ><input
            id="new-app-name"
            v-model="appName"
            maxlength="40"
            placeholder="为应用起个名字"
          />
        </div>
        <p v-if="saveError" class="collab-error" role="alert">
          {{ saveError }}
        </p>
      </form>
      <template #footer
        ><button class="button" @click="dialog = false">取消</button
        ><button
          type="submit"
          form="workbench-create-app"
          class="button primary"
          :disabled="saving || !appName.trim()"
        >
          {{ saving ? "正在创建…" : "创建应用" }}
        </button></template
      >
    </BaseDialog>
  </div>
</template>
<style scoped>
.workbench-back {
  align-self: flex-start;
}
.workbench-message {
  margin: 0 0 20px;
}
@media (max-width: 650px) {
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
  .section-actions {
    flex-wrap: wrap;
  }
}
</style>
