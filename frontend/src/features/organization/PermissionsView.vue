<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoleApplications } from "../../composables/useRoleApplications";
import type { GrantAction } from "../../domain/organization";
import AdminLayout from "./AdminLayout.vue";
import IdentityInput from "../../components/organization/IdentityInput.vue";
import AppIcon from "../../components/AppIcon.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  identityLabel,
  permissionsFor,
  rolesFor,
} from "../../domain/organization";
const store = useWorkspaceStore();
const employeeId = ref(store.data.organization.currentUserId),
  query = ref("");
const org = computed(() => store.data.organization);
watch(
  org,
  (value) => {
    if (!value.employees.some((member) => member.id === employeeId.value))
      employeeId.value =
        value.employees.find((member) => member.status === "active")?.id || "";
  },
  { immediate: true },
);
const catalog = useRoleApplications();
const actions: GrantAction[] = ["view", "submit", "manage"];
const scopeLabel = (scopes: string[]) =>
  scopes
    .map(
      (scope) =>
        ({ all: "全部数据", self: "本人提交", department: "所在部门" })[scope],
    )
    .join("、") || "—";
const permissions = computed(() =>
  catalog.applications.value.flatMap((app) =>
    app.forms
      .filter((form) => form.title.includes(query.value))
      .map((form) => ({
        form,
        app,
        ...permissionsFor(
          org.value,
          employeeId.value,
          app.id,
          form.id,
          app.sourceId,
          form.sourceId,
        ),
      })),
  ),
);
</script>
<template>
  <AdminLayout active="permissions"
    ><section class="permission-query">
      <header class="organization-title"><h2>权限查询</h2></header>
      <div class="permission-query-toolbar">
        <div>
          <label>查询成员</label
          ><IdentityInput v-model="employeeId" label="查询成员" />
        </div>
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="query"
            placeholder="搜索表单"
            aria-label="查询权限表单"
          />
        </div>
      </div>
      <div class="permission-overview">
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
        <span class="scope-note">角色授权范围；表单权限组优先生效</span>
      </div>
      <p v-if="catalog.loading.value" class="field-hint" role="status">
        正在读取应用…
      </p>
      <p v-if="catalog.error.value" class="field-error" role="alert">
        {{ catalog.error.value }}
        <button class="text-button" @click="catalog.load">重新读取</button>
      </p>
      <div class="organization-table-scroll">
        <table class="organization-table">
          <thead>
            <tr>
              <th>应用</th>
              <th>表单</th>
              <th>查看</th>
              <th>填写提交</th>
              <th>管理数据</th>
              <th>生效方式</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in permissions" :key="item.form.id">
              <td>{{ item.app?.name }}</td>
              <td>{{ item.form.title }}</td>
              <td v-for="action in actions" :key="action">
                <span
                  :class="
                    item.scopes[action].length ? 'permission-yes' : 'muted'
                  "
                  >{{
                    action === "submit" && item.scopes[action].length
                      ? "允许填写"
                      : scopeLabel(item.scopes[action])
                  }}</span
                >
              </td>
              <td>
                {{
                  !item.app.connected
                    ? "应用尚未接入账号访问"
                    : item.form.grouped
                      ? "按表单权限组"
                      : "角色授权"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="permission-boundary">
        此处核对角色授权，各操作的数据范围分别计算。成员需关联有效登录账号；表单权限组、成员直接授权及具体记录条件请在表单内核对。
      </p>
    </section></AdminLayout
  >
</template>
