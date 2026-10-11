<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import ApplicationHomeLayout from "./ApplicationHomeLayout.vue";
import { usePlatformSession } from "../../stores/platformSession";
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
const createOpen = ref(false),
  helpOpen = ref(false);
const shell = ref<InstanceType<typeof ApplicationHomeLayout>>();
const session = usePlatformSession();
async function logout() {
  await session.logout();
  await router.replace("/");
}
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
    shell.value?.expandFolder(name);
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
function openForm(id: string) {
  if (id !== selected.value?.id)
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
  <ApplicationHomeLayout
    ref="shell"
    :app="app"
    :forms="forms"
    :folders="app?.folders"
    :selected-id="selected?.id"
    :can-create="!!app"
    @select="openForm"
    @create="createOpen = true"
  >
    <template #navigationFooter>
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
    </template>
    <template v-if="selected" #actions>
      <button @click="manage('design')"><AppIcon name="edit" />编辑</button>
      <button @click="manage('data')"><AppIcon name="table" />数据管理</button>
      <FormActions
        :key="selected.id"
        :form-id="selected.id"
        :app-id="appId"
        @archive="archiveSelected"
      />
    </template>
    <template #utilities>
      <button
        class="icon-button"
        aria-label="通讯录"
        @click="router.push('/admin/organization')"
      >
        <AppIcon name="people" />
      </button>
      <button class="icon-button" aria-label="帮助" @click="helpOpen = true">
        <AppIcon name="help" :size="18" />
      </button>
      <UserMenu
        :account="session.user || undefined"
        @organization="router.push('/admin/organization')"
        @logout="logout"
      />
    </template>
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
      <button v-if="selected" class="button primary" @click="manage('design')">
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
    <template #dialogs>
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
    </template>
  </ApplicationHomeLayout>
</template>
