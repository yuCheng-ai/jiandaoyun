<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
const props = defineProps<{ open: boolean; appId: string; folder?: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  router = useRouter();
const app = computed(() =>
  store.data.apps.find((item) => item.id === props.appId),
);
const name = ref(""),
  kind = ref<"form" | "workflow">("form"),
  folder = ref("");
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    name.value = "";
    kind.value = "form";
    folder.value = props.folder ?? "";
  },
);
async function create() {
  if (!name.value.trim() || store.writePending) return;
  const form = await store.createForm(
    props.appId,
    name.value.trim(),
    kind.value,
    folder.value,
  );
  if (!form) return;
  emit("close");
  void router.push(`/apps/${props.appId}/forms/${form.id}/design`);
}
</script>
<template>
  <BaseDialog
    :open="open"
    :busy="store.writePending"
    title="新建表单"
    @close="emit('close')"
  >
    <div class="form-group">
      <label for="create-form-name">表单名称</label>
      <input
        id="create-form-name"
        v-model="name"
        maxlength="60"
        placeholder="请输入名称"
        @keydown.enter="create"
      />
    </div>
    <div class="form-kind-options">
      <button
        v-for="item in [
          {
            id: 'form',
            label: '普通表单',
            desc: '收集、整理和管理业务数据',
            icon: 'form',
          },
          {
            id: 'workflow',
            label: '流程表单',
            desc: '填写表单，按流程发起审批',
            icon: 'condition',
          },
        ]"
        :key="item.id"
        :class="{ selected: kind === item.id }"
        @click="kind = item.id as 'form' | 'workflow'"
      >
        <AppIcon :name="item.icon" :size="26" /><strong>{{ item.label }}</strong
        ><small>{{ item.desc }}</small>
        <AppIcon v-if="kind === item.id" name="success" class="kind-check" />
      </button>
    </div>
    <div class="form-group">
      <label for="create-form-folder">所在分组</label>
      <div class="select-wrap">
        <select id="create-form-folder" v-model="folder">
          <option value="">未分组</option>
          <option v-for="item in app?.folders" :key="item">
            {{ item }}
          </option></select
        ><AppIcon name="down" />
      </div>
    </div>
    <template #footer>
      <button class="button" @click="emit('close')">取消</button>
      <button
        class="button primary"
        :disabled="!name.trim() || store.writePending"
        @click="create"
      >
        创建
      </button>
    </template>
  </BaseDialog>
</template>
