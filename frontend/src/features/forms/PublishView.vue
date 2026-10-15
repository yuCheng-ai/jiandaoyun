<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import RecordGroupDialog from "../collaboration/RecordGroupDialog.vue";
import CollectionDialog from "../data/CollectionDialog.vue";
import ServerFormPreview from "../data/ServerFormPreview.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useNotices } from "../../stores/notices";
import { usePageDesignerStore } from "../../stores/pageDesigner";
import { platformApi } from "../../repositories/platformApi";
import {
  composeFormSchema,
  type FormSchema,
  type ServerDefinition,
  type PageVersionSummary,
  type PublishedPage,
  type DataModel,
} from "@platform/contracts";
import { emptySchema } from "../../domain/form";
import "../organization/access.css";
import "./publish.css";

const route = useRoute();
const router = useRouter();
const store = useNotices();
const designerStore = usePageDesignerStore();

const appId = computed(() => String(route.params.applicationId || ""));
const pageId = computed(() => String(route.params.pageId || ""));

const section = computed(() => {
  const value = route.query.section;
  return value === "access" || value === "collection" || value === "versions"
    ? value
    : "publish";
});
const pageData = computed(() => {
  const current = designerStore.data;
  return current?.draft.id === pageId.value ? current : undefined;
});
function selectSection(next: typeof section.value) {
  if (next === section.value) return;
  // 页签进入路由，刷新和后退保持位置；未保存保护由各设置页的路由守卫处理。
  void router.push({
    path: route.path,
    query: { ...route.query, section: next === "publish" ? undefined : next },
  });
}
const busy = ref(false);
const publishing = ref(false);
const error = ref("");
const helpOpen = ref(false);
const versions = ref<PageVersionSummary[]>([]);
const versionsError = ref("");
const versionsBusy = ref(false);
const previewBusy = ref(false);
const preview = ref<{ schema: FormSchema; title: string }>();
let active = true;
onBeforeUnmount(() => {
  active = false;
});

const fillUrl = computed(
  () =>
    `${window.location.origin}${window.location.pathname}#/applications/${appId.value}?form=${pageId.value}&view=fill`,
);

const pageTitle = computed(() => {
  return pageData.value?.draft?.title || "表单";
});

const isPublished = computed(() => {
  return (pageData.value?.draft?.latestVersion || 0) > 0;
});

const latestVersion = computed(() => {
  return pageData.value?.draft?.latestVersion || 0;
});
const latestPublication = computed(() =>
  versions.value.find((version) => version.version === latestVersion.value),
);
const publicationSummary = computed(() => {
  if (!isPublished.value) {
    return "完成表单设计后，发布即可供成员填写和收集数据";
  }
  const published = latestPublication.value;
  if (!published) return `当前版本 V${latestVersion.value}`;
  return `当前版本 V${published.version} · ${published.controlCount} 个控件 · ${publishedAt(published.createdAt)}`;
});
const emptyVersionsMessage = computed(() => {
  if (versionsBusy.value || busy.value) return "正在读取版本…";
  if (versionsError.value) return "版本读取失败，请重试";
  return "暂无已发布版本";
});

const pageSchema = computed<FormSchema>(() => {
  if (!pageData.value) return emptySchema();
  return composeFormSchema(pageData.value.model, pageData.value.draft.schema);
});

const serverDefinition = computed<Pick<ServerDefinition, "id" | "schema">>(
  () => ({
    id: pageData.value?.draft?.definitionId || pageId.value,
    schema: pageSchema.value,
  }),
);

async function loadPage() {
  if (!active || !pageId.value) return;
  busy.value = true;
  error.value = "";
  try {
    // 发布和设计共用同一份草稿，避免重复读取及旧页面延迟发起二次加载。
    await designerStore.load(pageId.value);
    if (!active) return;
    error.value = designerStore.error;
    if (pageData.value) await loadVersions();
  } finally {
    busy.value = false;
  }
}

async function loadVersions() {
  if (versionsBusy.value) return;
  versionsBusy.value = true;
  versionsError.value = "";
  try {
    const result = await platformApi<PageVersionSummary[]>(
      `/pages/${pageId.value}/versions`,
    );
    if (active) versions.value = result;
  } catch (cause) {
    if (active) versionsError.value = (cause as Error).message;
  } finally {
    versionsBusy.value = false;
  }
}

function publishedAt(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function previewVersion(version: number) {
  if (previewBusy.value) return;
  previewBusy.value = true;
  try {
    const result = await platformApi<{ page: PublishedPage; model: DataModel }>(
      `/pages/${pageId.value}?version=${version}`,
    );
    if (!active) return;
    // 历史预览只读取发布快照，不替换当前设计草稿。
    preview.value = {
      schema: composeFormSchema(result.model, result.page.schema),
      title: `V${result.page.version} · ${result.page.title}`,
    };
  } catch (cause) {
    if (active) store.notify((cause as Error).message, "error");
  } finally {
    previewBusy.value = false;
  }
}

async function handlePublish() {
  if (publishing.value || busy.value || !pageData.value) return;
  publishing.value = true;
  error.value = "";
  try {
    const ok = await designerStore.publish();
    if (!active) return;
    if (ok) {
      store.notify(`表单已发布 V${latestVersion.value}`);
      await loadVersions();
    } else {
      error.value = designerStore.error || "发布失败，请重试";
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "发布失败";
  } finally {
    publishing.value = false;
  }
}

async function copyFillUrl() {
  if (!isPublished.value) return;
  try {
    await navigator.clipboard.writeText(fillUrl.value);
    store.notify("填写链接已复制");
  } catch {
    store.notify("复制失败，请手动复制填写链接", "warning");
  }
}

function openFillUrl() {
  if (isPublished.value) window.open(fillUrl.value, "_blank", "noopener");
}

onMounted(() => {
  loadPage();
});
</script>

<template>
  <div class="application publish-page">
    <DesignerHeader
      :title="pageTitle"
      :app-id="appId"
      :form-id="pageId"
      active="publish"
      readonly-title
      @help="helpOpen = true"
    />
    <main class="publish-shell">
      <aside class="publish-side-nav" aria-label="表单发布导航">
        <button
          :class="{ active: section === 'publish' }"
          @click="selectSection('publish')"
        >
          <AppIcon name="share" />表单发布与分享
        </button>
        <button
          :class="{ active: section === 'access' }"
          @click="selectSection('access')"
        >
          <AppIcon name="user" />访问权限设置
        </button>
        <button
          :class="{ active: section === 'collection' }"
          @click="selectSection('collection')"
        >
          <AppIcon name="filter" />数据收集规则
        </button>
        <button
          :class="{ active: section === 'versions' }"
          @click="selectSection('versions')"
        >
          <AppIcon name="time" />版本历史记录
        </button>
      </aside>

      <section class="publish-content">
        <div v-if="error" class="publish-notice error" role="alert">
          {{ error }}
          <button
            v-if="!pageData"
            class="text-button"
            :disabled="busy"
            @click="loadPage"
          >
            重试
          </button>
        </div>

        <template v-if="section === 'publish'">
          <div class="publish-content-header">
            <h2>表单发布与分享</h2>
            <p class="subtitle">发布表单后，有权限的成员即可登录填写</p>
          </div>

          <div class="publication-status" :class="{ published: isPublished }">
            <div class="publication-icon" :class="{ draft: !isPublished }">
              <AppIcon :name="isPublished ? 'success' : 'form'" :size="30" />
            </div>
            <div class="publication-info">
              <h3>
                {{
                  isPublished ? `表单已发布 V${latestVersion}` : "表单尚未发布"
                }}
              </h3>
              <p>{{ publicationSummary }}</p>
            </div>
            <div class="publication-actions">
              <button
                class="button primary"
                :disabled="publishing || busy || !pageData"
                @click="handlePublish"
              >
                {{
                  publishing
                    ? "正在发布…"
                    : isPublished
                      ? "发布新版本"
                      : "立即发布"
                }}
              </button>
            </div>
          </div>

          <div class="publish-card">
            <h3>表单填写链接</h3>
            <p class="card-hint">
              {{
                isPublished
                  ? "成员登录后按权限填写，链接不会扩大访问范围"
                  : "发布表单后即可复制填写链接"
              }}
            </p>
            <div class="publish-link-bar">
              <input
                class="publish-link-input"
                :value="isPublished ? fillUrl : ''"
                :disabled="!isPublished"
                placeholder="请先发布表单"
                readonly
                aria-label="表单填写链接"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button
                class="button"
                :disabled="!isPublished"
                @click="copyFillUrl"
              >
                <AppIcon name="copy" />
                复制链接
              </button>
              <button
                class="button"
                :disabled="!isPublished"
                @click="openFillUrl"
              >
                <AppIcon name="link" />打开表单
              </button>
            </div>

            <div class="publish-share-options">
              <div class="share-option-card">
                <div>
                  <div class="share-option-header">
                    <AppIcon name="mobile" :size="20" />二维码分享
                  </div>
                  <p>扫码填写暂未开放，请使用上方的填写链接。</p>
                </div>
                <button class="button" disabled>暂未开放</button>
              </div>

              <div class="share-option-card">
                <div>
                  <div class="share-option-header">
                    <AppIcon name="code" :size="20" />网页嵌入
                  </div>
                  <p>网页嵌入暂未开放，请从填写链接打开表单。</p>
                </div>
                <button class="button" disabled>暂未开放</button>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'access'">
          <div class="publish-content-header">
            <h2>访问权限设置</h2>
            <p class="subtitle">
              针对不同部门、成员或角色，设置独立的数据录入与查看权限组
            </p>
          </div>
          <RecordGroupDialog
            v-if="pageData"
            :definition="serverDefinition"
            inline
            @saved="store.notify('权限组设置已保存')"
          />
        </template>

        <template v-else-if="section === 'collection'">
          <div class="publish-content-header">
            <h2>数据收集规则</h2>
            <p class="subtitle">控制表单收集时间范围、提交频次与数量上限</p>
          </div>
          <CollectionDialog
            v-if="pageData"
            :definition-id="serverDefinition.id"
            :title="pageTitle"
            inline
            @saved="store.notify('收集规则已保存')"
          />
        </template>

        <template v-else-if="section === 'versions'">
          <div class="publish-content-header">
            <h2>版本历史记录</h2>
            <p class="subtitle">查看历次发布的时间、控件数量与表单快照</p>
          </div>
          <div class="publish-card">
            <p v-if="versionsError" class="publish-notice error" role="alert">
              {{ versionsError }}
              <button
                class="text-button"
                :disabled="versionsBusy"
                @click="loadVersions"
              >
                重试
              </button>
            </p>
            <table class="publish-version-table">
              <thead>
                <tr>
                  <th>版本号</th>
                  <th>状态</th>
                  <th>控件数</th>
                  <th>发布时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="version in versions" :key="version.version">
                  <td>
                    <span class="version-badge">V{{ version.version }}</span>
                  </td>
                  <td>
                    {{
                      version.version === latestVersion
                        ? "当前生效"
                        : "历史版本"
                    }}
                  </td>
                  <td>{{ version.controlCount }} 个控件</td>
                  <td>{{ publishedAt(version.createdAt) }}</td>
                  <td>
                    <button
                      class="text-button"
                      :disabled="previewBusy"
                      :aria-label="`预览 V${version.version}`"
                      @click="previewVersion(version.version)"
                    >
                      预览
                    </button>
                  </td>
                </tr>
                <tr v-if="!versions.length">
                  <td colspan="5" class="publish-versions-empty">
                    {{ emptyVersionsMessage }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </main>

    <ServerFormPreview
      v-if="preview"
      :schema="preview.schema"
      :title="preview.title"
      :form-id="pageId"
      @close="preview = undefined"
    />

    <BaseDialog :open="helpOpen" title="表单发布帮助" @close="helpOpen = false">
      <div style="font-size: 14px; line-height: 1.7; color: #475569">
        <p>
          <strong>1. 表单发布</strong
          >：表单设计完成后，点击“立即发布”或“发布新版本”，即可保存为可被填写的稳定版本。
        </p>
        <p>
          <strong>2. 访问权限</strong
          >：可针对不同部门或角色创建权限组，设定字段的可编辑、只读或隐藏状态，并控制数据查看范围。
        </p>
        <p>
          <strong>3. 分享填写链接</strong
          >：成员登录后按权限填写；未登录会先进入登录页。二维码与网页嵌入暂未开放。
        </p>
      </div>
      <template #footer
        ><button class="button primary" @click="helpOpen = false">
          完成
        </button></template
      >
    </BaseDialog>
  </div>
</template>
