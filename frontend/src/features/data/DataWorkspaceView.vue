<script setup lang="ts">
import OrganizationDialog from "../collaboration/OrganizationDialog.vue";
import PlatformLogin from "../session/PlatformLogin.vue";
import ApplicationMigrationEntry from "./ApplicationMigrationEntry.vue";
import RecordGroupSelector from "../collaboration/RecordGroupSelector.vue";
import {
  accessGroupReady,
  recordGroupOptions,
} from "../../repositories/accessGroupSelection";
import type { RecordGroupOptions } from "@platform/contracts";
import { serverDataKindLabels } from "@platform/contracts";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  pageForModel,
  type ApplicationSummary,
  type DataModel,
  type DataObjectDraft,
  type DefinitionSummary,
  type PageEditorData,
  type PageSummary,
  type PublishedAccess,
  type RecordDetail,
  type RecordSummary,
} from "@platform/contracts";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi } from "../../repositories/platformApi";
import { modelFields } from "../../domain/pageDesigner";
import {
  applicationResourceTab,
  applicationDataLocation,
  type ApplicationResourceTab,
} from "../../domain/applicationNavigation";
import BaseDialog from "../../components/BaseDialog.vue";
import RecordEditor from "../collaboration/RecordEditor.vue";
import {
  recordStateForAccess,
  recordSavedNotice,
  canReadRecordDrafts,
} from "../../domain/serverRecords";
import DataObjectEditor from "./DataObjectEditor.vue";
import CollectionDialog from "./CollectionDialog.vue";
import PendingPageFields from "./PendingPageFields.vue";
import PageLifecycleDialog from "./PageLifecycleDialog.vue";
import RecordUpgradeDialog from "./RecordUpgradeDialog.vue";
import RelationManager from "./RelationManager.vue";
import ProcessWorkspace from "../processes/ProcessWorkspace.vue";
import PermissionDialog from "../collaboration/PermissionDialog.vue";
import type {
  AccessGrant,
  ServerDefinition,
  SessionUser,
} from "@platform/contracts";
import "../collaboration/collaboration.css";
import "./data-workspace.css";
const showOrganization = ref(false);
const showMigration = ref(false),
  showTasks = ref(false);
async function logout() {
  await run(async () => {
    await session.logout();
    applications.value = [];
    objects.value = [];
    pages.value = [];
    selectedObject.value = undefined;
  });
}
const collectingDefinition = ref<{ id: string; title: string }>();
const session = usePlatformSession(),
  route = useRoute(),
  router = useRouter();
const applications = ref<ApplicationSummary[]>([]),
  objects = ref<DefinitionSummary[]>([]),
  pages = ref<PageSummary[]>([]);
const archivedPages = ref<PageSummary[]>([]);
const pageState = computed({
  get: () => (route.query.pages === "archived" ? "archived" : "active"),
  set: (value: string) => {
    router.push({
      path: route.path,
      query: {
        ...route.query,
        pages: value === "archived" ? value : undefined,
      },
    });
  },
});
const visiblePages = computed(() =>
  pageState.value === "archived" ? archivedPages.value : pages.value,
);
const lifecyclePage = ref<PageSummary>();
async function lifecycleSaved(page: PageSummary) {
  lifecyclePage.value = undefined;
  notice.value = page.archivedAt
    ? "页面已归档，数据与已发任务保留。"
    : "页面已恢复，沿用原版本和草稿。";
  await run(refresh);
}
const selectedObject = ref<DataObjectDraft>(),
  editingObject = ref(false),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const tab = computed({
  get: () =>
    session.user?.role !== "admin" && route.query.tab === "objects"
      ? "pages"
      : applicationResourceTab(route.query.tab),
  set: (value: ApplicationResourceTab) => {
    router.push({
      path: route.path,
      query: { ...route.query, tab: value === "pages" ? undefined : value },
    });
  },
});
const appId = computed(() => String(route.params.applicationId || ""));
const application = computed(() =>
  applications.value.find((item) => item.id === appId.value),
);
let refreshRequested = false;
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
    if (refreshRequested && session.user) {
      refreshRequested = false;
      await run(refresh);
    }
  }
}
async function refresh() {
  refreshRequested = false;
  const requestedApp = appId.value;
  if (!application.value) throw new Error("应用不存在或尚未授权。");
  const result = await Promise.all([
    platformApi<DefinitionSummary[]>(
      `/data-objects?applicationId=${requestedApp}`,
    ),
    platformApi<PageSummary[]>(`/pages?applicationId=${requestedApp}`),
    session.user?.role === "admin"
      ? platformApi<PageSummary[]>(
          `/pages?applicationId=${requestedApp}&state=archived`,
        )
      : Promise.resolve([]),
  ]);
  if (requestedApp !== appId.value) return;
  [objects.value, pages.value, archivedPages.value] = result;
  const requestedObject =
    typeof route.query.object === "string"
      ? route.query.object
      : selectedObject.value?.id;
  selectedObject.value = undefined;
  if (requestedObject && session.user?.role === "admin") {
    if (!objects.value.some((item) => item.id === requestedObject))
      throw new Error(
        "此数据对象不属于当前应用或已不可访问，请从左侧重新选择。",
      );
    const object = await platformApi<DataObjectDraft>(
      `/data-objects/${requestedObject}/draft`,
    );
    if (
      requestedApp === appId.value &&
      (!route.query.object || route.query.object === requestedObject)
    )
      selectedObject.value = object;
  }
}
async function load() {
  await session.restore();
  if (!session.user) return;
  applications.value = await platformApi<ApplicationSummary[]>("/applications");
  if (!appId.value) {
    if (applications.value[0])
      await router.replace({
        path: `/applications/${applications.value[0].id}`,
        query: route.query,
      });
    return;
  }
  if (!application.value) throw new Error("应用不存在或尚未授权。");
  await refresh();
}
onMounted(() => run(load));
watch(
  [
    appId,
    () => route.query.object,
    () => route.query.tab,
    () => route.query.pages,
  ],
  ([currentApp, currentObject], [previousApp, previousObject]) => {
    if (currentApp !== previousApp) {
      selectedObject.value = undefined;
      objects.value = [];
      pages.value = [];
      archivedPages.value = [];
      lifecyclePage.value = undefined;
      runningPage.value = undefined;
      editingRecord.value = false;
      upgradingRecord.value = undefined;
    } else if (
      currentObject !== previousObject &&
      selectedObject.value?.id !== currentObject
    )
      selectedObject.value = undefined;
    if (session.user) {
      refreshRequested = true;
      if (!busy.value) run(refresh);
    }
  },
);
const dialog = ref<"application" | "page" | "object" | "">(""),
  title = ref(""),
  sourceId = ref(""),
  mode = ref("new");
let pendingKey = "",
  pendingFingerprint = "";
function openDialog(kind: typeof dialog.value) {
  dialog.value = kind;
  title.value = "";
  mode.value = "new";
  sourceId.value = "";
  error.value = "";
  pendingKey = "";
  pendingFingerprint = "";
}
async function create() {
  await run(async () => {
    if (!title.value.trim()) throw new Error("请填写名称。");
    const fingerprint = JSON.stringify([
      dialog.value,
      title.value,
      appId.value,
      mode.value,
      sourceId.value,
    ]);
    if (fingerprint !== pendingFingerprint) {
      pendingFingerprint = fingerprint;
      pendingKey = crypto.randomUUID();
    }
    if (dialog.value === "application") {
      const result = await platformApi<ApplicationSummary>(
        "/applications",
        "POST",
        { title: title.value, requestId: pendingKey },
      );
      applications.value =
        await platformApi<ApplicationSummary[]>("/applications");
      dialog.value = "";
      await router.push(`/applications/${result.id}`);
      await refresh();
    } else if (dialog.value === "object") {
      selectedObject.value = await platformApi<DataObjectDraft>(
        "/data-objects",
        "POST",
        {
          title: title.value,
          applicationId: appId.value,
          model: { version: 1, fields: [] },
        },
      );
      dialog.value = "";
      await router.push(
        applicationDataLocation(appId.value, selectedObject.value.id),
      );
      await refresh();
      editingObject.value = true;
    } else {
      let id: string;
      if (mode.value === "new") {
        const result = await platformApi<PageEditorData>(
          "/pages/new-business",
          "POST",
          {
            title: title.value,
            applicationId: appId.value,
            requestId: pendingKey,
          },
        );
        id = result.draft.id;
      } else {
        const object = objects.value.find(
          (item) => item.id === sourceId.value && item.latestVersion,
        );
        if (!object) throw new Error("请选择已发布的数据对象。");
        const model = await platformApi<DataModel>(
          `/data-objects/${object.id}/versions/${object.latestVersion}`,
        );
        const result = await platformApi<PageSummary>("/pages", "POST", {
          title: title.value,
          definitionId: object.id,
          definitionVersion: object.latestVersion,
          schema: pageForModel(model),
        });
        id = result.id;
      }
      dialog.value = "";
      await router.push(`/applications/${appId.value}/pages/${id}/design`);
    }
  });
}
async function selectObject(id: string) {
  if (busy.value) return;
  if (route.query.object !== id)
    await router.push(applicationDataLocation(appId.value, id));
  else await run(refresh);
}
const recordState = ref<"active" | "draft">("active");
const groupOptions = ref<RecordGroupOptions>();
const runningPage = ref<PageSummary>(),
  form = ref<PublishedAccess>(),
  records = ref<RecordSummary[]>([]),
  pageVersion = ref(1),
  editingRecord = ref(false),
  detail = ref<RecordDetail>();
const upgradingRecord = ref<RecordSummary>();
const permissionDefinition = ref<ServerDefinition>(),
  permissionUsers = ref<SessionUser[]>([]),
  permissionGrants = ref<AccessGrant[]>([]);
async function openPermissions() {
  if (!selectedObject.value) return;
  await run(async () => {
    const id = selectedObject.value!.id;
    const [access, users, grants] = await Promise.all([
      platformApi<PublishedAccess>(`/definitions/${id}`),
      platformApi<SessionUser[]>("/users"),
      platformApi<AccessGrant[]>(`/definitions/${id}/grants`),
    ]);
    permissionUsers.value = users;
    permissionGrants.value = grants;
    permissionDefinition.value = access.definition;
  });
}
const canOpen = (record: RecordSummary) =>
  (form.value?.compatibleVersions || [form.value?.definition.version]).includes(
    record.definitionVersion,
  );
function upgraded(result: RecordDetail) {
  upgradingRecord.value = undefined;
  detail.value = result;
  editingRecord.value = true;
  records.value = records.value.map((record) =>
    record.id === result.record.id
      ? {
          ...record,
          definitionVersion: result.record.definitionVersion,
          revision: result.record.revision,
          updatedAt: result.record.updatedAt,
        }
      : record,
  );
}
async function loadRecords() {
  const page = runningPage.value!;
  form.value = undefined;
  records.value = [];
  groupOptions.value = undefined;
  groupOptions.value = await recordGroupOptions(page.definitionId);
  if (!accessGroupReady(page.definitionId, groupOptions.value)) return;
  form.value = await platformApi<PublishedAccess>(
    `/pages/${page.id}/form?version=${pageVersion.value}`,
  );
  recordState.value = recordStateForAccess(
    form.value.access,
    recordState.value,
  );
  if (
    form.value.access.read ||
    (recordState.value === "draft" && form.value.access.create)
  )
    records.value = await platformApi<RecordSummary[]>(
      `/definitions/${page.definitionId}/records?state=${recordState.value}`,
    );
}
async function openPage(page: PageSummary) {
  await run(async () => {
    notice.value = "";
    runningPage.value = page;
    pageVersion.value = page.latestVersion;
    recordState.value = "active";
    form.value = undefined;
    await loadRecords();
  });
}
async function openRecord(record: RecordSummary) {
  await run(async () => {
    detail.value = await platformApi<RecordDetail>(
      `/pages/${runningPage.value!.id}/records/${record.id}?version=${pageVersion.value}`,
    );
    editingRecord.value = true;
  });
}
</script>
<template>
  <OrganizationDialog
    v-if="showOrganization"
    @close="showOrganization = false"
  />
  <div class="collab-page">
    <header class="collab-header">
      <RouterLink to="/">← 工作台</RouterLink
      ><strong>{{
        session.user?.role === "admin" ? "应用管理" : "我的应用"
      }}</strong>
      <div class="collab-header-end">
        <button
          v-if="session.user?.role === 'admin'"
          class="text-button"
          @click="showOrganization = true"
        >
          组织与成员</button
        ><button
          v-if="session.user"
          class="text-button"
          :disabled="busy"
          @click="showTasks = true"
        >
          {{ session.user.role === "admin" ? "流程进度" : "我的待办" }}</button
        ><button
          v-if="session.user?.role === 'admin'"
          class="text-button"
          :disabled="busy"
          @click="showMigration = true"
        >
          原应用迁移检查</button
        >{{ session.user?.name
        }}<button
          v-if="session.user"
          class="text-button"
          :disabled="busy"
          @click="logout"
        >
          退出登录
        </button>
      </div>
    </header>
    <main class="collab-main" :aria-busy="busy">
      <PlatformLogin v-if="!session.user && !busy" @signed-in="run(load)" />
      <div v-else-if="session.user" class="collab-toolbar">
        <div>
          <h1>{{ application?.title || "我的应用" }}</h1>
          <p class="collab-help">
            {{
              session.user.role === "admin"
                ? "设计表单、设置权限与流程，同一份数据可用于不同处理页面。"
                : "打开表单填写、查看记录，或处理流程中的待办。"
            }}
          </p>
        </div>
        <select
          class="data-application-switch"
          aria-label="选择应用"
          :value="appId"
          :disabled="busy"
          @change="
            router.push(
              `/applications/${($event.target as HTMLSelectElement).value}`,
            )
          "
        >
          <option v-for="item in applications" :key="item.id" :value="item.id">
            {{ item.title }}
          </option></select
        ><button
          v-if="session.user.role === 'admin'"
          class="button"
          :disabled="busy"
          @click="openDialog('application')"
        >
          新建应用
        </button>
      </div>
      <p v-if="busy" class="collab-notice" role="status">正在处理，请稍候…</p>
      <p
        v-if="error && !dialog && !runningPage"
        class="collab-error"
        role="alert"
      >
        {{ error }}
        <button class="button" :disabled="busy" @click="run(load)">重试</button>
      </p>
      <p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
      <template v-if="session.user && application">
        <nav class="data-resource-tabs" aria-label="应用资源">
          <button :class="{ active: tab === 'pages' }" @click="tab = 'pages'">
            {{ session.user.role === "admin" ? "表单页面" : "表单" }}</button
          ><button
            v-if="session.user.role === 'admin'"
            :class="{ active: tab === 'objects' }"
            @click="tab = 'objects'"
          >
            数据管理</button
          ><button
            :class="{ active: tab === 'processes' }"
            @click="tab = 'processes'"
          >
            {{ session.user.role === "admin" ? "流程" : "待办" }}
          </button>
        </nav>
        <section v-if="tab === 'pages'" class="panel-card collab-section">
          <div class="collab-toolbar">
            <div>
              <h2>{{ session.user.role === "admin" ? "表单页面" : "表单" }}</h2>
              <p class="collab-help">
                {{
                  session.user.role === "admin"
                    ? "按填写和处理场景配置表单，可复用同一份业务数据。"
                    : "选择表单开始填写或查看已有记录。"
                }}
              </p>
            </div>
            <button
              v-if="session.user.role === 'admin'"
              class="button primary"
              :disabled="busy"
              @click="openDialog('page')"
            >
              新建表单
            </button>
          </div>
          <div v-if="session.user.role === 'admin'" class="collab-toolbar">
            <label class="collab-field"
              >页面范围<select v-model="pageState" aria-label="页面范围">
                <option value="active">使用中的页面</option>
                <option value="archived">已归档页面</option>
              </select></label
            >
          </div>
          <table v-if="visiblePages.length" class="collab-table">
            <thead>
              <tr>
                <th>页面名称</th>
                <th>业务数据</th>
                <th>发布状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="page in visiblePages" :key="page.id">
                <td>{{ page.title }}</td>
                <td>
                  {{
                    objects.find((item) => item.id === page.definitionId)?.title
                  }}
                </td>
                <td>
                  {{ page.archivedAt ? "已归档 · " : ""
                  }}{{
                    page.latestVersion
                      ? `已发布 V${page.latestVersion}`
                      : "草稿"
                  }}
                </td>
                <td>
                  <RouterLink
                    v-if="session.user.role === 'admin'"
                    class="text-button"
                    :to="`/applications/${appId}/pages/${page.id}/design`"
                    >{{ page.archivedAt ? "查看表单" : "设计表单" }}</RouterLink
                  ><button
                    v-if="page.latestVersion && !page.archivedAt"
                    class="text-button"
                    :disabled="busy"
                    @click="openPage(page)"
                  >
                    打开表单</button
                  ><button
                    v-if="session.user.role === 'admin'"
                    class="text-button"
                    :disabled="busy"
                    @click="lifecyclePage = page"
                  >
                    {{ page.archivedAt ? "恢复页面" : "归档页面" }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="collab-empty">
            {{
              pageState === "archived"
                ? "暂无已归档页面。"
                : "暂无页面，创建表单后即可开始拖拽设计。"
            }}
          </div>
        </section>
        <ProcessWorkspace
          v-else-if="tab === 'processes'"
          :key="appId"
          :application-id="appId"
          :objects="objects"
          :pages="pages"
        />
        <section v-else>
          <div class="collab-toolbar">
            <div>
              <h2>数据对象</h2>
              <p class="collab-help">
                管理共享字段与约束。调整页面布局请进入表单页面。
              </p>
            </div>
            <button class="button primary" @click="openDialog('object')">
              新建数据对象
            </button>
          </div>
          <div class="data-object-grid">
            <aside class="panel-card collab-sidebar">
              <button
                v-for="object in objects"
                :key="object.id"
                class="collab-nav"
                :class="{ active: selectedObject?.id === object.id }"
                :disabled="busy"
                @click="selectObject(object.id)"
              >
                {{ object.title
                }}<small>{{
                  object.latestVersion ? `V${object.latestVersion}` : "草稿"
                }}</small>
              </button>
            </aside>
            <article class="panel-card data-object-details">
              <template v-if="selectedObject"
                ><div class="collab-toolbar">
                  <div>
                    <h2>{{ selectedObject.title }}</h2>
                    <p class="collab-help">
                      {{
                        pages.filter(
                          (page) => page.definitionId === selectedObject!.id,
                        ).length
                      }}
                      个页面使用此数据对象
                    </p>
                  </div>
                  <button
                    class="button"
                    :disabled="!selectedObject.latestVersion || busy"
                    @click="openPermissions"
                  >
                    数据权限</button
                  ><button
                    class="button"
                    :disabled="busy"
                    @click="
                      collectingDefinition = {
                        id: selectedObject.id,
                        title: selectedObject.title,
                      }
                    "
                  >
                    收集设置</button
                  ><button class="button" @click="editingObject = true">
                    编辑数据结构
                  </button>
                </div>
                <p
                  v-if="selectedObject.hasDraftChanges"
                  class="collab-notice"
                  role="status"
                >
                  以下显示已保存的数据草稿{{
                    selectedObject.latestVersion
                      ? `；正式数据仍使用 V${selectedObject.latestVersion}`
                      : "，尚未发布"
                  }}。
                </p>
                <p v-else class="collab-help">
                  以下字段与已发布 V{{ selectedObject.latestVersion }} 一致。
                </p>
                <table class="collab-table">
                  <thead>
                    <tr>
                      <th>字段名称</th>
                      <th>类型</th>
                      <th>约束</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="item in modelFields(selectedObject.model)"
                      :key="item.field.id"
                    >
                      <td :class="{ child: item.parentId }">
                        {{ item.parentId ? "↳ " : "" }}{{ item.field.name }}
                      </td>
                      <td>
                        {{
                          serverDataKindLabels[item.field.kind] ||
                          item.field.kind
                        }}
                      </td>
                      <td>
                        {{
                          item.field.required ? "永久必填" : "按页面要求填写"
                        }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p
                  v-if="!selectedObject.model.fields.length"
                  class="collab-help"
                >
                  当前数据草稿尚无字段。页面新增的字段会在发布后进入这里。
                </p>
                <PendingPageFields
                  :key="selectedObject.id"
                  :definition-id="selectedObject.id"
                  :application-id="appId"
                  :revision="selectedObject.revision" /><RelationManager
                  :key="selectedObject.id"
                  :source-id="selectedObject.id"
                  :objects="objects"
              /></template>
              <div v-else class="collab-empty">选择左侧数据对象查看字段。</div>
            </article>
          </div>
        </section>
      </template>
    </main>
    <BaseDialog
      :open="!!dialog"
      :title="
        dialog === 'application'
          ? '新建应用'
          : dialog === 'object'
            ? '新建数据对象'
            : '新建表单页面'
      "
      :busy="busy"
      @close="dialog = ''"
      ><label class="collab-field"
        >名称<input
          v-model="title"
          aria-label="新建名称"
          maxlength="100"
          autofocus /></label
      ><template v-if="dialog === 'page'"
        ><label class="collab-field"
          >业务数据<select v-model="mode">
            <option value="new">创建新的业务数据</option>
            <option value="existing">使用已有数据对象</option>
          </select></label
        ><label v-if="mode === 'existing'" class="collab-field"
          >选择数据对象<select v-model="sourceId">
            <option value="">请选择</option>
            <option
              v-for="object in objects.filter((item) => item.latestVersion)"
              :key="object.id"
              :value="object.id"
            >
              {{ object.title }}
            </option>
          </select></label
        >
        <p class="collab-help">
          {{
            mode === "new"
              ? "自动建立对应的数据对象草稿，直接拖入字段即可开始。"
              : "复用已有字段；页面布局与其他页面独立。"
          }}
        </p></template
      >
      <p v-if="error" role="alert" class="collab-error">{{ error }}</p>
      <template #footer
        ><button class="button" @click="dialog = ''">取消</button
        ><button class="button primary" @click="create">创建</button></template
      ></BaseDialog
    >
    <PageLifecycleDialog
      v-if="lifecyclePage"
      :page="lifecyclePage"
      :action="lifecyclePage.archivedAt ? 'restore' : 'archive'"
      @close="
        lifecyclePage = undefined;
        run(refresh);
      "
      @saved="lifecycleSaved"
    />
    <PermissionDialog
      v-if="permissionDefinition"
      :definition="permissionDefinition"
      :users="permissionUsers"
      :grants="permissionGrants"
      @close="permissionDefinition = undefined"
      @saved="
        permissionDefinition = undefined;
        notice = '数据权限已保存。';
      "
    />
    <DataObjectEditor
      v-if="editingObject && selectedObject"
      :object="selectedObject"
      @close="editingObject = false"
      @saved="
        async (object) => {
          selectedObject = object;
          editingObject = false;
          notice = '数据配置已保存。';
          await run(refresh);
        }
      "
    />
    <CollectionDialog
      v-if="collectingDefinition"
      :key="collectingDefinition.id"
      :definition-id="collectingDefinition.id"
      :title="collectingDefinition.title"
      @close="collectingDefinition = undefined"
      @saved="
        collectingDefinition = undefined;
        notice = '收集设置已保存，所有使用此数据的页面按新设置接收提交。';
      "
    />
    <BaseDialog
      :open="!!runningPage"
      :title="runningPage?.title || '表单'"
      width="900px"
      :busy="busy"
      @close="runningPage = undefined"
      ><RecordGroupSelector
        v-if="runningPage && groupOptions"
        :definition-id="runningPage.definitionId"
        :options="groupOptions"
        :busy="busy"
        @change="
          notice = '';
          run(loadRecords);
        "
      />
      <div class="collab-toolbar">
        <label
          >页面版本
          <select
            v-model.number="pageVersion"
            @change="
              notice = '';
              run(loadRecords);
            "
          >
            <option
              v-for="version in runningPage?.latestVersion || 0"
              :key="version"
              :value="version"
            >
              V{{ version }}
            </option>
          </select></label
        ><label
          >记录范围
          <select
            v-model="recordState"
            :disabled="busy"
            @change="
              notice = '';
              run(loadRecords);
            "
          >
            <option v-if="form?.access.read" value="active">正式记录</option>
            <option
              v-if="form && canReadRecordDrafts(form.access)"
              value="draft"
            >
              草稿
            </option>
          </select></label
        ><button
          v-if="form?.access.create"
          class="button primary"
          @click="
            detail = undefined;
            editingRecord = true;
          "
        >
          新增记录
        </button>
      </div>
      <p v-if="form?.access.create && !form.access.read" class="collab-help">
        你可以新增记录并续填自己的草稿。提交后由有查看权限的成员处理。
      </p>
      <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
      <table class="collab-table">
        <thead>
          <tr>
            <th>创建时间</th>
            <th>数据版本</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.id">
            <td>{{ new Date(record.createdAt).toLocaleString("zh-CN") }}</td>
            <td>V{{ record.definitionVersion }}</td>
            <td>
              <button
                v-if="canOpen(record)"
                class="text-button"
                @click="openRecord(record)"
              >
                打开记录</button
              ><button
                v-else-if="
                  session.user?.role === 'admin' &&
                  form &&
                  record.definitionVersion < form.definition.version
                "
                class="text-button"
                @click="upgradingRecord = record"
              >
                查看版本更新</button
              ><span v-else class="collab-help"
                >请选择匹配的页面版本，或请管理员检查数据更新</span
              >
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!records.length" class="collab-help">
        {{
          groupOptions?.mode === "groups" && !form
            ? "请先选择本次办理使用的权限组。"
            : recordState === "draft"
              ? "暂无保存的草稿。"
              : "当前范围暂无记录。"
        }}
      </p></BaseDialog
    >
    <RecordUpgradeDialog
      v-if="upgradingRecord && runningPage"
      :page-id="runningPage.id"
      :page-version="pageVersion"
      :record-id="upgradingRecord.id"
      @close="upgradingRecord = undefined"
      @updated="upgraded"
    />
    <RecordEditor
      v-if="editingRecord && form"
      :published="form"
      :detail="detail"
      @close="editingRecord = false"
      @saved="
        async (result) => {
          editingRecord = false;
          recordState = result.record.state || 'active';
          notice = recordSavedNotice(result);
          await run(loadRecords);
        }
      "
    />
  </div>
</template>
