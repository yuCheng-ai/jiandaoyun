<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type {
  ApplicationSummary,
  PageSummary,
  DefinitionSummary,
  PublishedAccess,
  RecordDetail,
  RecordSummary,
  PageRecordSummary,
  RecordGroupOptions,
  ServerDefinition,
  PageEditorData,
  RecordListResult,
  RecordViewSettings,
  SavedRecordView,
} from "@platform/contracts";
import { organizationIdentityLabel } from "@platform/contracts";
import { displayFieldValue } from "../../domain/fieldDisplay";
import ApplicationHomeLayout from "./ApplicationHomeLayout.vue";
import RecordPagination from "../forms/components/RecordPagination.vue";
import PresentationFields from "../extensions/components/PresentationFields.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UserMenu from "../../components/shared/UserMenu.vue";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi } from "../../repositories/platformApi";
import {
  accessGroupReady,
  recordGroupOptions,
} from "../../repositories/accessGroupSelection";
import {
  canReadRecordDrafts,
  recordStateForAccess,
  recordSavedNotice,
} from "../../domain/serverRecords";
import RecordGroupSelector from "../collaboration/RecordGroupSelector.vue";
import RecordEditor from "../collaboration/RecordEditor.vue";
import RecordGroupDialog from "../collaboration/RecordGroupDialog.vue";
import CollectionDialog from "../data/CollectionDialog.vue";
import PageLifecycleDialog from "../data/PageLifecycleDialog.vue";
import RecordUpgradeDialog from "../data/RecordUpgradeDialog.vue";
import RelationManager from "../data/RelationManager.vue";
import ProcessWorkspace from "../processes/ProcessWorkspace.vue";
import "../collaboration/collaboration.css";
const route = useRoute(),
  router = useRouter(),
  session = usePlatformSession();
const appId = computed(() => String(route.params.applicationId || ""));
const application = ref<ApplicationSummary>(),
  pages = ref<PageSummary[]>([]),
  objects = ref<DefinitionSummary[]>([]),
  archived = ref<PageSummary[]>([]);
const app = computed(() =>
  application.value
    ? {
        name: application.value.title,
        color: application.value.color || "#56ae72",
        icon: application.value.icon || "department",
      }
    : undefined,
);
const selected = computed(() =>
  route.query.form
    ? pages.value.find((page) => page.id === route.query.form)
    : route.query.object
      ? pages.value.find((page) => page.definitionId === route.query.object)
      : pages.value.find((page) => page.latestVersion) || pages.value[0],
);
const busy = ref(false),
  error = ref(""),
  notice = ref("");
const view = ref<"fill" | "records" | "processes">("fill");
const form = ref<PublishedAccess>(),
  groups = ref<RecordGroupOptions>(),
  records = ref<PageRecordSummary[]>([]),
  detail = ref<RecordDetail>();
const recordList = ref<RecordListResult>();
const recordPage = ref(1),
  columnsOpen = ref(false),
  columnDraft = ref<string[]>([]),
  viewError = ref("");
const viewConflict = ref(false);
const searchKeyword = ref("");
const recordColumns = computed(() =>
  (recordList.value?.view.settings.fieldIds || [])
    .map((id) => recordList.value?.fields.find((field) => field.id === id))
    .filter((field): field is NonNullable<typeof field> => !!field),
);
const filteredRecords = computed(() => {
  if (!searchKeyword.value.trim()) return records.value;
  const kw = searchKeyword.value.trim().toLowerCase();
  return records.value.filter((r) => {
    if (r.id.toLowerCase().includes(kw)) return true;
    if (r.createdAt.includes(kw)) return true;
    if (!r.preview?.values) return false;
    return Object.values(r.preview.values).some((v) =>
      String(v ?? "").toLowerCase().includes(kw),
    );
  });
});
async function loadRecords(request = disposedRequest) {
  const page = selected.value;
  if (!page) return;
  const result = await platformApi<RecordListResult>(
    `/pages/${page.id}/record-list?version=${pageVersion.value}&state=${recordState.value}&page=${recordPage.value}`,
  );
  if (request === disposedRequest && page.id === selected.value?.id) {
    recordList.value = result;
    records.value = result.records;
    recordPage.value = result.page;
  }
}
function openColumns() {
  columnDraft.value = [...(recordList.value?.view.settings.fieldIds || [])];
  viewError.value = "";
  viewConflict.value = false;
  columnsOpen.value = true;
}
async function changeRecordView(patch: Partial<RecordViewSettings>) {
  if (busy.value || !recordList.value || !selected.value) return false;
  busy.value = true;
  viewError.value = "";
  error.value = "";
  try {
    const current = recordList.value.view;
    const result = await platformApi<SavedRecordView>(
      `/definitions/${selected.value.definitionId}/record-view`,
      "PUT",
      {
        expectedRevision: current.revision,
        settings: { ...current.settings, ...patch },
      },
    );
    recordList.value.view = result;
    recordPage.value = 1;
    viewConflict.value = false;
    await loadRecords();
    notice.value = "列表设置已保存";
    return true;
  } catch (cause) {
    viewError.value = (cause as Error).message;
    viewConflict.value = true;
    return false;
  } finally {
    busy.value = false;
  }
}
async function saveColumns() {
  if (!columnDraft.value.length) {
    viewError.value = "请至少选择一列";
    return;
  }
  if (await changeRecordView({ fieldIds: columnDraft.value }))
    columnsOpen.value = false;
}
async function refreshView() {
  await run(async () => {
    await loadRecords();
    viewConflict.value = false;
    viewError.value = "已读取最新设置，请核对当前选择后保存";
  });
}
async function turnPage(value: number) {
  await run(async () => {
    recordPage.value = value;
    await loadRecords();
  });
}
function recordCell(record: PageRecordSummary, id: string) {
  const preview = record.preview;
  const field = preview?.fields.find((item) => item.id === id);
  if (!preview || !field) return "—";
  return displayFieldValue(field, preview.values[id], {
    identity: (id) => {
      const identity = preview.identities.find((item) => item.id === id);
      return identity
        ? organizationIdentityLabel(identity)
        : "无法识别的成员或部门";
    },
  });
}
const pageVersion = ref(1),
  recordState = ref<"active" | "draft">("active"),
  editorKey = ref(0);
const filling = ref<InstanceType<typeof RecordEditor>>();
watch(
  () => filling.value?.dirty,
  (dirty) => {
    if (dirty) notice.value = "";
  },
);
const createOpen = ref(false),
  title = ref(""),
  trashOpen = ref(false),
  lifecyclePage = ref<PageSummary>(),
  upgrade = ref<RecordSummary>();
const permission = ref<ServerDefinition>(),
  collectionOpen = ref(false),
  relationsOpen = ref(false);
let disposedRequest = 0,
  loading = false;
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
  }
}
async function loadForm(resetList = true) {
  notice.value = "";
  const page = selected.value;
  const request = ++disposedRequest;
  form.value = undefined;
  groups.value = undefined;
  records.value = [];
  recordList.value = undefined;
  if (resetList) {
    recordPage.value = 1;
    searchKeyword.value = "";
  }
  columnsOpen.value = false;
  viewError.value = "";
  viewConflict.value = false;
  detail.value = undefined;
  if (!page?.latestVersion) return;
  const options = await recordGroupOptions(page.definitionId);
  if (request !== disposedRequest || page.id !== selected.value?.id) return;
  groups.value = options;
  if (!accessGroupReady(page.definitionId, options)) return;
  const access = await platformApi<PublishedAccess>(
    `/pages/${page.id}/form?version=${pageVersion.value}`,
  );
  if (request !== disposedRequest || page.id !== selected.value?.id) return;
  form.value = access;
  recordState.value = recordStateForAccess(access.access, recordState.value);
  if (!access.access.create && view.value === "fill") view.value = "records";
  if (
    access.access.read ||
    (recordState.value === "draft" && access.access.create)
  ) {
    await loadRecords(request);
  }
}
function selectRecordState(state: "active" | "draft") {
  if (recordState.value === state) return;
  recordState.value = state;
  void run(loadForm);
}
async function load() {
  loading = true;
  try {
    await session.restore();
    if (!session.user) {
      await router.replace("/");
      return;
    }
    const applications =
      await platformApi<ApplicationSummary[]>("/applications");
    application.value = applications.find((item) => item.id === appId.value);
    if (!appId.value) {
      await router.replace("/");
      return;
    }
    if (!application.value) throw new Error("应用不存在或尚未授权。");
    const result = await Promise.all([
      platformApi<PageSummary[]>(`/pages?applicationId=${appId.value}`),
      platformApi<DefinitionSummary[]>(
        `/data-objects?applicationId=${appId.value}`,
      ),
      session.user.role === "admin"
        ? platformApi<PageSummary[]>(
            `/pages?applicationId=${appId.value}&state=archived`,
          )
        : Promise.resolve([]),
    ]);
    [pages.value, objects.value, archived.value] = result;
    pageVersion.value = selected.value?.latestVersion || 1;
    view.value =
      route.query.tab === "processes"
        ? "processes"
        : route.query.tab === "objects" ||
            route.query.view === "records" ||
            route.query.section === "data"
          ? "records"
          : "fill";
    await loadForm();
  } finally {
    loading = false;
  }
}
onMounted(() => run(load));
watch(
  () => route.query.form,
  () => {
    if (!loading)
      void run(async () => {
        pageVersion.value = selected.value?.latestVersion || 1;
        view.value = "fill";
        await loadForm();
      });
  },
);
function afterLeave(action: () => void | Promise<void>) {
  if (filling.value) filling.value.runAfterLeave(action);
  else void action();
}
function select(id: string) {
  afterLeave(() =>
    router.push({ path: route.path, query: { form: id } }).then(() => {}),
  );
}
function show(next: typeof view.value) {
  afterLeave(async () => {
    notice.value = "";
    detail.value = undefined;
    view.value = next;
    // 填写成功后保留回执；进入数据管理时再刷新列表和访问权限。
    if (next === "records") await run(() => loadForm(false));
  });
}
function design() {
  if (selected.value)
    afterLeave(() =>
      router
        .push(`/applications/${appId.value}/pages/${selected.value!.id}/design`)
        .then(() => {}),
    );
}
async function logout() {
  afterLeave(async () => {
    await run(async () => {
      await session.logout();
      await router.replace("/");
    });
  });
}
async function saved(result: RecordDetail, fromFilling = false) {
  detail.value = undefined;
  const nextState = result.record.state || "active";
  if (recordState.value !== nextState) recordPage.value = 1;
  recordState.value = nextState;
  if (fromFilling && nextState === "active") {
    // 回执保留本次填写内容，点击继续填写后才重新加载默认值并创建下一条。
    notice.value = recordSavedNotice(result);
    return;
  }
  editorKey.value++;
  await run(() => loadForm(false));
  notice.value = recordSavedNotice(result);
}
async function openRecord(record: RecordSummary) {
  await run(async () => {
    notice.value = "";
    detail.value = await platformApi<RecordDetail>(
      `/pages/${selected.value!.id}/records/${record.id}?version=${pageVersion.value}`,
    );
  });
}
const canOpen = (record: RecordSummary) =>
  (form.value?.compatibleVersions || [form.value?.definition.version]).includes(
    record.definitionVersion,
  );
let requestId = "",
  requestedTitle = "";
async function create() {
  await run(async () => {
    if (!title.value.trim()) throw new Error("请填写表单名称");
    if (requestedTitle !== title.value.trim()) {
      requestedTitle = title.value.trim();
      requestId = crypto.randomUUID();
    }
    const created = await platformApi<PageEditorData>(
      "/pages/new-business",
      "POST",
      { title: requestedTitle, applicationId: appId.value, requestId },
    );
    createOpen.value = false;
    await router.push(
      `/applications/${appId.value}/pages/${created.draft.id}/design`,
    );
  });
}
async function permissions() {
  if (!selected.value) return;
  await run(async () => {
    const id = selected.value!.definitionId;
    const access = await platformApi<PublishedAccess>(`/definitions/${id}`);
    permission.value = access.definition;
  });
}
</script>
<template>
  <ApplicationHomeLayout
    :app="app"
    :forms="pages"
    :folders="application?.folders || []"
    :selected-id="selected?.id"
    :can-create="session.user?.role === 'admin'"
    @select="select"
    @create="
      afterLeave(() => {
        title = '';
        createOpen = true;
      })
    "
  >
    <template #navigationFooter
      ><button
        v-if="session.user?.role === 'admin'"
        @click="
          afterLeave(() => {
            trashOpen = true;
          })
        "
      >
        <AppIcon name="trash" />回收站</button
      ><button @click="show('processes')">
        <AppIcon name="condition" />{{
          session.user?.role === "admin" ? "流程进度" : "我的待办"
        }}
      </button></template
    >
    <template v-if="selected" #actions>
      <button
        v-if="view !== 'records'"
        class="header-action-btn"
        @click="show('records')"
      >
        <AppIcon name="table" />数据管理
      </button>
      <button
        v-if="session.user?.role === 'admin'"
        class="header-action-btn"
        @click="design"
      >
        <AppIcon name="edit" />编辑表单
      </button>
      <details v-if="session.user?.role === 'admin'" class="server-form-menu">
        <summary aria-label="更多表单操作">···</summary>
        <div>
          <button @click="afterLeave(permissions)">权限设置</button
          ><button
            @click="
              afterLeave(() => {
                collectionOpen = true;
              })
            "
          >
            收集设置</button
          ><button
            @click="
              afterLeave(() => {
                relationsOpen = true;
              })
            "
          >
            关联设置</button
          ><button
            @click="
              afterLeave(() => {
                lifecyclePage = selected;
              })
            "
          >
            移入回收站
          </button>
        </div>
      </details>
    </template>
    <template #utilities
      ><UserMenu
        v-if="session.user"
        :account="session.user"
        :busy="busy"
        @organization="router.push('/admin/organization')"
        @logout="logout"
    /></template>
    <p v-if="busy" class="server-home-message" role="status">正在读取…</p>
    <p v-if="error" class="field-error server-home-message" role="alert">
      {{ error }} <button class="text-button" @click="run(load)">重试</button>
    </p>
    <p v-if="notice" class="server-home-message" role="status">{{ notice }}</p>
    <ProcessWorkspace
      v-if="view === 'processes'"
      :application-id="appId"
      :objects="objects"
      :pages="pages"
    />
    <template v-else-if="selected?.latestVersion">
      <RecordGroupSelector
        v-if="groups"
        :definition-id="selected.definitionId"
        :options="groups"
        :busy="busy || filling?.dirty || filling?.busy"
        @change="run(loadForm)"
      />
      <p v-if="groups?.mode === 'groups' && !form" class="server-home-message">
        请先选择本次办理使用的权限组。
      </p>
      <template v-if="form">
        <RecordEditor
          v-if="view === 'fill' && form.access.create"
          ref="filling"
          :key="`${selected.id}-${editorKey}`"
          embedded
          :published="form"
          @saved="saved($event, true)"
          @continue="run(loadForm)"
        />
        <section v-else class="server-record-list">
          <div class="record-management-toolbar">
            <div class="record-toolbar-left">
              <button
                v-if="form.access.create"
                class="button primary record-add-btn"
                @click="show('fill')"
              >
                <AppIcon name="add" :size="15" />新增记录
              </button>

              <div class="record-state-tabs">
                <button
                  v-if="form.access.read"
                  type="button"
                  class="record-state-tab"
                  :class="{ active: recordState === 'active' }"
                  @click="selectRecordState('active')"
                >
                  正式记录
                </button>
                <button
                  v-if="canReadRecordDrafts(form.access)"
                  type="button"
                  class="record-state-tab"
                  :class="{ active: recordState === 'draft' }"
                  @click="selectRecordState('draft')"
                >
                  草稿箱
                </button>
                <select
                  v-model="recordState"
                  class="sr-only"
                  tabindex="-1"
                  aria-hidden="true"
                  @change="run(loadForm)"
                >
                  <option v-if="form.access.read" value="active">正式记录</option>
                  <option v-if="canReadRecordDrafts(form.access)" value="draft">
                    草稿
                  </option>
                </select>
              </div>

              <div
                v-if="
                  (selected.versions && selected.versions.length > 1) ||
                  (!selected.versions && (selected.latestVersion || 1) > 1)
                "
                class="record-version-selector"
                title="表单版本"
              >
                <span class="version-label">版本:</span>
                <select
                  v-model.number="pageVersion"
                  :disabled="busy"
                  class="version-select"
                  @change="run(loadForm)"
                >
                  <option
                    v-for="version in selected.versions || selected.latestVersion"
                    :key="version"
                    :value="version"
                  >
                    V{{ version }}
                  </option>
                </select>
              </div>
            </div>

            <div class="record-toolbar-right">
              <div class="record-search-box">
                <AppIcon name="search" :size="14" class="search-icon" />
                <input
                  v-model="searchKeyword"
                  type="text"
                  placeholder="搜索数据..."
                  class="record-search-input"
                  aria-label="搜索数据"
                />
                <button
                  v-if="searchKeyword"
                  type="button"
                  class="search-clear-btn"
                  aria-label="清空搜索"
                  @click="searchKeyword = ''"
                >
                  <AppIcon name="close" :size="12" />
                </button>
              </div>

              <template v-if="session.user?.role === 'admin' && recordList">
                <div class="record-sort-group">
                  <span class="sort-prefix">
                    <AppIcon name="filter" :size="13" />
                    <span>排序</span>
                  </span>
                  <select
                    aria-label="数据排序字段"
                    :value="recordList.view.settings.sortField"
                    :disabled="busy"
                    class="sort-select"
                    @change="
                      changeRecordView({
                        sortField: ($event.target as HTMLSelectElement).value,
                      })
                    "
                  >
                    <option value="$createdAt">创建时间</option>
                    <option
                      v-for="field in recordList.fields"
                      :key="field.id"
                      :value="field.id"
                    >
                      {{ field.label }}
                    </option>
                  </select>
                  <button
                    type="button"
                    class="sort-order-btn"
                    :title="
                      recordList.view.settings.descending
                        ? '降序 (点击切换升序)'
                        : '升序 (点击切换降序)'
                    "
                    :disabled="busy"
                    @click="
                      changeRecordView({
                        descending: !recordList.view.settings.descending,
                      })
                    "
                  >
                    <AppIcon
                      :name="
                        recordList.view.settings.descending ? 'moveDown' : 'up'
                      "
                      :size="12"
                    />
                    <span>{{
                      recordList.view.settings.descending ? "降序" : "升序"
                    }}</span>
                  </button>
                </div>

                <button
                  type="button"
                  class="record-tool-btn"
                  :disabled="busy"
                  @click="openColumns"
                >
                  <AppIcon name="table" :size="14" />
                  <span>列设置</span>
                </button>
              </template>

              <button
                v-if="recordList"
                type="button"
                class="record-tool-btn record-refresh-btn"
                title="刷新数据"
                :disabled="busy"
                @click="run(loadRecords)"
              >
                <AppIcon name="refresh" :size="14" />
              </button>
            </div>
          </div>
          <p
            v-if="viewError && !columnsOpen"
            class="field-error server-home-message"
            role="alert"
          >
            {{ viewError }}
            <button
              v-if="viewConflict"
              class="text-button"
              @click="refreshView"
            >
              读取最新设置
            </button>
          </p>
          <p
            v-if="form.access.create && !form.access.read"
            class="server-home-message"
          >
            你可以新增记录并续填自己的草稿。提交后由有查看权限的成员处理。
          </p>
          <div class="organization-table-scroll">
            <table
              class="organization-table record-display-table"
              :data-row-height="recordList?.view.settings.rowHeight || 'low'"
            >
              <thead>
                <tr>
                  <th
                    v-for="field in recordColumns"
                    :key="field.id"
                    scope="col"
                  >
                    {{ field.label }}
                  </th>
                  <th>创建时间</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in filteredRecords" :key="record.id">
                  <td v-for="field in recordColumns" :key="field.id">
                    <span
                      class="server-record-cell record-cell-value"
                      :title="recordCell(record, field.id)"
                      >{{ recordCell(record, field.id) }}</span
                    >
                  </td>
                  <td>
                    {{ new Date(record.createdAt).toLocaleString("zh-CN") }}
                  </td>
                  <td>V{{ record.definitionVersion }}</td>
                  <td>
                    <button
                      v-if="canOpen(record)"
                      class="text-button"
                      @click="openRecord(record)"
                    >
                      打开记录</button
                    ><button
                      v-else-if="session.user?.role === 'admin'"
                      class="text-button"
                      @click="upgrade = record"
                    >
                      查看版本更新</button
                    ><span v-else>请切换匹配的表单版本</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!records.length" class="field-hint">
              {{ recordState === "draft" ? "暂无保存的草稿" : "暂无记录" }}
            </p>
            <p v-else-if="!filteredRecords.length" class="field-hint">
              没有找到与“{{ searchKeyword }}”匹配的记录
            </p>
          </div>
          <RecordPagination
            v-if="recordList"
            :total="recordList.total"
            :page="recordList.page"
            :settings="recordList.view.settings"
            :busy="busy"
            :editable="session.user?.role === 'admin'"
            @page="turnPage"
            @change="changeRecordView"
          />
        </section>
      </template>
    </template>
    <div v-else-if="!busy && !error" class="application-form-unavailable">
      <AppIcon name="form" :size="42" />
      <h2>{{ selected ? "表单尚未发布" : "还没有表单" }}</h2>
      <button
        v-if="selected && session.user?.role === 'admin'"
        class="button primary"
        @click="design"
      >
        编辑表单
      </button>
    </div>
    <template #dialogs>
      <BaseDialog
        :open="columnsOpen"
        title="配置数据列"
        width="520px"
        :busy="busy"
        @close="columnsOpen = false"
      >
        <fieldset class="record-controls-lock" :disabled="busy">
          <PresentationFields
            v-if="form"
            v-model="columnDraft"
            :schema="form.definition.schema"
            :options="recordList?.fields"
          />
        </fieldset>
        <p v-if="viewError" class="field-error" role="alert">
          {{ viewError }}
          <button v-if="viewConflict" class="text-button" @click="refreshView">
            读取最新设置
          </button>
        </p>
        <template #footer
          ><button class="button" :disabled="busy" @click="columnsOpen = false">
            取消</button
          ><button
            class="button primary"
            :disabled="busy || viewConflict"
            @click="saveColumns"
          >
            {{ busy ? "正在保存…" : "保存列设置" }}
          </button></template
        >
      </BaseDialog>

      <BaseDialog
        :open="createOpen"
        title="新建表单"
        :busy="busy"
        @close="createOpen = false"
        ><label>表单名称<input v-model="title" maxlength="100" /></label>
        <p v-if="error" class="field-error" role="alert">{{ error }}</p>
        <template #footer
          ><button class="button" @click="createOpen = false">取消</button
          ><button class="button primary" @click="create">
            创建
          </button></template
        ></BaseDialog
      >
      <BaseDialog :open="trashOpen" title="回收站" @close="trashOpen = false"
        ><ul class="application-trash-list">
          <li v-for="page in archived" :key="page.id">
            <span>{{ page.title }}</span
            ><button class="text-button" @click="lifecyclePage = page">
              恢复
            </button>
          </li>
        </ul>
        <p v-if="!archived.length">回收站为空</p></BaseDialog
      >
      <PageLifecycleDialog
        v-if="lifecyclePage"
        :page="lifecyclePage"
        :action="lifecyclePage.archivedAt ? 'restore' : 'archive'"
        @close="lifecyclePage = undefined"
        @saved="
          lifecyclePage = undefined;
          run(load);
        "
      />
      <RecordGroupDialog
        v-if="permission"
        :definition="permission"
        @close="
          permission = undefined;
          run(loadForm);
        "
        @saved="
          permission = undefined;
          run(loadForm);
        "
      />
      <CollectionDialog
        v-if="collectionOpen && selected"
        :definition-id="selected.definitionId"
        :title="selected.title"
        @close="
          collectionOpen = false;
          run(loadForm);
        "
      />
      <BaseDialog
        :open="relationsOpen"
        title="关联设置"
        width="1040px"
        @close="relationsOpen = false"
        ><RelationManager
          v-if="relationsOpen && selected"
          :source-id="selected.definitionId"
          :objects="objects"
      /></BaseDialog>
      <RecordEditor
        v-if="detail && form"
        :published="form"
        :detail="detail"
        @close="detail = undefined"
        @saved="saved"
      />
      <RecordUpgradeDialog
        v-if="upgrade && selected"
        :page-id="selected.id"
        :page-version="pageVersion"
        :record-id="upgrade.id"
        @close="upgrade = undefined"
        @updated="
          upgrade = undefined;
          detail = $event;
        "
      />
    </template>
  </ApplicationHomeLayout>
</template>
<style scoped>
.server-home-message {
  margin: 12px 24px;
}
.header-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #d9dfe9;
  background: #ffffff;
  border-radius: 6px;
  font-size: 13px;
  color: #334155;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
}
.header-action-btn:hover {
  border-color: #00b894;
  color: #00b894;
  background: #f0fdf4;
}
.server-record-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
}

/* Data Management Toolbar */
.record-management-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
  background: #ffffff;
  border-bottom: 1px solid #edf0f5;
  flex-shrink: 0;
  overflow-x: auto;
  white-space: nowrap;
}
.record-toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  white-space: nowrap;
}
.record-toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex-shrink: 0;
  white-space: nowrap;
}

.record-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  background: #00b894;
  border: 1px solid #00b894;
  border-radius: 6px;
  color: #ffffff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s ease-in-out;
  box-shadow: 0 1px 2px rgba(0, 184, 148, 0.2);
}
.record-add-btn:hover {
  background: #00a884;
  border-color: #00a884;
}

/* Status tabs (正式记录 / 草稿箱) */
.record-state-tabs {
  display: inline-flex;
  align-items: center;
  background: #f1f3f7;
  border-radius: 6px;
  padding: 2px;
  white-space: nowrap;
  flex-shrink: 0;
}
.record-state-tab {
  height: 28px;
  line-height: 28px;
  padding: 0 14px;
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 13px;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s ease-in-out;
}
.record-state-tab:hover {
  color: #1e293b;
}
.record-state-tab.active {
  background: #ffffff;
  color: #00b894;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Schema version pill */
.record-version-selector {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  font-size: 12px;
  color: #64748b;
  white-space: nowrap;
  flex-shrink: 0;
}
.record-version-selector .version-label {
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}
.record-version-selector .version-select {
  border: none !important;
  background: transparent !important;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  cursor: pointer;
  outline: none;
  padding: 0 2px !important;
  width: auto !important;
  min-height: unset !important;
  white-space: nowrap;
}

/* Search Box */
.record-search-box {
  position: relative;
  display: flex;
  align-items: center;
  height: 32px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0 8px;
  width: 170px;
  flex-shrink: 0;
  white-space: nowrap;
  transition: all 0.2s ease-in-out;
}
.record-search-box:focus-within {
  width: 220px;
  background: #ffffff;
  border-color: #00b894;
  box-shadow: 0 0 0 2px rgba(0, 184, 148, 0.12);
}
.record-search-box .search-icon {
  color: #94a3b8;
  flex-shrink: 0;
}
.record-search-input {
  border: none !important;
  background: transparent !important;
  outline: none;
  font-size: 13px;
  color: #1e293b;
  width: 100%;
  margin-left: 6px;
  padding: 0 !important;
  min-height: unset !important;
  box-shadow: none !important;
}
.record-search-input::placeholder {
  color: #94a3b8;
}
.search-clear-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: #94a3b8;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.15s;
}
.search-clear-btn:hover {
  color: #475569;
}

/* Sort Controls */
.record-sort-group {
  display: inline-flex;
  align-items: center;
  height: 32px;
  background: #ffffff;
  border: 1px solid #d9dfe9;
  border-radius: 6px;
  padding: 0 3px 0 8px;
  font-size: 13px;
  flex-shrink: 0;
  white-space: nowrap;
  gap: 4px;
  transition: border-color 0.15s;
}
.record-sort-group:hover {
  border-color: #00b894;
}

.sort-prefix {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
}
.sort-prefix span {
  white-space: nowrap;
}

.sort-select {
  width: auto !important;
  min-width: 86px;
  max-width: 150px;
  height: 26px !important;
  min-height: unset !important;
  border: none !important;
  background: transparent !important;
  font-size: 13px;
  font-weight: 500;
  color: #1e293b;
  outline: none;
  cursor: pointer;
  padding: 0 16px 0 2px !important;
  white-space: nowrap;
  flex-shrink: 0;
  box-shadow: none !important;
}

.sort-order-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  border-radius: 4px;
  font-size: 12px;
  color: #475569;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s;
}
.sort-order-btn span {
  white-space: nowrap;
}
.sort-order-btn:hover {
  color: #00b894;
  border-color: #00b894;
  background: #ffffff;
}

/* General Tool Buttons (列设置, 刷新) */
.record-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #d9dfe9;
  background: #ffffff;
  border-radius: 6px;
  font-size: 13px;
  color: #475569;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s;
}
.record-tool-btn span {
  white-space: nowrap;
}
.record-tool-btn:hover {
  border-color: #00b894;
  color: #00b894;
  background: #f8fafc;
}
.record-refresh-btn {
  padding: 0 8px;
}

/* Table styling */
.organization-table-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.record-display-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}
.record-display-table th {
  background: #f8fafc;
  color: #475569;
  font-weight: 600;
  font-size: 13px;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0;
  white-space: nowrap;
  text-align: left;
}
.record-display-table td {
  padding: 10px 16px;
  border-bottom: 1px solid #f1f5f9;
  font-size: 13px;
  color: #334155;
  vertical-align: middle;
}
.record-display-table tr:hover td {
  background: #f8fafc;
}
.server-record-cell {
  display: block;
  min-width: 120px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.server-record-list th:last-child,
.server-record-list td:last-child {
  position: sticky;
  right: 0;
  min-width: 110px;
  max-width: 160px;
  white-space: normal;
  box-shadow: -4px 0 6px #25324c08;
}
.server-record-list td:last-child {
  background: white;
}
.server-record-list tr:hover td:last-child {
  background: #f8fafc;
}

.server-form-menu {
  position: relative;
}
.server-form-menu summary {
  cursor: pointer;
  list-style: none;
  padding: 6px;
}
.server-form-menu > div {
  position: absolute;
  top: 100%;
  left: 0;
  background: white;
  border: 1px solid #e5e8ef;
  border-radius: 6px;
  box-shadow: 0 5px 18px #25324c16;
  z-index: 5;
  width: 150px;
  padding: 6px;
}
.server-form-menu button {
  display: block;
  padding: 10px;
  width: 100%;
  text-align: left;
}
.server-form-menu button:hover {
  background: #edf7f6;
}
</style>
