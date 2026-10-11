<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useRouter } from "vue-router";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  inspectApplicationMigration,
  type ApplicationMigrationReport,
} from "../../domain/applicationMigration";
import {
  migrationSourceStamp,
  readApplicationMigrationSource,
} from "../../repositories/applicationMigrationSource";
import { WORKSPACE_KEY } from "../../repositories/workspaceRepository";
const MigrationIdentityDialog = defineAsyncComponent(() => import("./MigrationIdentityDialog.vue"));
const identitiesOpen = ref(false);

const props = defineProps<{ appId: string }>();
const emit = defineEmits<{ close: [] }>();
const workspace = useWorkspaceStore(),
  router = useRouter();
const report = shallowRef<ApplicationMigrationReport>(),
  error = ref(""),
  inspectedSource = ref("");
const stale = ref(false);
function checkSource() {
  if (!report.value) return;
  try {
    stale.value = migrationSourceStamp() !== inspectedSource.value;
  } catch {
    stale.value = true;
    error.value = "无法读取最新应用内容，请重新检查。";
  }
}
function storageChanged(event: StorageEvent) {
  if (!event.key || event.key === WORKSPACE_KEY) checkSource();
}
watch(() => workspace.data, checkSource, { deep: true });
onMounted(() => {
  window.addEventListener("storage", storageChanged);
  window.addEventListener("focus", checkSource);
});
onBeforeUnmount(() => {
  window.removeEventListener("storage", storageChanged);
  window.removeEventListener("focus", checkSource);
});
const section = ref("issues"),
  formId = ref(""),
  kind = ref(""),
  query = ref(""),
  page = ref(1);
const kindLabels = {
  invalid: "需核对",
  unsupported: "待接入",
  mapping: "待映射",
};
const scopeLabels = {
  application: "本应用",
  external: "其他应用",
  missing: "来源缺失",
};
const formName = (id: string) =>
  report.value?.forms.find((form) => form.id === id)?.title || "应用设置";
const filteredIssues = computed(() =>
  (report.value?.issues || []).filter(
    (issue) =>
      (!formId.value || issue.formId === formId.value) &&
      (!kind.value || issue.kind === kind.value) &&
      `${formName(issue.formId)} ${issue.version} ${issue.location} ${issue.message}`.includes(
        query.value.trim(),
      ),
  ),
);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(filteredIssues.value.length / 20)),
);
const shownIssues = computed(() =>
  filteredIssues.value.slice((page.value - 1) * 20, page.value * 20),
);
const totals = computed(() => ({
  versions:
    report.value?.forms.reduce(
      (sum, form) => sum + form.publishedVersions,
      0,
    ) || 0,
  records:
    report.value?.forms.reduce((sum, form) => sum + form.records, 0) || 0,
  rows: report.value?.forms.reduce((sum, form) => sum + form.rowCount, 0) || 0,
}));
watch([formId, kind, query], () => {
  page.value = 1;
});
function inspect() {
  error.value = "";
  try {
    const source = readApplicationMigrationSource();
    const next = inspectApplicationMigration(source.data, props.appId);
    report.value = next;
    inspectedSource.value = source.stamp;
    stale.value = false;
    page.value = 1;
    if (formId.value && !next.forms.some((form) => form.id === formId.value))
      formId.value = "";
  } catch (cause) {
    report.value = undefined;
    error.value = (cause as Error).message;
  }
}
watch(() => props.appId, inspect, { immediate: true });
function openForm(id: string) {
  checkSource();
  if (stale.value) return;
  // Navigation reads the inspected source; it does not save or depend on another editor's state.
  const form = readApplicationMigrationSource().data.forms.find(
    (form) => form.id === id && !form.archived,
  );
  if (!form) {
    error.value = "表单已归档或不存在，请重新检查。";
    return;
  }
  emit("close");
  const path = `/apps/${encodeURIComponent(form.appId)}/forms/${encodeURIComponent(form.id)}/design`;
  if (workspace.checkStorageChanges?.()) window.open(router.resolve(path).href, "_blank", "noopener");
  else router.push(path);
}
</script>

<template>
  <BaseDialog
    :open="true"
    title="应用迁移检查"
    width="960px"
    @close="emit('close')"
  >
    <div class="migration-check">
      <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
      <template v-if="report">
        <h3>{{ report.application.name }}</h3>
        <p class="collab-help">
          检查已保存的应用内容，包括归档表单、历史发布和已删除记录。编辑器里尚未保存的修改不在本次范围内。
        </p>
        <p class="collab-help">
          当前为迁移前盘点，执行迁移与切换入口尚未开放。本次检查不会上传或修改原数据。
        </p>
        <p class="collab-help">可另行配置身份对应并保存到服务端；对应确认不代表业务数据已迁移。<button class="text-button" :disabled="stale" @click="checkSource(); if (!stale) identitiesOpen = true">配置身份对应</button></p>
        <p v-if="stale" class="collab-error" role="alert">
          应用内容已变化，以下是上次检查结果。请重新检查后再处理。
        </p>
        <div class="migration-summary" aria-label="迁移资源汇总">
          <span
            ><strong>{{ report.forms.length }}</strong> 张表单</span
          >
          <span
            ><strong>{{ totals.versions }}</strong> 个发布版本</span
          >
          <span
            ><strong>{{ totals.records }}</strong> 条记录</span
          >
          <span
            ><strong>{{ totals.rows }}</strong> 行明细</span
          >
        </div>
        <nav class="property-tabs" aria-label="迁移检查内容">
          <button
            :class="{ active: section === 'issues' }"
            :aria-pressed="section === 'issues'"
            @click="section = 'issues'"
          >
            待处理项 {{ report.issues.length }}
          </button>
          <button
            :class="{ active: section === 'dependencies' }"
            :aria-pressed="section === 'dependencies'"
            @click="section = 'dependencies'"
          >
            跨表依赖 {{ report.dependencies.length }}
          </button>
          <button
            :class="{ active: section === 'resources' }"
            :aria-pressed="section === 'resources'"
            @click="section = 'resources'"
          >
            资源清单
          </button>
        </nav>
        <section v-if="section === 'issues'" aria-label="迁移待处理项">
          <div class="migration-filters">
            <select v-model="formId" aria-label="按表单筛选检查结果">
              <option value="">全部表单与应用设置</option>
              <option
                v-for="form in report.forms"
                :key="form.id"
                :value="form.id"
              >
                {{ form.title }}{{ form.archived ? "（已归档）" : "" }}
              </option>
            </select>
            <select v-model="kind" aria-label="按问题类别筛选">
              <option value="">全部类别</option>
              <option
                v-for="(label, key) in kindLabels"
                :key="key"
                :value="key"
              >
                {{ label }}
              </option>
            </select>
            <input
              v-model="query"
              aria-label="搜索迁移检查结果"
              placeholder="搜索名称、版本或配置"
            />
          </div>
          <ol class="migration-items">
            <li v-for="(issue, index) in shownIssues" :key="`${page}-${index}`">
              <div>
                <span class="migration-tag">{{ kindLabels[issue.kind] }}</span
                ><strong
                  >{{ formName(issue.formId) }} · {{ issue.version }} ·
                  {{ issue.location }}</strong
                >
              </div>
              <p>{{ issue.message }}</p>
              <button
                v-if="
                  issue.formId &&
                  report.forms.some(
                    (form) => form.id === issue.formId && !form.archived,
                  )
                "
                class="text-button"
                :disabled="stale"
                @click="openForm(issue.formId)"
              >
                查看当前设计
              </button>
            </li>
          </ol>
          <p v-if="!filteredIssues.length" class="collab-help">
            没有符合筛选条件的待处理项。此结果不代表服务端迁移已可执行。
          </p>
          <div class="migration-pagination">
            <span
              >共 {{ filteredIssues.length }} 项 · 第 {{ page }} /
              {{ pageCount }} 页</span
            ><button class="button" :disabled="page <= 1" @click="page--">
              上一页</button
            ><button
              class="button"
              :disabled="page >= pageCount"
              @click="page++"
            >
              下一页
            </button>
          </div>
        </section>
        <section
          v-else-if="section === 'dependencies'"
          aria-label="迁移跨表依赖"
        >
          <p class="collab-help">
            按来源版本分别列出动态选项、关联字段、子流程、助手和按钮。不同应用的同名表单不会自动合并。
          </p>
          <ol class="migration-items">
            <li v-for="(item, index) in report.dependencies" :key="index">
              <strong
                >{{ formName(item.formId) }} · {{ item.version }} ·
                {{ item.location }}</strong
              >
              <p>
                <template v-if="item.scope === 'external'"
                  >{{ item.targetApplication }} ·
                </template>
                {{ item.targetTitle
                }}{{
                  item.targetVersion === undefined
                    ? ""
                    : ` · V${item.targetVersion}`
                }}
                <span class="migration-tag">{{ scopeLabels[item.scope] }}</span>
              </p>
            </li>
          </ol>
          <p v-if="!report.dependencies.length" class="collab-help">
            未发现上述类型的跨表配置；记录值中的关系仍需在执行迁移前校验。
          </p>
        </section>
        <section v-else aria-label="迁移资源清单">
          <p class="collab-help">
            字段和选项保留原身份；表单、记录、组织身份需要与服务端建立对应关系。已有基础类型支持不代表所有配置已通过服务端校验。
          </p>
          <div class="migration-types">
            <span
              v-for="type in report.fieldTypes"
              :key="type.type"
              class="migration-tag"
              >{{ type.label }} {{ type.occurrences }} ·
              {{ type.runtimeSupported ? "已有基础支持" : "待接入" }}</span
            >
          </div>
          <ol class="migration-items">
            <li v-for="form in report.forms" :key="form.id">
              <strong
                >{{ form.title }}{{ form.archived ? "（已归档）" : "" }}</strong
              >
              <p>
                {{ form.records }} 条记录，其中草稿
                {{ form.draftRecords }} 条、已删除
                {{ form.deletedRecords }} 条；{{ form.rowCount }} 行明细、{{
                  form.historyEvents
                }}
                条处理轨迹、{{ form.permissionGroups }} 个权限组。
              </p>
              <p v-for="version in form.versions" :key="version.label">
                {{ version.label }}：{{ version.dataFields }} 个数据字段，{{
                  version.layoutControls
                }}
                个展示控件；流程{{
                  version.workflowEnabled ? "已启用" : "未启用"
                }}。
              </p>
            </li>
          </ol>
          <p>
            涉及 {{ report.identities.length }} 个组织身份；{{
              report.paymentOrders
            }}
            笔原支付订单、{{ report.extensionRuns }} 条扩展运行记录需要保留。
          </p>
          <p class="collab-help">
            原明细缺少稳定行身份时，需要保留原记录及行位置到新行身份的对应关系。权限映射不会按姓名自动授予访问。
          </p>
        </section>
      </template>
    </div>
    <template #footer
      ><button class="button" @click="emit('close')">关闭检查</button
      ><button class="button primary" @click="inspect">
        重新检查
      </button></template
    >
  </BaseDialog>
  <MigrationIdentityDialog v-if="identitiesOpen" :app-id="appId" @close="identitiesOpen = false" />
</template>

<style scoped>
.migration-check {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.migration-check h3,
.migration-check p {
  margin: 0;
}
.migration-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 12px;
  background: #f5f8fa;
  border-radius: 6px;
}
.migration-summary strong {
  margin-right: 4px;
  font-size: 18px;
}
.migration-filters {
  display: flex;
  gap: 8px;
  margin: 12px 0;
  flex-wrap: wrap;
}
.migration-filters select,
.migration-filters input {
  flex: 1 1 160px;
  min-width: 0;
  max-width: 100%;
}
.migration-items {
  list-style: none;
  padding: 0;
  margin: 0;
}
.migration-items li {
  display: grid;
  gap: 7px;
  padding: 12px 0;
  border-bottom: 1px solid #e8ecef;
  overflow-wrap: anywhere;
}
.migration-items li > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.migration-items .text-button {
  justify-self: start;
}
.migration-items p {
  color: #586775;
  line-height: 1.6;
}
.migration-tag {
  display: inline-block;
  padding: 3px 7px;
  border-radius: 4px;
  background: #edf3f7;
  font-size: 12px;
  color: #455b6b;
}
.migration-types {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 12px 0;
}
.migration-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.migration-pagination > span {
  margin-right: auto;
  color: #65727e;
}
@media (max-width: 600px) {
  .migration-summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .migration-check .property-tabs {
    flex-wrap: wrap;
  }
}
</style>
