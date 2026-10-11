<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AdminLayout from "./AdminLayout.vue";
import RoleGrantEditor from "./RoleGrantEditor.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import IdentityInput from "../../components/organization/IdentityInput.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { copy, uid } from "../../domain/form";
import { useOrganizationDraft } from "../../composables/useOrganizationDraft";
import {
  restoreRoleDraft,
  restoreRoleGroupDraft,
} from "../../domain/organizationDraftAdapters";
import {
  identityLabel,
  roleMembers,
  type OrganizationRole,
} from "../../domain/organization";
const store = useWorkspaceStore(),
  router = useRouter();
const org = computed(() => store.data.organization);
const query = ref(""),
  memberQuery = ref(""),
  selectedId = ref(org.value.roles.find((r) => !r.archived)?.id || ""),
  showArchived = ref(false),
  modal = ref(""),
  editTab = ref("basic"),
  groupName = ref(""),
  groupId = ref("");
const role = computed(() =>
  org.value.roles.find((r) => r.id === selectedId.value),
);
const roleDraft = ref<OrganizationRole>({
  id: "",
  name: "",
  groupId: "",
  description: "",
  memberIds: [],
  departmentIds: [],
  includeChildren: true,
  grants: [],
  archived: false,
});
const editingId = ref("");
const {
  confirmDiscard,
  requestClose,
  discard,
  continueEditing,
  draftKey,
  busy,
  error,
  save: saveEdit,
} = useOrganizationDraft({
  active: () => !!modal.value,
  key: () => `organization:${modal.value}:${editingId.value || "new"}`,
  title: () =>
    modal.value === "group"
      ? `角色分组 · ${groupName.value || "未命名"}`
      : `角色 · ${roleDraft.value.name || "未命名"}`,
  value: () =>
    modal.value === "group"
      ? { id: groupId.value, name: groupName.value }
      : roleDraft.value,
  close: () => {
    modal.value = "";
  },
  restore(value) {
    const ids = [
      ...org.value.departments,
      ...org.value.employees,
      ...org.value.roles,
      ...org.value.roleGroups,
    ].map((item) => item.id);
    if (modal.value === "group") {
      const restored = restoreRoleGroupDraft(
        value,
        editingId.value || undefined,
        ids,
      );
      groupId.value = restored.id;
      groupName.value = restored.name;
    } else
      roleDraft.value = restoreRoleDraft(
        value,
        editingId.value || undefined,
        ids,
      );
  },
});
const members = computed(() =>
  role.value
    ? roleMembers(org.value, role.value).filter((e) =>
        `${e.name} ${e.number} ${e.email}`
          .toLowerCase()
          .includes(memberQuery.value.trim().toLowerCase()),
      )
    : [],
);
const roleList = computed(() =>
  org.value.roles.filter(
    (r) => r.archived === showArchived.value && r.name.includes(query.value),
  ),
);
watch(showArchived, () => (selectedId.value = roleList.value[0]?.id || ""));
watch(roleList, (list) => {
  if (!list.some((item) => item.id === selectedId.value))
    selectedId.value = list[0]?.id || "";
});
function openRole(item?: OrganizationRole, tab = "basic") {
  editingId.value = item?.id || "";
  roleDraft.value = item
    ? copy(item)
    : {
        id: uid("role"),
        name: "",
        groupId: org.value.roleGroups[0]?.id || "",
        description: "",
        memberIds: [],
        departmentIds: [],
        includeChildren: true,
        grants: [],
        archived: false,
      };
  editTab.value = tab;
  modal.value = "role";
}
async function saveRole() {
  await saveEdit(
    (context) => store.saveRole(roleDraft.value, context),
    () => {
      selectedId.value = roleDraft.value.id;
      showArchived.value = roleDraft.value.archived;
      store.notify("角色配置已保存");
    },
  );
}
function group(id = "") {
  editingId.value = id;
  groupId.value = id || uid("roleGroup");
  groupName.value = org.value.roleGroups.find((g) => g.id === id)?.name || "";
  modal.value = "group";
}
async function saveGroup() {
  await saveEdit(
    (context) => store.saveRoleGroup(groupName.value, groupId.value, context),
    () => {
      store.notify("角色分组已保存");
    },
  );
}
async function archive() {
  if (
    role.value &&
    (await store.archiveRole(role.value.id, !role.value.archived))
  ) {
    selectedId.value = roleList.value[0]?.id || "";
    store.notify(showArchived.value ? "角色已恢复" : "角色已归档");
  }
}
async function removeGroup() {
  await saveEdit(
    (context) => store.removeRoleGroup(editingId.value, context),
    () => store.notify("空分组已删除"),
  );
}
</script>
<template>
  <AdminLayout active="roles"
    ><div class="organization-management">
      <aside class="organization-sidebar">
        <div class="segmented-control organization-tabs">
          <button @click="router.push('/admin/organization')">部门</button
          ><button class="active">角色</button>
        </div>
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="query"
            placeholder="搜索角色"
            aria-label="搜索角色"
          />
        </div>
        <div class="sidebar-group-title">
          <span>{{ showArchived ? "归档角色" : "创建的角色" }}</span
          ><button
            class="icon-button"
            aria-label="新建角色"
            @click="openRole()"
          >
            <AppIcon name="add" />
          </button>
        </div>
        <div class="organization-tree-scroll">
          <div v-for="item in org.roleGroups" :key="item.id" class="role-group">
            <div class="role-group-heading">
              <AppIcon name="folder" /><span>{{ item.name }}</span
              ><button
                class="icon-button"
                :aria-label="`编辑分组${item.name}`"
                @click="group(item.id)"
              >
                <AppIcon name="edit" :size="13" />
              </button>
            </div>
            <button
              v-for="r in roleList.filter((r) => r.groupId === item.id)"
              :key="r.id"
              class="organization-nav-row"
              :class="{ active: selectedId === r.id }"
              @click="selectedId = r.id"
            >
              <AppIcon name="people" />{{ r.name
              }}<span>{{ roleMembers(org, r).length }}</span>
            </button>
          </div>
          <p v-if="!roleList.length" class="picker-empty">暂无角色</p>
        </div>
        <div class="role-sidebar-actions">
          <button class="text-button" @click="group()">
            <AppIcon name="add" />新建分组</button
          ><button class="text-button" @click="showArchived = !showArchived">
            {{ showArchived ? "返回角色" : "归档角色" }}
          </button>
        </div>
      </aside>
      <section v-if="role" class="organization-main">
        <header class="organization-title">
          <h2>
            {{ role.name
            }}<span v-if="role.archived" class="status-tag">已归档</span>
          </h2>
          <button class="text-button" @click="openRole(role)">
            修改名称 / 分组</button
          ><button class="text-button" @click="archive">
            {{ role.archived ? "恢复角色" : "归档角色" }}
          </button>
        </header>
        <div class="organization-toolbar">
          <button class="button primary" @click="openRole(role, 'members')">
            <AppIcon name="add" />配置成员</button
          ><button class="button" @click="openRole(role, 'permissions')">
            权限配置
          </button>
          <div class="toolbar-spacer" />
          <div class="search-input">
            <AppIcon name="search" /><input
              v-model="memberQuery"
              aria-label="搜索角色成员"
              placeholder="搜索角色成员"
            />
          </div>
        </div>
        <div class="role-description">
          <p>{{ role.description || "暂无角色说明" }}</p>
          <span
            >直接分配 {{ role.memberIds.length }} 人 · 关联
            {{ role.departmentIds.length }} 个部门 ·
            {{ role.grants.length }} 条授权</span
          >
        </div>
        <div class="organization-table-scroll">
          <table class="organization-table">
            <thead>
              <tr>
                <th>姓名 / 工号</th>
                <th>所属部门</th>
                <th>邮箱</th>
                <th>加入方式</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in members" :key="e.id">
                <td>
                  <div class="employee-name">
                    <span class="person-avatar">{{ e.name.slice(0, 1) }}</span
                    ><span
                      >{{ e.name }}<small>{{ e.number }}</small></span
                    >
                  </div>
                </td>
                <td>
                  {{
                    e.departmentIds
                      .map((id) => identityLabel(org, id))
                      .join("、")
                  }}
                </td>
                <td>{{ e.email || "—" }}</td>
                <td>
                  <span class="role-tag">{{
                    role.memberIds.includes(e.id) ? "直接分配" : "通过部门加入"
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!members.length" class="workspace-empty">
            <AppIcon name="people" :size="42" />
            <p>
              {{
                role.archived
                  ? "归档角色不再参与人员选择和权限计算"
                  : "暂无符合条件的角色成员"
              }}
            </p>
            <button
              v-if="!role.archived"
              class="button"
              @click="openRole(role, 'members')"
            >
              配置成员
            </button>
          </div>
        </div>
        <footer class="organization-pagination">
          共 {{ members.length }} 位在职成员
        </footer>
      </section>
      <section v-else class="organization-main workspace-empty">
        <AppIcon name="people" :size="42" />
        <h3>选择或创建一个角色</h3>
        <button class="button primary" @click="openRole()">新建角色</button>
      </section>
    </div>
    <BaseDialog
      :open="!!modal"
      :draft-key="draftKey"
      :busy="busy"
      :title="modal === 'group' ? '角色分组' : '角色配置'"
      :width="modal === 'role' ? '720px' : '460px'"
      @close="requestClose"
      ><div v-if="confirmDiscard" class="config-discard" tabindex="-1">
        修改尚未保存。<button class="button" @click="continueEditing">
          继续编辑</button
        ><button class="button" @click="discard">放弃修改</button>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <template v-if="modal === 'group'"
        ><div class="form-group">
          <label>分组名称</label
          ><input
            v-model="groupName"
            aria-label="角色分组名称"
            maxlength="40"
          />
        </div>
        <button
          v-if="editingId"
          class="text-button danger-text"
          @click="removeGroup"
        >
          删除空分组
        </button></template
      ><template v-else
        ><div class="admin-dialog-tabs">
          <button
            v-for="item in [
              { id: 'basic', label: '基本信息' },
              { id: 'members', label: '角色成员' },
              { id: 'permissions', label: '权限配置' },
            ]"
            :key="item.id"
            :class="{ active: editTab === item.id }"
            @click="editTab = item.id"
          >
            {{ item.label }}
          </button>
        </div>
        <div v-if="editTab === 'basic'" class="role-basic-form">
          <div class="form-group">
            <label>角色名称 <span class="required">*</span></label
            ><input
              v-model="roleDraft.name"
              aria-label="角色名称"
              maxlength="40"
            />
          </div>
          <div class="form-group">
            <label>所属分组</label
            ><select v-model="roleDraft.groupId" aria-label="角色所属分组">
              <option v-for="g in org.roleGroups" :key="g.id" :value="g.id">
                {{ g.name }}
              </option>
            </select>
          </div>
          <div class="form-group">
            <label>说明</label
            ><textarea
              v-model="roleDraft.description"
              aria-label="角色说明"
              rows="3"
            />
          </div>
        </div>
        <div v-else-if="editTab === 'members'">
          <div class="form-group">
            <label>直接添加成员</label
            ><IdentityInput
              v-model="roleDraft.memberIds"
              multiple
              label="选择角色成员"
            />
          </div>
          <div class="form-group">
            <label>通过部门加入</label
            ><IdentityInput
              v-model="roleDraft.departmentIds"
              kind="department"
              multiple
              label="选择角色部门"
            />
          </div>
          <label class="checkbox-line"
            ><input
              v-model="roleDraft.includeChildren"
              type="checkbox"
            />包含下级部门</label
          >
          <p class="field-hint">
            部门新增、调动、停用和离职会自动更新角色中的在职成员。
          </p>
        </div>
        <RoleGrantEditor v-else v-model="roleDraft.grants" /></template
      ><template #footer
        ><button class="button" :disabled="busy" @click="requestClose">
          取消</button
        ><button
          class="button primary"
          :disabled="busy"
          @click="modal === 'group' ? saveGroup() : saveRole()"
        >
          保存
        </button></template
      ></BaseDialog
    ></AdminLayout
  >
</template>
