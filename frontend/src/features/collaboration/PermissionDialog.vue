<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import {
  organizationSubjectMembers,
  type MemberGrant,
  type AccessPolicy,
  type ServerDefinition,
  type RelationDefinition,
  type ServerOrganization,
  type SubjectGrant,
} from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import RecordGroupDialog from "./RecordGroupDialog.vue";
import type { RecordGroupConfiguration } from "@platform/contracts";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";
const props = defineProps<{ definition: ServerDefinition }>();
const emit = defineEmits<{ close: [] }>();
const showGroups = ref(false),
  groupMode = ref(false);
const emptyPolicy = (): AccessPolicy => ({
  read: false,
  create: false,
  edit: false,
  remove: false,
  scope: "all",
  fields: {},
  relations: {},
});
const policies = ref<MemberGrant[]>([]);
const subjectPolicies = ref<SubjectGrant[]>([]),
  organization = ref<ServerOrganization>();
const kind = ref<"member" | "department" | "role">("member"),
  selectedId = ref("");
const serialized = () =>
  JSON.stringify([policies.value, subjectPolicies.value]);
const original = ref(serialized()),
  dirty = computed(() => serialized() !== original.value);
const subjectPolicy = computed(() =>
  subjectPolicies.value.find(
    (item) =>
      item.subject.kind === kind.value && item.subject.id === selectedId.value,
  ),
);
const policy = computed(() =>
  kind.value === "member"
    ? policies.value.find((item) => item.userId === selectedId.value)
    : subjectPolicy.value?.policy,
);
const choices = computed(() =>
  kind.value === "member"
    ? (organization.value?.users || []).filter(
        (user) => user.active && user.role !== "admin",
      )
    : (kind.value === "department"
        ? organization.value?.spec.departments
        : organization.value?.spec.roles
      )?.filter((item) => !item.archived) || [],
);
function changeKind() {
  selectedId.value = choices.value[0]?.id || "";
}
const affectedMembers = computed(() => {
  if (kind.value === "member")
    return (organization.value?.users || []).filter(
      (user) => user.id === selectedId.value,
    );
  if (!organization.value || !subjectPolicy.value) return [];
  const ids = new Set(
    organizationSubjectMembers(
      organization.value.spec,
      subjectPolicy.value.subject,
    ),
  );
  return organization.value.users.filter(
    (user) => user.active && ids.has(user.id),
  );
});
const fields = computed(() =>
  props.definition.schema.fields.flatMap((field) => [
    { field, label: field.label },
    ...field.children.map((child) => ({
      field: child,
      label: `${field.label} / ${child.label}`,
    })),
  ]),
);
const busy = ref(false),
  loaded = ref(false),
  error = ref(""),
  relations = ref<RelationDefinition[]>([]),
  relationError = ref("");
const conflict = ref(false),
  reloadConfirm = ref(false),
  savedPolicy = ref("");
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(
  () => true,
  () => [policies.value, subjectPolicies.value],
  () => emit("close"),
);
async function loadRelations() {
  try {
    relations.value = (
      await platformApi<RelationDefinition[]>(
        `/relations?definitionId=${props.definition.id}`,
      )
    ).filter(
      (item) =>
        item.latestVersion &&
        item.spec.sourceDefinitionId === props.definition.id,
    );
    relationError.value = "";
  } catch (cause) {
    relationError.value = (cause as Error).message;
  }
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  loaded.value = false;
  error.value = "";
  savedPolicy.value = "";
  try {
    const [org, grants, directGrants, groupConfig] = await Promise.all([
      platformApi<ServerOrganization>("/organization"),
      platformApi<SubjectGrant[]>(
        `/definitions/${props.definition.id}/subject-grants`,
      ),
      platformApi<MemberGrant[]>(`/definitions/${props.definition.id}/grants`),
      platformApi<RecordGroupConfiguration>(
        `/definitions/${props.definition.id}/permission-groups`,
      ),
    ]);
    groupMode.value = groupConfig?.mode === "groups";
    organization.value = org;
    policies.value = (organization.value?.users || [])
      .filter((user) => user.role !== "admin")
      .map(
        (user) =>
          directGrants.find((grant) => grant.userId === user.id) || {
            ...emptyPolicy(),
            userId: user.id,
            revision: 0,
          },
      );
    subjectPolicies.value = [
      ...org.spec.departments.map((item) => ({
        kind: "department" as const,
        id: item.id,
        includeChildren: false,
      })),
      ...org.spec.roles.map((item) => ({ kind: "role" as const, id: item.id })),
    ].map(
      (subject) =>
        grants.find(
          (item) =>
            item.subject.kind === subject.kind &&
            item.subject.id === subject.id,
        ) || { subject, policy: emptyPolicy(), revision: 0 },
    );
    if (!choices.value.some((item) => item.id === selectedId.value))
      changeKind();
    original.value = serialized();
    markSaved();
    loaded.value = true;
    conflict.value = false;
    reloadConfirm.value = false;
    await loadRelations();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
onBeforeRouteLeave(() => {
  if (!busy.value) requestClose();
  return false;
});
async function save() {
  if (busy.value || !policy.value || !loaded.value || groupMode.value) return;
  busy.value = true;
  error.value = "";
  savedPolicy.value = "";
  conflict.value = false;
  try {
    const common = {
      ...policy.value,
      ...(!policy.value.read
        ? { create: false, edit: false, remove: false }
        : {}),
    };
    if (kind.value === "member") {
      const saved = await platformApi<MemberGrant>(
        `/definitions/${props.definition.id}/grants`,
        "PUT",
        {
          ...common,
          userId: selectedId.value,
          expectedRevision: policies.value.find(
            (item) => item.userId === selectedId.value,
          )!.revision,
        },
      );
      const index = policies.value.findIndex(
        (item) => item.userId === selectedId.value,
      );
      policies.value[index] = saved;
    } else {
      const saved = await platformApi<SubjectGrant>(
        `/definitions/${props.definition.id}/subject-grants`,
        "PUT",
        {
          ...common,
          subject: subjectPolicy.value!.subject,
          expectedRevision: subjectPolicy.value!.revision,
        },
      );
      const index = subjectPolicies.value.findIndex(
        (item) =>
          item.subject.kind === kind.value &&
          item.subject.id === selectedId.value,
      );
      subjectPolicies.value[index] = saved;
    }
    original.value = serialized();
    markSaved();
    savedPolicy.value = `${kind.value}:${selectedId.value}`;
  } catch (cause) {
    error.value = (cause as Error).message;
    conflict.value = cause instanceof PlatformError && cause.status === 409;
  } finally {
    busy.value = false;
  }
}
async function groupsSaved() {
  showGroups.value = false;
  savedPolicy.value = "";
  await load();
}
</script>
<template>
  <BaseDialog
    :open="true"
    title="成员、部门与角色权限"
    width="640px"
    :busy="busy"
    @close="requestClose"
  >
    <div class="collab-toolbar">
      <span>{{
        groupMode ? "当前按权限组授权" : "当前按成员、部门和角色授权"
      }}</span
      ><button
        class="button"
        :disabled="busy || !loaded || dirty"
        @click="showGroups = true"
      >
        权限组管理
      </button>
    </div>
    <p v-if="groupMode" class="collab-notice">
      此表单已启用权限组。下方显示保留的原授权，可在权限组管理中切回原模式。
    </p>
    <p v-else class="collab-help">
      权限由服务端执行。成员、部门和角色的有效授权叠加；本项“不授予”不会撤销其他来源的授权。每项授权先按记录范围及父级明细限制计算，再合并字段权限。
    </p>
    <div v-if="error" class="collab-error" role="alert">
      {{ error }}
      <button v-if="conflict" class="text-button" @click="reloadConfirm = true">
        重新读取授权
      </button>
    </div>
    <div v-if="reloadConfirm" class="collab-notice">
      重新读取会替换当前未保存的权限修改。<button
        class="button"
        @click="reloadConfirm = false"
      >
        继续编辑</button
      ><button class="button" @click="load">放弃修改并读取</button>
    </div>
    <div
      v-if="confirmDiscard"
      class="config-discard collab-notice"
      tabindex="-1"
    >
      有未保存的权限修改。<button
        class="button"
        @click="confirmDiscard = false"
      >
        继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <button v-if="!loaded && !busy" class="button" @click="load">
      重新读取组织配置
    </button>
    <fieldset
      :disabled="groupMode || busy || !loaded"
      class="permission-fields"
    >
      <div v-if="loaded" class="permission-subjects">
        <label class="collab-field"
          >授权给<select v-model="kind" :disabled="dirty" @change="changeKind">
            <option value="member">指定成员</option>
            <option value="department">部门成员</option>
            <option value="role">角色成员</option>
          </select></label
        >
        <label class="collab-field"
          >{{
            kind === "member"
              ? "选择成员"
              : kind === "department"
                ? "选择部门"
                : "选择角色"
          }}<select
            v-model="selectedId"
            :disabled="dirty"
            aria-label="选择授权对象"
          >
            <option v-if="!choices.length" value="">
              请先在组织与成员中配置
            </option>
            <option
              v-for="choice in choices"
              :key="choice.id"
              :value="choice.id"
            >
              {{ choice.name }}
            </option>
          </select></label
        >
      </div>
      <p v-if="dirty" class="collab-help">
        保存或取消当前修改后，再切换授权对象。
      </p>
      <label v-if="kind === 'department' && subjectPolicy" class="checkbox-line"
        ><input
          v-model="subjectPolicy.subject.includeChildren"
          type="checkbox"
        />包括下级部门成员</label
      >
      <p v-if="loaded && selectedId" class="collab-help">
        当前适用：{{
          affectedMembers.map((user) => user.name).join("、") || "暂无成员"
        }}。成员调动或角色成员变化后，授权按当前组织关系生效。
      </p>
      <template v-if="loaded && policy">
        <div class="collab-toolbar">
          <label><input v-model="policy.read" type="checkbox" /> 允许访问</label
          ><label
            ><input
              v-model="policy.create"
              type="checkbox"
              :disabled="!policy.read"
            />
            新增</label
          ><label
            ><input
              v-model="policy.edit"
              type="checkbox"
              :disabled="!policy.read"
            />
            修改</label
          >
        </div>
        <label class="collab-field"
          >记录范围<select v-model="policy.scope">
            <option value="all">所有记录</option>
            <option value="self">本人创建的记录</option>
            <option value="department">按部门范围查看记录</option>
          </select></label
        >
        <template v-if="policy.scope === 'department'">
          <label class="collab-field"
            >部门范围依据<select
              :value="policy.departmentBasis || 'creator-current'"
              @change="
                policy.departmentBasis = ($event.target as HTMLSelectElement)
                  .value as 'creator-current' | 'record-created'
              "
            >
              <option value="creator-current">创建人现在所在的部门</option>
              <option value="record-created">记录创建时所属的部门</option>
            </select></label
          >
          <p
            v-if="policy.departmentBasis === 'record-created'"
            class="collab-help"
          >
            记录的创建部门与查看人当前所属部门直接匹配，包括兼职部门，不自动包含下级部门。创建人调动不改变旧记录归属；未留存创建部门的旧记录不会据此授权。
          </p>
          <p v-else class="collab-help">
            按处理人及记录创建人的当前部门归属计算，包含兼职部门和下级部门；调动后可见记录范围随之变化。
          </p>
        </template>
        <table class="collab-table">
          <thead>
            <tr>
              <th>字段 / 子表列</th>
              <th>权限</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in fields" :key="item.field.id">
              <td>{{ item.label }}</td>
              <td>
                <select
                  :aria-label="`${item.label}权限`"
                  :value="policy.fields[item.field.id] || 'hidden'"
                  @change="
                    policy.fields[item.field.id] = (
                      $event.target as HTMLSelectElement
                    ).value as 'hidden' | 'read' | 'edit'
                  "
                >
                  <option value="hidden">不授予</option>
                  <option value="read">只读</option>
                  <option value="edit">可编辑</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="relationError" class="collab-error" role="alert">
          关系权限读取失败：{{ relationError }}
          <button class="text-button" @click="loadRelations">重试</button>
        </p>
        <template v-if="relations.length"
          ><h3>关联操作权限</h3>
          <p class="collab-help">
            关系可编辑时仍需拥有本记录、回填字段及目标数据的相应权限。未配置的新关系默认隐藏。
          </p>
          <table class="collab-table">
            <thead>
              <tr>
                <th>关系</th>
                <th>权限</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="relation in relations" :key="relation.id">
                <td>{{ relation.spec.title }}</td>
                <td>
                  <select
                    :aria-label="`${relation.spec.title}关系权限`"
                    :value="policy.relations?.[relation.id] || 'hidden'"
                    @change="
                      policy.relations = {
                        ...policy.relations,
                        [relation.id]: ($event.target as HTMLSelectElement)
                          .value as 'hidden' | 'read' | 'edit',
                      }
                    "
                  >
                    <option value="hidden">不授予</option>
                    <option value="read">查看关联</option>
                    <option value="edit">建立与解除关联</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table></template
        >
      </template>
    </fieldset>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><span
        v-if="savedPolicy === `${kind}:${selectedId}` && !dirty && !error"
        class="collab-success"
        role="status"
        >已保存</span
      ><button
        class="button primary"
        :disabled="busy || !loaded || !policy || groupMode"
        @click="save"
      >
        保存当前授权
      </button></template
    >
  </BaseDialog>
  <RecordGroupDialog
    v-if="showGroups"
    :definition="definition"
    @close="showGroups = false"
    @saved="groupsSaved"
  />
</template>
<style scoped>
.permission-subjects {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.permission-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
@media (max-width: 600px) {
  .permission-subjects {
    grid-template-columns: 1fr;
  }
}
</style>
