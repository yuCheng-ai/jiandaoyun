<script setup lang="ts">
import { computed, ref, watch } from "vue";
import SubformPermissionOptions from "./SubformPermissionOptions.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import IdentityInput from "../../../components/organization/IdentityInput.vue";
import DataFilterEditor from "./DataFilterEditor.vue";
import { copy, flattenFields } from "../../../domain/form";
import { scopeFields } from "../../../domain/relations";
import {
  memberActions,
  newAccessGroup,
  type AccessGroup,
  type FieldAccess,
  type MemberAction,
} from "../../../domain/access";
import type { FormRecord } from "../../../domain/workspace";
import { resolveIdentities } from "../../../domain/organization";
import { useWorkspaceStore } from "../../../stores/workspace";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { restoreAccessGroupDraft } from "../../../domain/accessDraftAdapters";
const props = defineProps<{
  open: boolean;
  form: FormRecord;
  group?: AccessGroup;
  parentContext: unknown;
  applyGroup: (
    group: AccessGroup,
  ) => string | undefined | Promise<string | undefined>;
}>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  local = ref<AccessGroup>(
    newAccessGroup(props.form.published?.schema || props.form.schema),
  ),
  preset = ref("read"),
  applying = ref(false),
  error = ref("");
const schema = computed(
    () => props.form.published?.schema || props.form.schema,
  ),
  fields = computed(() => flattenFields(schema.value.fields));
watch(
  () => props.open,
  (open) => {
    if (open) {
      error.value = "";
      local.value = copy(
        props.group || newAccessGroup(schema.value, preset.value),
      );
      fields.value.forEach((f) => (local.value.fields[f.id] ??= "hidden"));
    }
  },
  { immediate: true },
);
const members = computed(() =>
  resolveIdentities(store.data.organization, local.value.identities),
);
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => props.open,
    () => local.value,
    () => emit("close"),
    {
      key: () => `access-group:${props.form.id}:${props.group?.id || "new"}`,
      title: () => `权限组 · ${local.value.name || "未命名"}`,
      context: () => ({
        schema: schema.value,
        original: props.group || null,
        parent: props.parentContext,
        member: store.data.organization.currentUserId,
      }),
      restore: (value) => {
        local.value = restoreAccessGroupDraft(value, props.group?.id);
        error.value = "";
        confirmDiscard.value = false;
      },
    },
  );
async function apply() {
  if (applying.value) return;
  applying.value = true;
  error.value = "";
  try {
    const issue = await props.applyGroup(copy(local.value));
    if (issue) error.value = issue;
    else {
      markSaved();
      emit("close");
    }
  } catch {
    error.value = "应用未完成，权限组修改已保留，请重试。";
  } finally {
    applying.value = false;
  }
}
function applyPreset() {
  const next = newAccessGroup(schema.value, preset.value);
  local.value = {
    ...next,
    id: local.value.id,
    identities: local.value.identities,
  };
}
function changeAction(key: MemberAction) {
  if (
    !["view", "create"].includes(key) &&
    local.value.actions.includes(key) &&
    !local.value.actions.includes("view")
  )
    local.value.actions.unshift("view");
  if (key === "view" && !local.value.actions.includes("view"))
    local.value.actions = local.value.actions.filter((a) => a === "create");
}
</script>
<template>
  <BaseDialog
    :open="open"
    :draft-key="draftKey"
    :busy="applying"
    :title="group ? '编辑权限组' : '新建权限组'"
    width="800px"
    @close="!applying && requestClose()"
  >
    <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
      修改尚未保存。<button class="button" @click="confirmDiscard = false">
        继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <p class="field-hint">应用后还需保存发布设置，成员权限才会生效。</p>
    <div class="access-group-editor">
      <label
        >从模板开始<select v-model="preset" @change="applyPreset">
          <option value="read">查看全部数据</option>
          <option value="create">仅添加数据</option>
          <option value="self">添加并管理本人数据</option>
          <option value="manage">管理全部数据</option>
        </select></label
      >
      <label>权限组名称<input v-model="local.name" maxlength="60" /></label>
      <div>
        <label>适用成员</label
        ><IdentityInput
          v-model="local.identities"
          kind="mixed"
          multiple
          label="选择权限组成员、部门或角色"
        />
        <p class="field-hint">部门包含下级，角色按当前在职成员动态解析。</p>
        <p class="access-member-preview">
          有效成员 {{ members.length }} 人：{{
            members.map((e) => e.name).join("、") || "尚未选择"
          }}
        </p>
      </div>
      <fieldset class="access-action-options">
        <legend>可以做什么</legend>
        <label v-for="(name, key) in memberActions" :key="key"
          ><input
            type="checkbox"
            v-model="local.actions"
            :value="key"
            @change="changeAction(key)"
          />{{ name }}</label
        >
      </fieldset>
      <label
        >可以操作哪些数据<select v-model="local.scope">
          <option value="all">全部数据</option>
          <option value="self">本人提交的数据</option>
          <option value="department">同部门成员提交的数据</option>
          <option value="custom">符合筛选条件的数据</option>
        </select></label
      >
      <p
        v-if="local.scope === 'self' || local.scope === 'department'"
        class="field-hint"
      >
        根据提交时记录的成员和部门判断；没有提交人信息的旧记录不归入本人或部门范围。
      </p>
      <DataFilterEditor
        v-if="local.scope === 'custom'"
        v-model="local.filters"
        :source-fields="
          scopeFields(schema.fields).filter((f) => !f.children.length)
        "
        :local-fields="[]"
        :allow-field-source="false"
        source-placeholder="选择记录字段"
        hint="同时满足以下条件；当前成员随实际访问身份变化。"
      />
      <div>
        <h3>已有记录的字段权限</h3>
        <p class="field-hint">
          新记录填写遵循表单设计和流程发起节点权限。未配置的新字段默认不可见；容器权限同时约束子字段。
        </p>
        <div class="access-field-table">
          <table class="forms-table">
            <thead>
              <tr>
                <th>字段</th>
                <th>访问权限</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in fields" :key="field.id">
                <td>
                  {{ field.label
                  }}<small v-if="field.children.length"> · 容器</small>
                </td>
                <td>
                  <select
                    :value="local.fields[field.id] || 'hidden'"
                    @change="
                      local.fields[field.id] = (
                        $event.target as HTMLSelectElement
                      ).value as FieldAccess
                    "
                    :aria-label="`${field.label}权限`"
                  >
                    <option value="hidden">不可见</option>
                    <option value="read">只读</option>
                    <option value="edit">可编辑</option>
                  </select>
                  <SubformPermissionOptions
                    v-if="field.type === 'subform'"
                    :label="`${field.label}操作权限`"
                    :model-value="local.subformPermissions?.[field.id]"
                    :disabled="
                      local.fields[field.id] !== 'edit' ||
                      !local.actions.includes('edit')
                    "
                    @update:model-value="
                      local.subformPermissions = {
                        ...local.subformPermissions,
                        [field.id]: $event,
                      }
                    "
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <template #footer
      ><button class="button" :disabled="applying" @click="requestClose">
        取消</button
      ><button class="button primary" :disabled="applying" @click="apply">
        应用到设置
      </button></template
    >
  </BaseDialog>
</template>
