<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import PublishAccessSettings from "./components/PublishAccessSettings.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { usePageDesignerStore } from "../../stores/pageDesigner";
import { platformApi } from "../../repositories/platformApi";
import { newForm, type FormRecord } from "../../domain/workspace";
import {
  composeFormSchema,
  type PageEditorData,
  type FormSchema,
} from "@platform/contracts";
import { emptySchema } from "../../domain/form";
import "../organization/access.css";
import "./publish.css";

const route = useRoute();
const router = useRouter();
const store = useWorkspaceStore();
const designerStore = usePageDesignerStore();

const appId = computed(
  () => String(route.params.applicationId || route.params.appId || ""),
);
const pageId = computed(
  () => String(route.params.pageId || route.params.formId || ""),
);

const section = ref<"publish" | "access" | "collection" | "versions">("publish");
const pageData = ref<PageEditorData>();
const busy = ref(false);
const publishing = ref(false);
const feedback = ref("");
const error = ref("");
const helpOpen = ref(false);
const qrOpen = ref(false);
const copied = ref(false);

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

const pageSchema = computed<FormSchema>(() => {
  if (!pageData.value) return emptySchema();
  return composeFormSchema(
    pageData.value.model,
    pageData.value.draft.schema,
  );
});

const workspaceForm = computed<FormRecord>(() => {
  let f = store.data.forms.find((form) => form.id === pageId.value);
  if (!f) {
    f = newForm(appId.value, pageTitle.value);
    f.id = pageId.value;
    f.appId = appId.value;
    store.data.forms.push(f);
  }
  f.title = pageTitle.value;
  f.schema = pageSchema.value;
  if (latestVersion.value > 0) {
    f.published = {
      version: latestVersion.value,
      title: pageTitle.value,
      publishedAt: new Date().toISOString(),
      schema: pageSchema.value,
      workflow: f.workflow,
    };
  }
  return f;
});

async function loadPage() {
  if (!pageId.value) return;
  busy.value = true;
  error.value = "";
  try {
    const data = await platformApi<PageEditorData>(
      `/pages/${pageId.value}/editor`,
    );
    if (data) {
      pageData.value = data;
    }
    await designerStore.load(pageId.value);
  } catch (cause: any) {
    error.value = cause.message || "加载页面信息失败";
  } finally {
    busy.value = false;
  }
}

async function handlePublish() {
  publishing.value = true;
  error.value = "";
  feedback.value = "";
  try {
    const impact = await designerStore.preparePublication();
    if (!impact) {
      error.value = designerStore.error || "发布校验未通过，请检查表单设计";
      return;
    }
    const ok = await designerStore.publish(impact);
    if (ok) {
      await loadPage();
      feedback.value = `表单已成功发布新版本 V${latestVersion.value}！`;
      store.notify(`表单已发布 V${latestVersion.value}`);
    } else {
      error.value = designerStore.error || "发布失败，请重试";
    }
  } catch (cause: any) {
    error.value = cause.message || "发布失败";
  } finally {
    publishing.value = false;
  }
}

function copyFillUrl() {
  navigator.clipboard.writeText(fillUrl.value).then(() => {
    copied.value = true;
    store.notify("填写链接已复制到剪贴板");
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  });
}

function openFillUrl() {
  window.open(fillUrl.value, "_blank");
}

function copyEmbedCode() {
  navigator.clipboard
    .writeText(
      `<iframe src="${fillUrl.value}" width="100%" height="800" frameborder="0"></iframe>`,
    )
    .then(() => {
      store.notify("嵌入代码已复制到剪贴板");
    });
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
      @help="helpOpen = true"
    />
    <main class="publish-shell">
      <aside class="publish-side-nav" aria-label="表单发布导航">
        <button
          :class="{ active: section === 'publish' }"
          @click="section = 'publish'"
        >
          <AppIcon name="share" />表单发布与分享
        </button>
        <button
          :class="{ active: section === 'access' }"
          @click="section = 'access'"
        >
          <AppIcon name="user" />访问权限设置
        </button>
        <button
          :class="{ active: section === 'collection' }"
          @click="section = 'collection'"
        >
          <AppIcon name="filter" />数据收集规则
        </button>
        <button
          :class="{ active: section === 'versions' }"
          @click="section = 'versions'"
        >
          <AppIcon name="time" />版本历史记录
        </button>
      </aside>

      <section class="publish-content">
        <div v-if="feedback" class="publish-notice success" role="status">
          {{ feedback }}
        </div>
        <div v-if="error" class="publish-notice error" role="alert">
          {{ error }}
        </div>

        <template v-if="section === 'publish'">
          <div class="publish-content-header">
            <h2>表单发布与分享</h2>
            <p class="subtitle">将表单发布后，即可在组织内或公开收集数据</p>
          </div>

          <div
            class="publication-status"
            :class="{ published: isPublished }"
          >
            <div class="publication-icon" :class="{ draft: !isPublished }">
              <AppIcon :name="isPublished ? 'success' : 'form'" :size="30" />
            </div>
            <div class="publication-info">
              <h3>{{ isPublished ? `表单已发布 V${latestVersion}` : "表单尚未发布" }}</h3>
              <p>
                {{
                  isPublished
                    ? `当前版本 V${latestVersion} · 包含 ${pageData?.draft?.schema?.controls?.length || 0} 个表单控件`
                    : "完成表单与流程设计后，发布即可供成员填写和收集数据"
                }}
              </p>
            </div>
            <div class="publication-actions">
              <button
                class="button primary"
                :disabled="publishing || busy"
                @click="handlePublish"
              >
                {{ publishing ? "正在发布…" : isPublished ? "发布新版本" : "立即发布" }}
              </button>
            </div>
          </div>

          <div class="publish-card">
            <h3>表单填写链接</h3>
            <p class="card-hint">成员或外部人员通过此链接直接填写并提交数据</p>
            <div class="publish-link-bar">
              <input
                class="publish-link-input"
                :value="fillUrl"
                readonly
                aria-label="表单填写链接"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button class="button" @click="copyFillUrl">
                <AppIcon :name="copied ? 'success' : 'copy'" />
                {{ copied ? "已复制" : "复制链接" }}
              </button>
              <button class="button" @click="openFillUrl">
                <AppIcon name="link" />打开表单
              </button>
            </div>

            <div class="publish-share-options">
              <div class="share-option-card">
                <div>
                  <div class="share-option-header">
                    <AppIcon name="mobile" :size="20" />二维码分享
                  </div>
                  <p>生成移动端二维码，适用于手机端扫码快速填报。</p>
                </div>
                <button class="button" @click="qrOpen = true">查看二维码</button>
              </div>

              <div class="share-option-card">
                <div>
                  <div class="share-option-header">
                    <AppIcon name="code" :size="20" />网页嵌入
                  </div>
                  <p>嵌入到企业内网门户或第三方系统页面中。</p>
                </div>
                <button class="button" @click="copyEmbedCode">
                  复制代码
                </button>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'access'">
          <div class="publish-content-header">
            <h2>访问权限设置</h2>
            <p class="subtitle">针对不同部门、成员或角色，设置独立的数据录入与查看权限组</p>
          </div>
          <PublishAccessSettings :form="workspaceForm" />
        </template>

        <template v-else-if="section === 'collection'">
          <div class="publish-content-header">
            <h2>数据收集规则</h2>
            <p class="subtitle">控制表单收集时间范围、提交频次与数量上限</p>
          </div>
          <div class="publish-card">
            <h3>收集时间限制</h3>
            <p class="card-hint">设定收集开启与截止时间，超时后表单自动停止接收提交</p>
            <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 24px;">
              <label style="font-size: 13px; color: #4b5563;">
                开始时间：
                <input type="datetime-local" class="publish-link-input" style="width: auto; margin-left: 8px;" />
              </label>
              <label style="font-size: 13px; color: #4b5563;">
                截止时间：
                <input type="datetime-local" class="publish-link-input" style="width: auto; margin-left: 8px;" />
              </label>
            </div>

            <h3>提交次数与数量限制</h3>
            <p class="card-hint">防止同一用户多次提交，或设置总记录数上限</p>
            <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px;">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #374151;">
                <input type="checkbox" checked />允许同一成员多次提交
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #374151;">
                <input type="checkbox" />限制收集总量上限（达到上限后自动停止）
              </label>
            </div>

            <button
              class="button primary"
              @click="store.notify('收集规则已保存，发布后生效')"
            >
              保存收集规则
            </button>
          </div>
        </template>

        <template v-else-if="section === 'versions'">
          <div class="publish-content-header">
            <h2>版本历史记录</h2>
            <p class="subtitle">查看历次发布的表单版本快照与控件变更</p>
          </div>
          <div class="publish-card">
            <table class="publish-version-table">
              <thead>
                <tr>
                  <th>版本号</th>
                  <th>状态</th>
                  <th>字段与控件数</th>
                  <th>发布时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="isPublished">
                  <td><span class="version-badge">V{{ latestVersion }}</span></td>
                  <td>当前生效</td>
                  <td>{{ pageData?.draft?.schema?.controls?.length || 0 }} 个控件</td>
                  <td>{{ new Date().toLocaleString("zh-CN") }}</td>
                </tr>
                <tr v-else>
                  <td colspan="4" style="text-align: center; color: #94a3b8; padding: 24px;">
                    暂无已发布版本，点击右上角发布表单生成首个版本
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </main>

    <BaseDialog
      :open="qrOpen"
      title="扫码填写表单"
      confirm-text="完成"
      @close="qrOpen = false"
      @confirm="qrOpen = false"
    >
      <div class="qr-code-box">
        <div class="qr-code-placeholder">
          <svg viewBox="0 0 100 100" width="140" height="140">
            <rect width="100" height="100" fill="#fff"/>
            <rect x="10" y="10" width="24" height="24" fill="#00a399"/>
            <rect x="14" y="14" width="16" height="16" fill="#fff"/>
            <rect x="18" y="18" width="8" height="8" fill="#00a399"/>
            <rect x="66" y="10" width="24" height="24" fill="#00a399"/>
            <rect x="70" y="14" width="16" height="16" fill="#fff"/>
            <rect x="74" y="18" width="8" height="8" fill="#00a399"/>
            <rect x="10" y="66" width="24" height="24" fill="#00a399"/>
            <rect x="14" y="70" width="16" height="16" fill="#fff"/>
            <rect x="18" y="74" width="8" height="8" fill="#00a399"/>
            <rect x="42" y="42" width="16" height="16" fill="#00a399"/>
            <rect x="42" y="14" width="10" height="10" fill="#00a399"/>
            <rect x="14" y="42" width="10" height="10" fill="#00a399"/>
            <rect x="70" y="42" width="10" height="10" fill="#00a399"/>
            <rect x="42" y="70" width="10" height="10" fill="#00a399"/>
            <rect x="66" y="66" width="14" height="14" fill="#00a399"/>
          </svg>
        </div>
        <p style="font-size: 13px; color: #64748b; text-align: center;">
          使用手机微信或移动端浏览器扫码直接打开填报
        </p>
      </div>
    </BaseDialog>

    <BaseDialog
      :open="helpOpen"
      title="表单发布帮助"
      confirm-text="我知道了"
      @close="helpOpen = false"
      @confirm="helpOpen = false"
    >
      <div style="font-size: 14px; line-height: 1.7; color: #475569;">
        <p><strong>1. 表单发布</strong>：表单设计完成后，点击“立即发布”或“发布新版本”，即可保存为可被填写的稳定版本。</p>
        <p><strong>2. 访问权限</strong>：可针对不同部门或角色创建权限组，设定字段的可编辑、只读或隐藏状态，并控制数据查看范围。</p>
        <p><strong>3. 数据分享</strong>：通过专属链接或二维码在组织内外收集数据，支持一键嵌入企业内网。</p>
      </div>
    </BaseDialog>
  </div>
</template>
