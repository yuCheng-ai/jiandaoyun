<script setup lang="ts">
import { entryTitle } from "../../domain/collaboration";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useWorkspaceStore } from "../../stores/workspace";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import WorkspaceHeader from "../../components/shared/WorkspaceHeader.vue";
const store = useWorkspaceStore();
const router = useRouter();
const query = ref("");
const dialog = ref("");
const appName = ref("");
const appColor = ref("#56ae72");
const showGuide = ref(sessionStorage.getItem("studio-guide-hidden") !== "1");
const workTab = ref("");
const apps = computed(() =>
  store.data.apps.filter((app) => app.name.includes(query.value)),
);
const recent = computed(() =>
  store.data.recentFormIds
    .map((id) => store.activeForms.find((f) => f.id === id))
    .filter(Boolean),
);
const menu = [
  { label: "我的待办", icon: "bell" },
  { label: "我发起的", icon: "start" },
  { label: "我处理的", icon: "done" },
  { label: "抄送我的", icon: "copy" },
  { label: "发起流程", icon: "launch" },
];
const pendingEntries = computed(() =>
  store.data.entries.filter(
    (e) =>
      !e.deletedAt &&
      e.status === "submitted" &&
      store.activeForms.some((f) => f.id === e.formId && f.kind === "workflow"),
  ),
);
const taskEntries = computed(() =>
  store.data.entries
    .filter((entry) => !entry.deletedAt)
    .filter((entry) =>
      workTab.value === "我的待办"
        ? entry.status === "submitted" &&
          store.activeForms.some(
            (f) => f.id === entry.formId && f.kind === "workflow",
          )
        : workTab.value === "我处理的"
          ? ["approved", "rejected"].includes(entry.status)
          : workTab.value === "抄送我的"
            ? entry.history.some((h) => h.label.includes("抄送"))
            : true,
    ),
);
function openTemplate(id: string) {
  const form = store.activeForms.find((f) => f.id === id);
  if (form)
    router.push(
      `/apps/${form.appId}/forms/${form.id}/${dialog.value === "templates" ? "design" : "fill"}`,
    );
  dialog.value = "";
}
function hideGuide() {
  showGuide.value = false;
  sessionStorage.setItem("studio-guide-hidden", "1");
}
async function createApp() {
  if (!appName.value.trim()) return;
  const app = await store.createApp(appName.value.trim(), appColor.value);
  if (app) {
    dialog.value = "";
    router.push(`/apps/${app.id}`);
  }
}
function menuClick(label: string) {
  if (label === "发起流程") {
    dialog.value = "start";
    return;
  }
  workTab.value = label;
}
function openForm(id: string) {
  const form = store.activeForms.find((f) => f.id === id);
  if (form) router.push(`/apps/${form.appId}/forms/${form.id}/design`);
}
function guideAction(index: number) {
  if (index === 0) dialog.value = "help";
  else if (index === 1)
    document.querySelector("#my-apps")?.scrollIntoView({ behavior: "smooth" });
  else if (index === 2) router.push("/apps/oa");
  else router.push("/admin/organization");
}
</script>
<template>
  <div class="workspace-page">
    <WorkspaceHeader
      @templates="dialog = 'templates'"
      @directory="router.push('/admin/organization')"
      @notifications="dialog = 'notifications'"
    />
    <main class="workbench-scroll">
      <div class="workbench-content">
        <section v-if="showGuide" class="guide-banner">
          <strong>新手引导</strong
          ><button
            class="guide-close icon-button"
            aria-label="关闭新手引导"
            @click="hideGuide"
          >
            <AppIcon name="close" />
          </button>
          <div class="guide-steps">
            <button
              v-for="(label, index) in [
                '了解本产品',
                '探索应用',
                '创建流程/表单',
                '邀请成员',
              ]"
              :key="label"
              @click="guideAction(index)"
            >
              <img :src="`/assets/guide-${index + 1}.png`" alt="" />
              <div>
                <b>{{ index + 1 }}.</b><span>{{ label }}</span>
              </div>
            </button>
          </div>
        </section>
        <div class="workbench-columns">
          <aside class="workbench-menu panel-card">
            <button @click="router.push('/applications')">
              <AppIcon name="layers" :size="18" />应用管理
            </button>
            <button
              v-for="(item, index) in menu"
              :key="item.label"
              :class="{
                active: workTab === item.label,
                'menu-separator': index === 4,
              }"
              @click="menuClick(item.label)"
            >
              <AppIcon :name="item.icon" :size="18" />{{ item.label
              }}<span
                v-if="index === 0 && pendingEntries.length > 0"
                class="count-dot"
                >{{ pendingEntries.length }}</span
              >
            </button>
          </aside>
          <div class="workbench-main">
            <template v-if="workTab"
              ><section class="panel-card task-panel">
                <header class="section-heading">
                  <h2>{{ workTab }}</h2>
                  <button class="text-button" @click="workTab = ''">
                    返回应用
                  </button>
                </header>
                <div v-if="!taskEntries.length" class="workspace-empty">
                  <AppIcon name="done" :size="48" />
                  <p>暂无{{ workTab.slice(1) }}记录</p>
                </div>
                <button
                  v-for="entry in taskEntries"
                  :key="entry.id"
                  class="task-row"
                  @click="
                    router.push(
                      `/apps/${store.activeForms.find((f) => f.id === entry.formId)?.appId}/forms/${entry.formId}/data`,
                    )
                  "
                >
                  <AppIcon name="form" /><span
                    >{{ entryTitle(entry, store.data)
                    }}<small>{{
                      new Date(entry.createdAt).toLocaleString("zh-CN")
                    }}</small></span
                  ><span class="status-tag">{{
                    entry.status === "submitted"
                      ? store.activeForms.find((f) => f.id === entry.formId)
                          ?.kind === "workflow"
                        ? "待处理"
                        : "已提交"
                      : entry.status === "draft"
                        ? "草稿"
                        : "已处理"
                  }}</span
                  ><AppIcon name="down" />
                </button></section
            ></template>
            <template v-else
              ><section class="panel-card recent-panel">
                <header class="section-heading"><h2>最近使用</h2></header>
                <div class="recent-grid">
                  <button
                    v-for="form in recent"
                    :key="form!.id"
                    @click="openForm(form!.id)"
                  >
                    <AppIcon
                      :name="form!.kind === 'workflow' ? 'condition' : 'form'"
                      :size="20"
                      :class="
                        form!.kind === 'workflow' ? 'orange-icon' : 'blue-icon'
                      "
                    /><span>{{ form!.title }}</span>
                  </button>
                  <p v-if="!recent.length" class="muted">
                    还没有最近使用的表单
                  </p>
                </div>
              </section>
              <section id="my-apps" class="panel-card apps-panel">
                <header class="section-heading">
                  <h2>我的应用 <AppIcon name="settings" class="muted" /></h2>
                  <div class="section-actions">
                    <div class="search-input">
                      <AppIcon name="search" /><input
                        v-model="query"
                        aria-label="搜索应用"
                        placeholder="请输入名称来搜索"
                      />
                    </div>
                    <button
                      class="button primary"
                      @click="
                        appName = '';
                        dialog = 'create-app';
                      "
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
                    @click="router.push(`/apps/${app.id}`)"
                  >
                    <span
                      class="application-tile"
                      :style="{ background: app.color }"
                      ><AppIcon :name="app.icon" :size="29" /></span
                    ><span>{{ app.name }}</span>
                  </button>
                </div>
                <div v-if="!apps.length" class="workspace-empty">
                  没有找到匹配的应用
                </div>
              </section>
              <section class="panel-card charts-panel">
                <header class="section-heading">
                  <h2>我的图表</h2>
                  <button class="text-button" @click="dialog = 'charts'">
                    <AppIcon name="add" />添加
                  </button>
                </header>
                <div
                  v-if="store.data.entries.filter((e) => !e.deletedAt).length"
                  class="workspace-stats"
                >
                  <div>
                    <strong>{{ store.activeForms.length }}</strong
                    ><span>表单</span>
                  </div>
                  <div>
                    <strong>{{
                      store.data.entries.filter((e) => !e.deletedAt).length
                    }}</strong
                    ><span>累计提交</span>
                  </div>
                  <div>
                    <strong>{{ pendingEntries.length }}</strong
                    ><span>待处理</span>
                  </div>
                </div>
                <div v-else class="charts-empty">
                  暂无图表
                  <button class="text-button" @click="dialog = 'charts'">
                    添加
                  </button>
                </div>
              </section></template
            >
          </div>
        </div>
      </div>
    </main>
    <BaseDialog
      :busy="store.writePending"
      v-if="dialog"
      :open="true"
      :title="
        (
          {
            'create-app': '新建应用',
            directory: '通讯录',
            templates: '模板中心',
            notifications: '通知',
            start: '发起流程',
            help: '开始使用工作台',
            charts: '工作台图表',
          } as Record<string, string>
        )[dialog] || dialog
      "
      @close="dialog = ''"
    >
      <template v-if="dialog === 'create-app'"
        ><div class="form-group">
          <label for="new-app-name">应用名称</label
          ><input
            id="new-app-name"
            v-model="appName"
            placeholder="为应用起个名字"
            maxlength="40"
            @keydown.enter="createApp"
          />
        </div>
        <label class="standalone-label">应用颜色</label>
        <div class="color-swatches">
          <button
            v-for="color in [
              '#56ae72',
              '#f1af56',
              '#548ddb',
              '#a777d4',
              '#53b0bd',
              '#dc7d87',
            ]"
            :key="color"
            :style="{ background: color }"
            :aria-label="color"
            :class="{ selected: appColor === color }"
            @click="appColor = color"
          >
            <AppIcon v-if="appColor === color" name="check" />
          </button></div
      ></template>
      <div
        v-else-if="dialog === 'templates' || dialog === 'start'"
        class="template-list"
      >
        <button
          v-for="form in store.activeForms.filter(
            (f) => dialog === 'templates' || f.kind === 'workflow',
          )"
          :key="form.id"
          @click="openTemplate(form.id)"
        >
          <AppIcon name="form" /><span>{{ form.title }}</span
          ><AppIcon name="back" class="rotate-icon" />
        </button>
      </div>
      <p v-else-if="dialog === 'help'" class="dialog-description">
        从「我的应用」进入表单列表，新建普通表单或流程表单。在设计器中添加字段、设置属性，并通过预览验证填写效果。保存配置后，可在「表单发布」创建本地发布版本。
      </p>
      <p v-else-if="dialog === 'charts'" class="dialog-description">
        表单提交后，这里会显示表单数量、累计提交和待处理数量。<button
          class="text-button"
          @click="
            dialog = '';
            router.push('/apps/oa');
          "
        >
          前往表单列表
        </button>
      </p>
      <p v-else class="dialog-description">暂无新通知</p>
      <template #footer
        ><button class="button" @click="dialog = ''">关闭</button
        ><button
          v-if="dialog === 'create-app'"
          class="button primary"
          :disabled="!appName.trim()"
          @click="createApp"
        >
          创建应用
        </button></template
      >
    </BaseDialog>
  </div>
</template>
