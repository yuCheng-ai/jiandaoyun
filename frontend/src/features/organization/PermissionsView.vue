<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  groupActionNames,
  groupScopeNames,
  type OrganizationFormPermission,
  type OrganizationPermissionSummary,
} from "@platform/contracts";
import AdminLayout from "./AdminLayout.vue";
import IdentityInput from "../../components/organization/IdentityInput.vue";
import AppIcon from "../../components/AppIcon.vue";
import { useOrganizationStore } from "../../stores/organization";
import { platformApi } from "../../repositories/platformApi";
import { identityLabel, rolesFor } from "../../domain/organization";
const store = useOrganizationStore();
const router = useRouter();
const employeeId = ref(""),
  query = ref("");
const org = computed(() => store.organization);
watch(
  org,
  (value) => {
    if (!value.employees.some((member) => member.id === employeeId.value))
      employeeId.value =
        value.employees.find((member) => member.status === "active")?.id || "";
  },
  { immediate: true },
);
const summary = ref<OrganizationPermissionSummary>();
const loading = ref(false);
const error = ref("");
let request = 0;
async function load() {
  const requested = ++request;
  const memberId = employeeId.value;
  summary.value = undefined;
  error.value = "";
  loading.value = false;
  if (!memberId || !store.ready) return;
  loading.value = true;
  try {
    const result = await platformApi<OrganizationPermissionSummary>(
      `/organization/permissions?${new URLSearchParams({ memberId })}`,
    );
    if (requested === request) summary.value = result;
  } catch (cause) {
    if (requested === request) error.value = (cause as Error).message;
  } finally {
    if (requested === request) loading.value = false;
  }
}
watch([employeeId, org, () => store.ready], load, { immediate: true });
onBeforeUnmount(() => request++);
const accountStatus = computed(() => {
  const member = summary.value?.member;
  if (!member) return "";
  if (member.accountStatus === "unlinked") return "尚未关联登录账号";
  if (member.accountStatus === "disabled") return "账号已停用";
  if (member.accountStatus === "admin")
    return `${member.username} · 平台管理员`;
  return `登录账号：${member.username}`;
});
// 直接显示服务端匹配的权限组，保留每组的操作和范围对应关系。
const permissions = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const rows = [];
  for (const form of summary.value?.forms || []) {
    if (
      !`${form.applicationTitle} ${form.title}`.toLowerCase().includes(keyword)
    )
      continue;
    if (summary.value?.member?.accountStatus === "admin") {
      rows.push({
        form,
        name: "平台管理员",
        actions: "全部操作",
        scope: "所有记录",
      });
    } else if (!form.groups.length) {
      rows.push({ form, name: "—", actions: "无", scope: "—" });
    } else {
      for (const group of form.groups) {
        rows.push({
          form,
          name: group.name,
          actions:
            group.actions
              .map((action) => groupActionNames[action])
              .join("、") || "无",
          scope: groupScopeNames[group.scope],
        });
      }
    }
  }
  return rows;
});
function configure(form: OrganizationFormPermission) {
  void router.push({
    name: "page-publish",
    params: { applicationId: form.applicationId, pageId: form.pageId },
    query: { section: "access" },
  });
}
</script>
<template>
  <AdminLayout active="permissions"
    ><section class="permission-query">
      <header class="organization-title"><h2>权限查询</h2></header>
      <div class="permission-query-toolbar">
        <div>
          <label>查询成员</label
          ><IdentityInput
            v-model="employeeId"
            label="查询成员"
            include-inactive
          />
        </div>
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="query"
            placeholder="搜索应用或表单"
            aria-label="查询权限表单"
          />
        </div>
        <button class="button" :disabled="loading || !employeeId" @click="load">
          刷新
        </button>
      </div>
      <div v-if="employeeId" class="permission-overview">
        <span class="person-avatar">{{
          identityLabel(org, employeeId).slice(0, 1)
        }}</span>
        <div>
          <strong>{{ identityLabel(org, employeeId) }}</strong>
          <p>
            角色：{{
              rolesFor(org, employeeId)
                .map((r) => r.name)
                .join("、") || "无"
            }}
          </p>
        </div>
        <span class="scope-note">{{ accountStatus }}</span>
      </div>
      <p v-if="loading" class="permission-boundary" role="status">
        正在读取权限…
      </p>
      <p v-if="error" class="permission-boundary field-error" role="alert">
        {{ error }}
        <button class="text-button" @click="load">重新读取</button>
      </p>
      <div v-if="summary" class="organization-table-scroll">
        <table class="organization-table">
          <thead>
            <tr>
              <th>应用</th>
              <th>表单</th>
              <th>权限来源</th>
              <th>允许操作</th>
              <th>数据范围</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in permissions"
              :key="`${item.form.pageId}-${index}`"
            >
              <td>{{ item.form.applicationTitle }}</td>
              <td>{{ item.form.title }}</td>
              <td>{{ item.name }}</td>
              <td :class="item.actions === '无' ? 'muted' : 'permission-yes'">
                {{ item.actions }}
              </td>
              <td>{{ item.scope }}</td>
              <td>
                <button class="text-button" @click="configure(item.form)">
                  设置权限
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-if="!loading && !error && !permissions.length"
        class="permission-boundary"
      >
        {{ employeeId ? "没有匹配的表单" : "请选择成员" }}
      </p>
      <p v-if="permissions.length" class="permission-boundary">
        字段权限和筛选条件可在“设置权限”中查看。
      </p>
    </section></AdminLayout
  >
</template>
