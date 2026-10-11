<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AdminLayout from "./AdminLayout.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import DepartmentTree from "../../components/organization/DepartmentTree.vue";
import IdentityInput from "../../components/organization/IdentityInput.vue";
import { copy, uid } from "../../domain/form";
import {
  departmentPath,
  descendants,
  identityLabel,
  newEmployee,
  rolesFor,
  type Department,
  type Employee,
  type EmployeeStatus,
} from "../../domain/organization";
import { useWorkspaceStore } from "../../stores/workspace";
import { useOrganizationDraft } from "../../composables/useOrganizationDraft";
import {
  restoreBulkOrganizationDraft,
  restoreDepartmentDraft,
  restoreEmployeeDraft,
} from "../../domain/organizationDraftAdapters";
const store = useWorkspaceStore(),
  router = useRouter(),
  route = useRoute();
const org = computed(() => store.data.organization);
const departmentId = ref(""),
  treeQuery = ref(""),
  query = ref(""),
  status = ref("all"),
  includeChildren = ref(true),
  selectedIds = ref<string[]>([]),
  page = ref(1),
  pageSize = ref(20);
const modal = ref(""),
  employee = ref<Employee>(newEmployee()),
  employeeRoleIds = ref<string[]>([]),
  department = ref<Department>({
    id: "",
    name: "",
    parentId: null,
    managerIds: [],
    archived: false,
  }),
  bulkValue = ref("");
const editingId = ref(""),
  bulkIds = ref<string[]>([]);
let restoringEmployee = false;
const editable = () => !!modal.value && modal.value !== "archived";
const {
  confirmDiscard,
  requestClose: closeEdit,
  discard,
  continueEditing,
  draftKey,
  busy,
  error,
  save: saveEdit,
} = useOrganizationDraft({
  active: editable,
  key: () =>
    `organization:${modal.value}:${modal.value.startsWith("bulk-") ? [...bulkIds.value].sort().join(",") : editingId.value || "new"}`,
  title: () =>
    modal.value === "employee"
      ? `成员 · ${employee.value.name || "未命名"}`
      : modal.value === "department"
        ? `部门 · ${department.value.name || "未命名"}`
        : "成员批量修改",
  value: () =>
    modal.value === "employee"
      ? { employee: employee.value, roleIds: employeeRoleIds.value }
      : modal.value === "department"
        ? department.value
        : { ids: bulkIds.value, value: bulkValue.value },
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
    if (modal.value === "employee") {
      const restored = restoreEmployeeDraft(
        value,
        editingId.value || undefined,
        ids,
      );
      restoringEmployee = true;
      employee.value = restored.employee;
      employeeRoleIds.value = restored.roleIds;
      nextTick(() => {
        restoringEmployee = false;
      });
    } else if (modal.value === "department")
      department.value = restoreDepartmentDraft(
        value,
        editingId.value || undefined,
        ids,
      );
    else bulkValue.value = restoreBulkOrganizationDraft(value, bulkIds.value);
  },
});
function requestClose() {
  if (modal.value === "archived") modal.value = "";
  else closeEdit();
}
const heading = computed(() =>
  status.value === "left"
    ? "离职成员"
    : departmentId.value
      ? identityLabel(org.value, departmentId.value)
      : "全部成员",
);
const employees = computed(() => {
  const deps = departmentId.value
    ? new Set(
        includeChildren.value
          ? descendants(org.value, departmentId.value)
          : [departmentId.value],
      )
    : null;
  const q = query.value.trim().toLowerCase();
  return org.value.employees.filter(
    (e) =>
      (status.value === "all"
        ? e.status !== "left"
        : e.status === status.value) &&
      (!deps || e.departmentIds.some((id) => deps.has(id))) &&
      (!q ||
        `${e.name} ${e.number} ${e.email} ${e.phone}`
          .toLowerCase()
          .includes(q)),
  );
});
const pageCount = computed(() =>
  Math.max(1, Math.ceil(employees.value.length / pageSize.value)),
);
const pageRows = computed(() =>
  employees.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);
watch([query, status, departmentId, includeChildren, pageSize], () => {
  page.value = 1;
  selectedIds.value = [];
});
watch(pageCount, (n) => (page.value = Math.min(page.value, n)));
const allSelected = computed(
  () =>
    pageRows.value.length > 0 &&
    pageRows.value.every((e) => selectedIds.value.includes(e.id)),
);
function selectAll() {
  const ids = pageRows.value.map((e) => e.id);
  selectedIds.value = allSelected.value
    ? selectedIds.value.filter((id) => !ids.includes(id))
    : [...new Set([...selectedIds.value, ...ids])];
}
function openEmployee(item?: Employee) {
  editingId.value = item?.id || "";
  employee.value = item ? copy(item) : newEmployee();
  if (!item) {
    let n = org.value.employees.length + 1;
    while (
      org.value.employees.some(
        (e) => e.number === `E${String(n).padStart(4, "0")}`,
      )
    )
      n++;
    employee.value.number = `E${String(n).padStart(4, "0")}`;
    employee.value.departmentIds = [departmentId.value || "company"];
    employee.value.primaryDepartmentId = employee.value.departmentIds[0]!;
  }
  employeeRoleIds.value = org.value.roles
    .filter((r) => r.memberIds.includes(employee.value.id))
    .map((r) => r.id);
  modal.value = "employee";
}
watch(
  () => employee.value.departmentIds,
  (ids) => {
    if (restoringEmployee) return;
    if (!ids.includes(employee.value.primaryDepartmentId))
      employee.value.primaryDepartmentId = ids[0] || "";
  },
  { deep: true },
);
async function saveEmployee() {
  await saveEdit(
    (context) =>
      store.saveEmployee(employee.value, employeeRoleIds.value, context),
    () => {
      store.notify("成员信息已保存");
    },
  );
}
function openDepartment(item?: Department) {
  editingId.value = item?.id || "";
  department.value = item
    ? copy(item)
    : {
        id: uid("department"),
        name: "",
        parentId: departmentId.value || "company",
        managerIds: [],
        archived: false,
      };
  modal.value = "department";
}
async function saveDepartment() {
  await saveEdit(
    (context) => store.saveDepartment(department.value, context),
    () => {
      departmentId.value = department.value.id;
      store.notify("部门已保存");
    },
  );
}
async function archiveDepartment() {
  if (
    departmentId.value &&
    (await store.archiveDepartment(departmentId.value))
  ) {
    departmentId.value = "";
    store.notify("部门已归档，可在归档部门中恢复");
  }
}
function bulk(mode: string) {
  bulkIds.value = [...selectedIds.value];
  bulkValue.value = mode === "status" ? "inactive" : "";
  modal.value = "bulk-" + mode;
}
async function saveBulk() {
  await saveEdit(
    (context) =>
      store.bulkEmployees(
        bulkIds.value,
        modal.value === "bulk-department"
          ? { departmentId: bulkValue.value }
          : modal.value === "bulk-role"
            ? { roleId: bulkValue.value }
            : { status: bulkValue.value as EmployeeStatus },
        context,
      ),
    () => {
      selectedIds.value = [];
      store.notify("批量操作已保存");
    },
  );
}
function download() {
  const cell = (v: string) =>
    '"' + v.replaceAll('"', '""').replace(/^[=+@-]/, "'$&") + '"';
  const rows = [
    ["姓名", "工号", "手机", "邮箱", "部门", "职务", "状态"],
    ...employees.value.map((e) => [
      e.name,
      e.number,
      e.phone,
      e.email,
      e.departmentIds.map((id) => departmentPath(org.value, id)).join("；"),
      e.position,
      { active: "在职", inactive: "停用", left: "离职" }[e.status],
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "内部成员.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <AdminLayout
    :active="route.path.endsWith('members') ? 'members' : 'organization'"
    ><div class="organization-management">
      <aside class="organization-sidebar">
        <div class="segmented-control organization-tabs">
          <button class="active">部门</button
          ><button @click="router.push('/admin/roles')">角色</button>
        </div>
        <small class="sidebar-group-title">成员</small
        ><button
          class="organization-nav-row"
          :class="{ active: !departmentId && status !== 'left' }"
          @click="
            departmentId = '';
            status = 'all';
          "
        >
          <AppIcon name="approval" />全部成员<span>{{
            org.employees.filter((e) => e.status !== "left").length
          }}</span></button
        ><button
          class="organization-nav-row"
          :class="{ active: status === 'left' }"
          @click="
            departmentId = '';
            status = 'left';
          "
        >
          <AppIcon name="people" />离职成员<span>{{
            org.employees.filter((e) => e.status === "left").length
          }}</span>
        </button>
        <div class="sidebar-group-title">
          <span>部门</span
          ><button
            class="icon-button"
            aria-label="新建部门"
            @click="openDepartment()"
          >
            <AppIcon name="add" />
          </button>
        </div>
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="treeQuery"
            placeholder="搜索部门"
            aria-label="搜索部门树"
          />
        </div>
        <div class="organization-tree-scroll">
          <DepartmentTree
            :departments="org.departments"
            :selected-id="departmentId"
            :query="treeQuery"
            @select="
              departmentId = $event;
              status = 'all';
            "
          />
        </div>
        <button
          class="text-button archived-departments"
          @click="modal = 'archived'"
        >
          <AppIcon name="archive" />归档部门
        </button>
      </aside>
      <section class="organization-main">
        <header class="organization-title">
          <h2>{{ heading }}</h2>
          <template v-if="departmentId"
            ><button
              class="text-button"
              @click="
                openDepartment(
                  org.departments.find((d) => d.id === departmentId),
                )
              "
            >
              编辑部门</button
            ><button class="text-button" @click="archiveDepartment">
              归档部门
            </button></template
          >
        </header>
        <div class="organization-toolbar">
          <button class="button primary" @click="openEmployee()">
            <AppIcon name="add" />添加成员</button
          ><button class="button" @click="download">导出</button>
          <div class="toolbar-spacer" />
          <div class="search-input">
            <AppIcon name="search" /><input
              v-model="query"
              aria-label="搜索内部成员"
              placeholder="搜索姓名、工号、手机或邮箱"
            />
          </div>
          <label class="inline-select-label"
            >账号状态<select v-model="status" aria-label="账号状态">
              <option value="all">全部</option>
              <option value="active">在职</option>
              <option value="inactive">停用</option>
              <option value="left">离职</option>
            </select></label
          >
        </div>
        <div v-if="departmentId" class="department-summary">
          <label
            ><input
              v-model="includeChildren"
              type="checkbox"
            />包含下级部门</label
          ><span
            >负责人：{{
              org.departments
                .find((d) => d.id === departmentId)
                ?.managerIds.map((id) => identityLabel(org, id))
                .join("、") || "未设置"
            }}</span
          >
        </div>
        <div v-if="selectedIds.length" class="bulk-action-bar">
          <span>已选择 {{ selectedIds.length }} 位成员</span
          ><button @click="bulk('department')">调整部门</button
          ><button @click="bulk('role')">添加角色</button
          ><button @click="bulk('status')">修改状态</button
          ><button @click="selectedIds = []">取消选择</button>
        </div>
        <div class="organization-table-scroll">
          <table class="organization-table">
            <thead>
              <tr>
                <th class="checkbox-column">
                  <input
                    type="checkbox"
                    aria-label="选择当前页全部成员"
                    :checked="allSelected"
                    @change="selectAll"
                  />
                </th>
                <th>姓名 / 工号</th>
                <th>所属部门</th>
                <th>手机 / 邮箱</th>
                <th>角色</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in pageRows" :key="item.id">
                <td>
                  <input
                    v-model="selectedIds"
                    type="checkbox"
                    :value="item.id"
                    :aria-label="`选择成员${item.name}`"
                  />
                </td>
                <td>
                  <button class="employee-name" @click="openEmployee(item)">
                    <span class="person-avatar">{{
                      item.name.slice(0, 1)
                    }}</span
                    ><span
                      >{{ item.name
                      }}<small
                        >{{ item.number
                        }}<template v-if="item.position">
                          · {{ item.position }}</template
                        ></small
                      ></span
                    >
                  </button>
                </td>
                <td>
                  {{
                    item.departmentIds
                      .map((id) => identityLabel(org, id))
                      .join("、") || "未分配"
                  }}
                </td>
                <td>
                  {{ item.phone || "—" }}<small>{{ item.email || "—" }}</small>
                </td>
                <td>
                  <span
                    v-for="role in rolesFor(org, item.id)"
                    :key="role.id"
                    class="role-tag"
                    >{{ role.name }}</span
                  ><span v-if="!rolesFor(org, item.id).length" class="muted"
                    >—</span
                  >
                </td>
                <td>
                  <span class="employee-status" :class="item.status">{{
                    { active: "在职", inactive: "停用", left: "离职" }[
                      item.status
                    ]
                  }}</span>
                </td>
                <td>
                  <button
                    class="text-button"
                    :aria-label="`编辑${item.name}`"
                    @click="openEmployee(item)"
                  >
                    编辑
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!employees.length" class="workspace-empty">
            <AppIcon name="people" :size="42" />
            <p>暂无符合条件的成员</p>
            <button class="button" @click="openEmployee()">添加成员</button>
          </div>
        </div>
        <footer class="organization-pagination">
          <select v-model.number="pageSize" aria-label="每页成员数量">
            <option :value="10">10 条/页</option>
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option></select
          ><span>共 {{ employees.length }} 条</span>
          <div class="toolbar-spacer" />
          <button
            class="icon-button"
            :disabled="page === 1"
            aria-label="上一页"
            @click="page--"
          >
            <AppIcon name="back" /></button
          ><span>{{ page }} / {{ pageCount }}</span
          ><button
            class="icon-button"
            :disabled="page === pageCount"
            aria-label="下一页"
            @click="page++"
          >
            <AppIcon name="right" />
          </button>
        </footer>
      </section>
    </div>
    <BaseDialog
      :open="!!modal"
      :draft-key="editable() ? draftKey : undefined"
      :busy="busy"
      :title="
        modal === 'employee'
          ? '成员信息'
          : modal === 'department'
            ? '部门信息'
            : modal === 'archived'
              ? '归档部门'
              : modal === 'bulk-department'
                ? '批量调整部门'
                : modal === 'bulk-role'
                  ? '批量添加角色'
                  : '批量修改状态'
      "
      :width="modal === 'employee' ? '680px' : '520px'"
      @close="requestClose"
      ><div v-if="confirmDiscard" class="config-discard" tabindex="-1">
        修改尚未保存。<button class="button" @click="continueEditing">
          继续编辑</button
        ><button class="button" @click="discard">放弃修改</button>
      </div>
      <p v-if="error && editable()" class="field-error" role="alert">
        {{ error }}
      </p>
      <template v-if="modal === 'employee'"
        ><div class="admin-form-grid">
          <label
            >姓名 <span class="required">*</span
            ><input
              v-model="employee.name"
              aria-label="成员姓名"
              maxlength="40" /></label
          ><label
            >工号 <span class="required">*</span
            ><input
              v-model="employee.number"
              aria-label="成员工号"
              maxlength="40" /></label
          ><label
            >手机<input v-model="employee.phone" aria-label="成员手机" /></label
          ><label
            >邮箱<input
              v-model="employee.email"
              aria-label="成员邮箱"
              type="email"
          /></label>
          <div class="span-two">
            <label>所属部门 <span class="required">*</span></label
            ><IdentityInput
              v-model="employee.departmentIds"
              kind="department"
              multiple
              label="选择成员所属部门"
            />
          </div>
          <label
            >主部门<select
              v-model="employee.primaryDepartmentId"
              aria-label="成员主部门"
            >
              <option
                v-for="id in employee.departmentIds"
                :key="id"
                :value="id"
              >
                {{ departmentPath(org, id) }}
              </option>
            </select></label
          ><label
            >职务<input
              v-model="employee.position"
              aria-label="成员职务" /></label
          ><label
            >入职日期<input
              v-model="employee.joinedAt"
              type="date"
              aria-label="入职日期" /></label
          ><label
            >账号状态<select
              v-model="employee.status"
              aria-label="编辑成员状态"
            >
              <option value="active">在职</option>
              <option value="inactive">停用</option>
              <option value="left">离职</option>
            </select></label
          >
        </div>
        <h4 class="admin-form-section-title">直接分配角色</h4>
        <div class="role-checkboxes">
          <label
            v-for="role in org.roles.filter((r) => !r.archived)"
            :key="role.id"
            ><input
              v-model="employeeRoleIds"
              type="checkbox"
              :value="role.id"
            />{{ role.name }}</label
          >
        </div>
        <p class="field-hint">
          通过部门加入的角色会随所属部门自动变化。停用和离职成员保留历史记录，不能在新填写的表单中选择。
        </p></template
      ><template v-else-if="modal === 'department'"
        ><div class="form-group">
          <label>部门名称 <span class="required">*</span></label
          ><input v-model="department.name" aria-label="部门名称" />
        </div>
        <div class="form-group">
          <label>上级部门</label
          ><select v-model="department.parentId" aria-label="上级部门">
            <option :value="null">无（根部门）</option>
            <option
              v-for="d in org.departments.filter(
                (d) =>
                  !d.archived &&
                  !descendants(org, department.id).includes(d.id),
              )"
              :key="d.id"
              :value="d.id"
            >
              {{ departmentPath(org, d.id) }}
            </option>
          </select>
        </div>
        <div class="form-group">
          <label>部门负责人</label
          ><IdentityInput
            v-model="department.managerIds"
            multiple
            label="选择部门负责人"
          /></div
      ></template>
      <div v-else-if="modal === 'archived'" class="archived-list">
        <div v-for="d in org.departments.filter((d) => d.archived)" :key="d.id">
          <span>{{ departmentPath(org, d.id) }}</span
          ><button
            class="text-button"
            @click="store.archiveDepartment(d.id, false)"
          >
            恢复
          </button>
        </div>
        <p v-if="!org.departments.some((d) => d.archived)" class="muted">
          暂无归档部门
        </p>
      </div>
      <template v-else
        ><p class="dialog-description">
          将更新选中的 {{ bulkIds.length }} 位成员。
        </p>
        <IdentityInput
          v-if="modal === 'bulk-department'"
          v-model="bulkValue"
          kind="department"
          label="目标部门"
        /><select
          v-else-if="modal === 'bulk-role'"
          v-model="bulkValue"
          aria-label="批量分配角色"
        >
          <option value="">请选择角色</option>
          <option
            v-for="role in org.roles.filter((r) => !r.archived)"
            :key="role.id"
            :value="role.id"
          >
            {{ role.name }}
          </option></select
        ><select v-else v-model="bulkValue" aria-label="批量成员状态">
          <option value="active">在职</option>
          <option value="inactive">停用</option>
          <option value="left">离职</option>
        </select></template
      ><template #footer
        ><button class="button" :disabled="busy" @click="requestClose">
          {{ modal === "archived" ? "关闭" : "取消" }}</button
        ><button
          v-if="modal !== 'archived'"
          class="button primary"
          :disabled="busy || (modal.startsWith('bulk-') && !bulkValue)"
          @click="
            modal === 'employee'
              ? saveEmployee()
              : modal === 'department'
                ? saveDepartment()
                : saveBulk()
          "
        >
          保存
        </button></template
      ></BaseDialog
    ></AdminLayout
  >
</template>
