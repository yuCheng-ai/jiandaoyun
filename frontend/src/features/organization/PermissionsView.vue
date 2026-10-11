<script setup lang="ts">
import { computed, ref } from "vue";
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
const permissions = computed(() =>
  store.activeForms
    .filter((f) => f.title.includes(query.value))
    .map((f) => ({
      form: f,
      app: store.data.apps.find((a) => a.id === f.appId),
      ...permissionsFor(org.value, employeeId.value, f.appId, f.id),
    })),
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
        <span class="scope-note">展示当前本地角色配置合并后的权限</span>
      </div>
      <div class="organization-table-scroll">
        <table class="organization-table">
          <thead>
            <tr>
              <th>应用</th>
              <th>表单</th>
              <th>查看</th>
              <th>填写提交</th>
              <th>管理数据</th>
              <th>数据范围</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in permissions" :key="item.form.id">
              <td>{{ item.app?.name }}</td>
              <td>{{ item.form.title }}</td>
              <td v-for="action in ['view', 'submit', 'manage']" :key="action">
                <span
                  :class="
                    item.actions.includes(action as any)
                      ? 'permission-yes'
                      : 'muted'
                  "
                  >{{
                    item.actions.includes(action as any) ? "允许" : "—"
                  }}</span
                >
              </td>
              <td>
                {{
                  item.actions.length
                    ? {
                        all: "全部数据",
                        self: "本人提交",
                        department: "所在部门",
                      }[item.dataScope]
                    : "无权限"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="permission-boundary">
        此处用于设计和核对权限配置；真实访问控制由接入的服务端执行。
      </p>
    </section></AdminLayout
  >
</template>
