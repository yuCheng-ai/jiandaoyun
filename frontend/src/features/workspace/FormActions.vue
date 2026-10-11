<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
const props = defineProps<{ formId: string; appId: string }>();
const emit = defineEmits<{ archive: [] }>();
const store = useWorkspaceStore(),
  router = useRouter();
const form = computed(() =>
  store.activeForms.find(
    (item) => item.id === props.formId && item.appId === props.appId,
  ),
);
const folders = computed(
  () => store.data.apps.find((item) => item.id === props.appId)?.folders || [],
);
const dialog = ref(""),
  name = ref(""),
  folder = ref("");
function edit(kind: string) {
  name.value = form.value?.title || "";
  folder.value = form.value?.folder || "";
  dialog.value = kind;
}
async function save() {
  if (!form.value || store.writePending) return;
  const ok =
    dialog.value === "rename"
      ? name.value.trim() &&
        (await store.renameForm(props.formId, name.value.trim()))
      : await store.updateFormMetadata(props.formId, { folder: folder.value });
  if (ok) dialog.value = "";
}
async function duplicate() {
  if (store.writePending) return;
  const copy = await store.duplicateForm(props.formId);
  if (copy) {
    dialog.value = "";
    store.notify(`已创建「${copy.title}」`);
  }
}
function navigate(section: string) {
  dialog.value = "";
  void router.push(`/apps/${props.appId}/forms/${props.formId}/${section}`);
}
function archive() {
  dialog.value = "";
  emit("archive");
}
</script>
<template>
  <button
    class="icon-button"
    aria-label="更多表单操作"
    title="更多表单操作"
    @click="dialog = 'actions'"
  >
    <AppIcon name="more" />
  </button>
  <BaseDialog
    :open="!!dialog"
    :busy="store.writePending"
    :title="
      dialog === 'rename'
        ? '重命名表单'
        : dialog === 'move'
          ? '移动到分组'
          : dialog === 'archive'
            ? '移入回收站'
            : form?.title || '表单操作'
    "
    width="380px"
    @close="dialog = ''"
  >
    <div v-if="dialog === 'actions'" class="application-form-menu">
      <button @click="edit('rename')"><AppIcon name="edit" />重命名</button>
      <button @click="duplicate"><AppIcon name="copy" />复制表单</button>
      <button @click="edit('move')"><AppIcon name="folder" />移动到分组</button>
      <button @click="navigate('flow')">
        <AppIcon name="condition" />流程设定
      </button>
      <button @click="navigate('publish')">
        <AppIcon name="launch" />表单发布
      </button>
      <button class="danger" @click="dialog = 'archive'">
        <AppIcon name="trash" />移入回收站
      </button>
    </div>
    <div v-else-if="dialog === 'rename'" class="form-group">
      <label for="rename-form">表单名称</label>
      <input
        id="rename-form"
        v-model="name"
        maxlength="60"
        @keydown.enter="save"
      />
    </div>
    <div v-else-if="dialog === 'move'" class="form-group">
      <label for="move-form">所在分组</label>
      <select id="move-form" v-model="folder">
        <option value="">未分组</option>
        <option v-for="item in folders" :key="item">{{ item }}</option>
      </select>
    </div>
    <p v-else>
      将「{{ form?.title }}」移入回收站？表单和已保存的数据可以恢复。
    </p>
    <template v-if="dialog !== 'actions'" #footer>
      <button class="button" @click="dialog = ''">取消</button>
      <button
        class="button primary"
        :disabled="dialog === 'rename' && !name.trim()"
        @click="dialog === 'archive' ? archive() : save()"
      >
        确定
      </button>
    </template>
  </BaseDialog>
</template>
<style scoped>
.application-form-menu {
  display: grid;
  gap: 4px;
}
.application-form-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  text-align: left;
  border-radius: 4px;
}
.application-form-menu button:hover {
  background: #f0f7f7;
}
</style>
