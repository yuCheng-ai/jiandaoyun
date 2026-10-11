<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useDialogLayer } from "../../composables/useDialogLayer";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UserMenu from "../../components/shared/UserMenu.vue";
import FormFilling from "../forms/components/FormFilling.vue";
import CreateFormDialog from "./CreateFormDialog.vue";
import FormActions from "./FormActions.vue";
import { useWorkspaceStore } from "../../stores/workspace";
const store = useWorkspaceStore(),
  route = useRoute(),
  router = useRouter();
const appId = computed(() => String(route.params.appId));
const app = computed(() =>
  store.data.apps.find((item) => item.id === appId.value),
);
const forms = computed(() =>
  store.activeForms.filter((form) => form.appId === appId.value),
);
const selected = computed(() =>
  route.query.form
    ? forms.value.find((form) => form.id === route.query.form)
    : forms.value.find((form) => form.published) || forms.value[0],
);
onMounted(() => {
  if (!route.query.form && selected.value)
    void router.replace({ query: { ...route.query, form: selected.value.id } });
});
const query = ref(""),
  createOpen = ref(false),
  helpOpen = ref(false),
  navigationOpen = ref(false);
const fillingView = ref<InstanceType<typeof FormFilling>>();
const folderOpen = ref(false),
  folderName = ref(""),
  folderError = ref("");
const trashOpen = ref(false),
  trashQuery = ref("");
const archived = computed(() =>
  store.data.forms.filter(
    (form) =>
      form.appId === appId.value &&
      form.archived &&
      form.title
        .toLocaleLowerCase()
        .includes(trashQuery.value.trim().toLocaleLowerCase()),
  ),
);
function newFolder() {
  folderName.value = "";
  folderError.value = "";
  folderOpen.value = true;
}
async function saveFolder() {
  const name = folderName.value.trim();
  if (!name || store.writePending) return;
  if (app.value?.folders.includes(name)) {
    folderError.value = "分组名称已存在";
    return;
  }
  if (await store.createFolder(appId.value, name)) {
    expanded.value.add(name);
    folderOpen.value = false;
  }
}
async function archiveSelected() {
  const id = selected.value?.id;
  if (!id || store.writePending) return;
  const archive = async () => {
    if (await store.archiveForm(id)) {
      store.notify("已移入回收站");
      void router.replace({ path: `/apps/${appId.value}`, query: {} });
    }
  };
  if (fillingView.value) await fillingView.value.runAfterLeave(archive);
  else await archive();
}
async function restoreForm(id: string) {
  if (!store.writePending && (await store.archiveForm(id, false)))
    store.notify("表单已恢复");
}
const sidebar = ref<HTMLElement>();
const mobileTrigger = ref<HTMLElement>();
function resizeNavigation() {
  if (window.innerWidth > 760) navigationOpen.value = false;
}
window.addEventListener("resize", resizeNavigation);
onBeforeUnmount(() => window.removeEventListener("resize", resizeNavigation));
const { zIndex } = useDialogLayer(
  computed(() => (navigationOpen.value ? sidebar.value : undefined)),
  () => {
    navigationOpen.value = false;
  },
  undefined,
  { anchor: () => mobileTrigger.value },
);
const expanded = ref(
  new Set(selected.value?.folder ? [selected.value.folder] : []),
);
const matching = computed(() =>
  forms.value.filter((form) =>
    form.title
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  ),
);
const folders = computed(() => [
  ...new Set([
    ...(app.value?.folders || []),
    ...forms.value.map((form) => form.folder).filter(Boolean),
  ]),
]);
const ungrouped = computed(() => matching.value.filter((form) => !form.folder));
function toggleFolder(folder: string) {
  if (expanded.value.has(folder)) expanded.value.delete(folder);
  else expanded.value.add(folder);
}
function openForm(id: string) {
  navigationOpen.value = false;
  if (id === selected.value?.id) {
    return;
  }
  void router.push({ path: `/apps/${appId.value}`, query: { form: id } });
}
function manage(section: string) {
  if (selected.value)
    void router.push(
      `/apps/${appId.value}/forms/${selected.value.id}/${section}`,
    );
}
</script>
<template>
  <div class="application-home" :class="{ 'navigation-open': navigationOpen }">
    <Teleport to="body" :disabled="!navigationOpen">
      <aside
        ref="sidebar"
        class="application-home-sidebar"
        :class="{ 'mobile-navigation': navigationOpen }"
        :style="navigationOpen ? { zIndex } : undefined"
        :role="navigationOpen ? 'dialog' : undefined"
        :aria-modal="navigationOpen || undefined"
        aria-label="应用导航"
      >
        <header>
          <button
            class="icon-button"
            aria-label="返回工作台"
            @click="router.push('/')"
          >
            <AppIcon name="back" :size="22" />
          </button>
          <span class="small-app-tile" :style="{ background: app?.color }"
            ><AppIcon :name="app?.icon || 'layers'"
          /></span>
          <strong>{{ app?.name || "应用不存在" }}</strong>
          <button
            class="icon-button mobile-close-navigation"
            aria-label="收起表单导航"
            @click="navigationOpen = false"
          >
            <AppIcon name="close" />
          </button>
        </header>
        <div class="application-home-search">
          <label
            ><AppIcon name="search" :size="15" /><input
              v-model="query"
              aria-label="搜索应用表单"
              placeholder="输入名称来搜索"
          /></label>
          <button
            v-if="app"
            class="icon-button"
            aria-label="新建表单"
            @click="createOpen = true"
          >
            <AppIcon name="add" :size="21" />
          </button>
        </div>
        <nav class="application-form-navigation" aria-label="表单">
          <template v-for="folder in folders" :key="folder">
            <template
              v-if="
                !query.trim() || matching.some((form) => form.folder === folder)
              "
            >
              <button
                class="application-folder"
                :aria-expanded="expanded.has(folder) || !!query.trim()"
                @click="toggleFolder(folder)"
              >
                <AppIcon name="folder" class="folder-icon" /><span>{{
                  folder
                }}</span>
              </button>
              <div
                v-if="expanded.has(folder) || query.trim()"
                class="application-folder-forms"
              >
                <button
                  v-for="form in matching.filter(
                    (form) => form.folder === folder,
                  )"
                  :key="form.id"
                  :class="{ active: selected?.id === form.id }"
                  :aria-current="selected?.id === form.id ? 'page' : undefined"
                  :title="form.title"
                  @click="openForm(form.id)"
                >
                  <AppIcon
                    :name="form.kind === 'workflow' ? 'condition' : 'document'"
                    :class="
                      form.kind === 'workflow' ? 'orange-icon' : 'blue-icon'
                    "
                  /><span>{{ form.title }}</span>
                </button>
                <p
                  v-if="!matching.some((form) => form.folder === folder)"
                  class="application-nav-empty"
                >
                  暂无表单
                </p>
              </div>
            </template>
          </template>
          <button
            v-for="form in ungrouped"
            :key="form.id"
            :class="{ active: selected?.id === form.id }"
            :aria-current="selected?.id === form.id ? 'page' : undefined"
            :title="form.title"
            @click="openForm(form.id)"
          >
            <AppIcon
              :name="form.kind === 'workflow' ? 'condition' : 'document'"
              :class="form.kind === 'workflow' ? 'orange-icon' : 'blue-icon'"
            /><span>{{ form.title }}</span>
          </button>
          <p
            v-if="query.trim() && !matching.length"
            class="application-nav-empty"
          >
            没有找到表单
          </p>
        </nav>
        <footer>
          <button v-if="app" @click="newFolder">
            <AppIcon name="folder" />新建分组
          </button>
          <button
            v-if="app"
            @click="
              trashQuery = '';
              trashOpen = true;
            "
          >
            <AppIcon name="trash" />回收站
          </button>
        </footer>
      </aside>
      <button
        v-if="navigationOpen"
        class="application-navigation-shade"
        :style="{ zIndex: zIndex - 1 }"
        aria-label="收起表单导航"
        @click="navigationOpen = false"
      />
    </Teleport>
    <main class="application-home-main">
      <header class="application-form-toolbar">
        <button
          ref="mobileTrigger"
          class="icon-button mobile-open-navigation"
          aria-label="展开表单导航"
          :aria-expanded="navigationOpen"
          @click="navigationOpen = !navigationOpen"
        >
          <AppIcon name="menu" :size="20" />
        </button>
        <h1 :title="selected?.title">
          {{ selected?.title || app?.name || "应用不存在" }}
        </h1>
        <div v-if="selected" class="application-form-actions">
          <button @click="manage('design')"><AppIcon name="edit" />编辑</button>
          <button @click="manage('data')">
            <AppIcon name="table" />数据管理
          </button>
          <FormActions
            :key="selected.id"
            :form-id="selected.id"
            :app-id="appId"
            @archive="archiveSelected"
          />
        </div>
        <div class="application-form-utilities">
          <button
            class="icon-button"
            aria-label="通讯录"
            @click="router.push('/admin/organization')"
          >
            <AppIcon name="people" />
          </button>
          <button
            class="icon-button"
            aria-label="帮助"
            @click="helpOpen = true"
          >
            <AppIcon name="help" :size="18" />
          </button>
          <UserMenu />
        </div>
      </header>
      <FormFilling
        v-if="selected?.published"
        ref="fillingView"
        :key="selected.id"
        :form-id="selected.id"
      />
      <div v-else class="application-form-unavailable">
        <AppIcon name="form" :size="42" />
        <h2>
          {{
            selected
              ? "表单尚未发布"
              : route.query.form
                ? "表单不存在或已停用"
                : app
                  ? "还没有表单"
                  : "应用不存在"
          }}
        </h2>
        <button
          v-if="selected"
          class="button primary"
          @click="manage('design')"
        >
          编辑表单
        </button>
        <button
          v-else-if="app && !route.query.form"
          class="button primary"
          @click="createOpen = true"
        >
          新建表单
        </button>
        <button
          v-else
          class="button"
          @click="router.push(app ? `/apps/${appId}` : '/')"
        >
          {{ app ? "返回应用首页" : "返回工作台" }}
        </button>
      </div>
    </main>
    <CreateFormDialog
      :open="createOpen"
      :app-id="appId"
      @close="createOpen = false"
    />
    <BaseDialog
      :open="folderOpen"
      title="新建分组"
      width="380px"
      :busy="store.writePending"
      @close="folderOpen = false"
    >
      <div class="form-group">
        <label for="new-folder-name">分组名称</label>
        <input
          id="new-folder-name"
          v-model="folderName"
          maxlength="60"
          @input="folderError = ''"
          @keydown.enter="saveFolder"
        />
      </div>
      <p v-if="folderError" class="field-error" role="alert">
        {{ folderError }}
      </p>
      <template #footer>
        <button class="button" @click="folderOpen = false">取消</button>
        <button
          class="button primary"
          :disabled="!folderName.trim()"
          @click="saveFolder"
        >
          创建
        </button>
      </template>
    </BaseDialog>
    <BaseDialog
      :open="trashOpen"
      title="回收站"
      width="560px"
      :busy="store.writePending"
      @close="trashOpen = false"
    >
      <input
        v-model="trashQuery"
        aria-label="搜索已删除表单"
        placeholder="搜索表单名称"
      />
      <ul class="application-trash-list">
        <li v-for="form in archived" :key="form.id">
          <AppIcon
            :name="form.kind === 'workflow' ? 'condition' : 'document'"
          />
          <span>{{ form.title }}</span>
          <button
            class="text-button"
            :aria-label="`恢复 ${form.title}`"
            @click="restoreForm(form.id)"
          >
            恢复
          </button>
        </li>
      </ul>
      <p v-if="!archived.length" class="application-nav-empty">
        {{ trashQuery.trim() ? "没有找到表单" : "回收站为空" }}
      </p>
    </BaseDialog>
    <BaseDialog
      :open="helpOpen"
      title="填写表单"
      width="420px"
      @close="helpOpen = false"
    >
      <p>
        从左侧选择表单，填写后提交；未填完可以保存草稿，在数据管理中继续填写。
      </p>
      <template #footer
        ><button class="button" @click="helpOpen = false">
          知道了
        </button></template
      >
    </BaseDialog>
  </div>
</template>
<style>
.application-home {
  height: 100dvh;
  display: flex;
  gap: 8px;
  padding: 0 8px 8px 0;
  background: #f2f3f8;
  overflow: hidden;
}
.application-home-sidebar {
  flex: 0 0 272px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.application-home-sidebar > header {
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}
.application-home-sidebar > header strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.application-home-sidebar .small-app-tile {
  flex-shrink: 0;
}
.application-home-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 16px 14px 22px;
  min-height: 52px;
}
.application-home-search label {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  gap: 5px;
}
.application-home-search input:not([type]) {
  border: none;
  padding: 0;
  min-height: 28px;
  background: transparent;
  font-size: 13px;
  box-shadow: none;
}
.application-form-navigation {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 12px 12px;
}
.application-form-navigation button {
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  text-align: left;
  border-radius: 5px;
  font-size: 14px;
}
.application-form-navigation button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.application-form-navigation button:hover {
  background: #e9ebf2;
}
.application-form-navigation button.active {
  background: #e3e4eb;
  font-weight: 600;
}
.application-folder-forms > button {
  padding-left: 26px;
}
.application-nav-empty {
  color: #939ca9;
  padding: 10px 24px;
  font-size: 12px;
}
.application-home-sidebar > footer {
  display: flex;
  flex-shrink: 0;
  margin: 0 12px;
  border-top: 1px solid #e3e6ed;
}
.application-home-sidebar > footer button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 48px;
  padding: 0 8px;
  text-align: left;
}
.application-trash-list {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
}
.application-trash-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #eef0f3;
}
.application-trash-list li > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.application-trash-list li > button {
  flex-shrink: 0;
}
.application-home-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin-top: 6px;
  background: white;
  border: 1px solid #e5e8ef;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.application-form-toolbar {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 24px 0 12px;
  border-bottom: 1px solid #e2e6ee;
  background: #f8f8fc;
}
.application-form-toolbar h1 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  max-width: 38%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.application-form-actions {
  display: flex;
  align-items: center;
  gap: 22px;
  border-left: 1px solid #d9dfe9;
  padding-left: 16px;
  flex-shrink: 0;
}
.application-form-actions > button {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  font-size: 14px;
  height: 32px;
}
.application-form-utilities {
  display: flex;
  align-items: center;
  gap: 22px;
  margin-left: auto;
}
.application-home .application-fill-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.application-home
  .application-fill-scroll
  > .external-form:not(.themed)
  > .fill-page-sheet {
  max-width: none;
  min-height: 100%;
  box-shadow: none;
  display: flex;
  flex-direction: column;
}
.application-home .application-fill-scroll .fill-page-sheet > .form-runtime {
  flex: 1;
}
.application-home .application-fill-scroll .fill-page-sheet .runtime-content {
  padding: 24px 24px 35px;
}
.application-home .application-fill-scroll .fill-page-sheet .runtime-label {
  font-size: 14px;
  font-weight: 600;
  line-height: 18px;
  margin-bottom: 5px;
}
.application-home
  .application-fill-scroll
  .fill-page-sheet
  .runtime-field-content
  > textarea {
  max-width: min(100%, calc(var(--input-width, 354px) * 2 + 24px));
  min-height: 142px;
}
.application-home .application-fill-scroll .fill-page-sheet .runtime-footer {
  padding: 9px 24px;
}
.mobile-open-navigation,
.mobile-close-navigation,
.application-navigation-shade {
  display: none;
}
@media (max-width: 760px) {
  .application-home {
    padding: 0;
    gap: 0;
  }
  .application-home-sidebar {
    display: none;
  }
  .application-home-main {
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  .application-form-toolbar {
    padding: 0 12px;
    gap: 8px;
  }
  .application-form-toolbar h1 {
    flex: 1;
    max-width: none;
    min-width: 40px;
  }
  .application-form-actions {
    gap: 12px;
    padding-left: 10px;
  }
  .application-form-actions > button {
    font-size: 13px;
  }
  .application-form-actions > button:not(.icon-button) .app-icon {
    display: none;
  }
  .application-form-utilities {
    gap: 0;
    margin-left: 3px;
  }
  .application-form-utilities > .icon-button {
    display: none;
  }
  .mobile-open-navigation,
  .mobile-close-navigation {
    display: inline-flex;
    flex-shrink: 0;
  }
  .mobile-close-navigation {
    margin-left: auto;
  }
  .application-home-sidebar.mobile-navigation {
    display: flex;
    position: fixed;
    inset: 0 auto 0 0;
    width: min(300px, calc(100% - 44px));
    background: #f2f3f8;
    z-index: 31;
  }
  .application-navigation-shade {
    display: block;
    position: fixed;
    inset: 0;
    background: #20293855;
    z-index: 30;
  }
  .application-home .application-fill-scroll .fill-page-sheet .runtime-content {
    padding: 20px 16px;
  }
  .application-home .application-fill-scroll .fill-page-sheet .runtime-footer {
    padding: 10px 16px;
  }
}
</style>
