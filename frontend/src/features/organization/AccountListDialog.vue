<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { AccountUser, ServerOrganization } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import AppIcon from "../../components/AppIcon.vue";
import AccountEditorDialog from "./AccountEditorDialog.vue";
import { platformApi } from "../../repositories/platformApi";
import { usePlatformSession } from "../../stores/platformSession";
const emit = defineEmits<{ close: [] }>();
const users = ref<AccountUser[]>([]),
  query = ref(""),
  busy = ref(false),
  error = ref("");
const editing = ref<AccountUser | null>();
const session = usePlatformSession();
const matches = computed(() =>
  users.value.filter((user) =>
    `${user.name} ${user.username}`
      .toLowerCase()
      .includes(query.value.trim().toLowerCase()),
  ),
);
async function load() {
  busy.value = true;
  error.value = "";
  try {
    users.value = (
      await platformApi<ServerOrganization>("/organization")
    ).users;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
function updated(account: AccountUser) {
  const index = users.value.findIndex((user) => user.id === account.id);
  if (index < 0) users.value.push(account);
  else users.value[index] = account;
  if (session.user?.id === account.id)
    session.user = { ...session.user, name: account.name };
}
function saved(account: AccountUser) {
  updated(account);
  editing.value = undefined;
}
onMounted(load);
</script>
<template>
  <BaseDialog
    :open="true"
    title="登录账号"
    width="760px"
    @close="emit('close')"
  >
    <p class="field-hint">
      管理登录状态和密码。成员的账号关联在通讯录成员行中设置。
    </p>
    <div class="organization-toolbar account-list-toolbar">
      <button class="button primary" @click="editing = null">
        <AppIcon name="add" />新增账号
      </button>
      <div class="toolbar-spacer" />
      <input
        v-model="query"
        aria-label="搜索登录账号"
        placeholder="搜索姓名或账号"
      />
      <button class="button" :disabled="busy" @click="load">刷新</button>
    </div>
    <p v-if="busy" role="status">正在读取账号…</p>
    <p v-if="error" class="field-error" role="alert">
      {{ error }} <button class="text-button" @click="load">重试</button>
    </p>
    <div class="account-list-scroll">
      <table class="organization-table">
        <thead>
          <tr>
            <th>姓名</th>
            <th>账号</th>
            <th>身份</th>
            <th>登录状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in matches" :key="user.id">
            <td>{{ user.name }}</td>
            <td>{{ user.username }}</td>
            <td>{{ user.role === "admin" ? "管理员" : "普通成员" }}</td>
            <td>{{ user.active ? "启用" : "停用" }}</td>
            <td>
              <button
                class="text-button"
                :aria-label="`编辑${user.name}账号`"
                @click="editing = user"
              >
                编辑
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!busy && !error && !matches.length" class="field-hint">
      没有找到账号
    </p>
    <template #footer
      ><button class="button" @click="emit('close')">关闭</button></template
    >
  </BaseDialog>
  <AccountEditorDialog
    v-if="editing !== undefined"
    :account="editing || undefined"
    @close="editing = undefined"
    @saved="saved"
    @refreshed="updated"
  />
</template>
<style scoped>
.account-list-toolbar {
  padding: 8px 0 16px;
}
.account-list-toolbar input {
  max-width: 220px;
}
.account-list-scroll {
  overflow: auto;
}
</style>
