<script setup lang="ts">
import { computed, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import type {
  AccountCreateRequest,
  AccountUser,
  ServerOrganization,
} from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";

const props = defineProps<{
  account?: AccountUser;
  initialName?: string;
  createAccount?: (input: AccountCreateRequest) => Promise<AccountUser>;
}>();
const emit = defineEmits<{
  close: [];
  saved: [account: AccountUser];
  refreshed: [account: AccountUser];
}>();
const account = ref(props.account);
const conflict = ref(false),
  reloadConfirm = ref(false);
const name = ref(account.value?.name || props.initialName || ""),
  username = ref(account.value?.username || "");
const active = ref(account.value?.active ?? true),
  resetPassword = ref(!account.value);
const password = ref(""),
  confirmation = ref(""),
  busy = ref(false),
  error = ref("");
const draft = computed(() => ({
  name: name.value,
  username: username.value,
  active: active.value,
  resetPassword: resetPassword.value,
  password: password.value,
  confirmation: confirmation.value,
}));
// Credentials stay in this dialog's memory and are never retained in browser drafts.
const { requestClose, confirmLeave, confirmDiscard, discard, markSaved } = useDraftDismiss(
  () => true,
  () => draft.value,
  () => emit("close"),
);
onBeforeRouteLeave(() => !busy.value && confirmLeave());
async function reloadAccount() {
  if (busy.value || !account.value) return;
  busy.value = true;
  try {
    const organization = await platformApi<ServerOrganization>("/organization");
    const latest = organization.users.find(
      (user) => user.id === account.value!.id,
    );
    if (!latest) throw new Error("账号不存在或已不可访问");
    account.value = latest;
    name.value = latest.name;
    username.value = latest.username;
    active.value = latest.active;
    resetPassword.value = false;
    password.value = confirmation.value = previousInput = error.value = "";
    conflict.value = reloadConfirm.value = confirmDiscard.value = false;
    markSaved();
    emit("refreshed", latest);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
let previousInput = "",
  requestId = "";
async function save() {
  if (busy.value) return;
  error.value = "";
  if (!name.value.trim()) {
    error.value = "请填写姓名";
    return;
  }
  if (
    !account.value &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,63}$/.test(username.value.trim())
  ) {
    error.value = "账号应为3–64位字母、数字或 _.@-，以字母或数字开头";
    return;
  }
  if (
    resetPassword.value &&
    (!password.value.trim() ||
      password.value.length < 16 ||
      password.value.length > 256)
  ) {
    error.value = "密码应为16–256个字符";
    return;
  }
  if (resetPassword.value && password.value !== confirmation.value) {
    error.value = "两次输入的密码不一致";
    return;
  }
  const input = {
    name: name.value.trim(),
    ...(account.value
      ? { expectedRevision: account.value.revision, active: active.value }
      : { username: username.value.trim() }),
    ...(resetPassword.value ? { password: password.value } : {}),
  };
  const fingerprint = JSON.stringify(input);
  if (previousInput !== fingerprint) {
    previousInput = fingerprint;
    requestId = crypto.randomUUID();
  }
  busy.value = true;
  try {
    const savedAccount =
      !account.value && props.createAccount
        ? await props.createAccount({
            requestId,
            name: name.value.trim(),
            username: username.value.trim(),
            password: password.value,
          })
        : await platformApi<AccountUser>(
            account.value
              ? `/organization/accounts/${account.value.id}`
              : "/organization/accounts",
            account.value ? "PUT" : "POST",
            { ...input, requestId },
          );
    password.value = confirmation.value = previousInput = "";
    markSaved();
    emit("saved", savedAccount);
  } catch (cause) {
    error.value = (cause as Error).message;
    conflict.value =
      !!account.value && cause instanceof PlatformError && cause.status === 409;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="true"
    :title="account ? '编辑账号' : '新增账号'"
    :busy="busy"
    @close="requestClose"
  >
    <div
      v-if="confirmDiscard"
      class="config-discard"
      role="alert"
      tabindex="-1"
    >
      修改尚未保存。
      <button class="button" @click="confirmDiscard = false">继续编辑</button>
      <button class="button" @click="discard">放弃修改</button>
    </div>
    <form
      id="account-editor-form"
      class="account-editor"
      @submit.prevent="save"
    >
      <label
        >姓名<input v-model="name" maxlength="100" autocomplete="off"
      /></label>
      <label
        >账号<input
          v-model="username"
          :readonly="!!account"
          maxlength="64"
          autocomplete="off"
      /></label>
      <template v-if="account">
        <label class="checkbox-line"
          ><input v-model="active" type="checkbox" />允许登录</label
        >
        <p v-if="active !== account.active" class="field-hint">
          {{
            active
              ? "启用后恢复原有角色及数据授权。"
              : "停用后立即退出登录，保留原记录、部门和角色。"
          }}
        </p>
        <label class="checkbox-line"
          ><input v-model="resetPassword" type="checkbox" />重置密码</label
        >
      </template>
      <template v-if="resetPassword">
        <label
          >{{ account ? "新密码" : "初始密码"
          }}<input
            v-model="password"
            type="password"
            autocomplete="new-password"
            maxlength="256"
        /></label>
        <label
          >确认密码<input
            v-model="confirmation"
            type="password"
            autocomplete="new-password"
            maxlength="256"
        /></label>
        <p class="field-hint">
          密码为16–256个字符。{{
            account
              ? "保存后其他登录会话失效。"
              : "新账号默认为普通成员，表单权限需另行分配。"
          }}
        </p>
      </template>
      <p v-if="error" class="field-error" role="alert">
        {{ error }}
        <button
          v-if="conflict"
          type="button"
          class="text-button"
          @click="reloadConfirm = true"
        >
          重新读取账号
        </button>
      </p>
      <div v-if="reloadConfirm" class="config-discard" role="alert">
        重新读取将放弃本次账号修改。
        <button type="button" class="button" @click="reloadConfirm = false">
          继续编辑
        </button>
        <button type="button" class="button" @click="reloadAccount">
          放弃修改并读取
        </button>
      </div>
    </form>
    <template #footer>
      <button class="button" @click="requestClose">取消</button>
      <button class="button primary" type="submit" form="account-editor-form">
        {{ account ? "保存账号" : "创建账号" }}
      </button>
    </template>
  </BaseDialog>
</template>
<style scoped>
.account-editor {
  display: grid;
  gap: 14px;
}
.account-editor > label:not(.checkbox-line) {
  display: grid;
  gap: 7px;
}
.account-editor input:not([type="checkbox"]) {
  width: 100%;
  min-width: 0;
}
.account-editor p {
  margin: 0;
}
</style>
