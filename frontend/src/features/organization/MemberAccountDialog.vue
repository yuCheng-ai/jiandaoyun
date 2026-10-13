<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import type {
  AccountCreateRequest,
  AccountUser,
  MemberAccountLink,
  MemberAccounts,
} from "@platform/contracts";
import { directoryCanonical } from "@platform/contracts";
import type { Employee } from "../../domain/organization";
import { copy } from "../../domain/form";
import BaseDialog from "../../components/BaseDialog.vue";
import AccountEditorDialog from "./AccountEditorDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import {
  currentAccountMember,
  withAccountMember,
} from "../../repositories/memberAccounts";

const props = defineProps<{ member: Employee; namespace: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const member = copy(props.member),
  directory = ref<MemberAccounts>();
const selectedId = ref(""),
  error = ref(""),
  busy = ref(false),
  loaded = ref(false),
  conflict = ref(false),
  reloadConfirm = ref(false);
const editing = ref<AccountUser | null>();
const link = computed(() =>
  directory.value?.links.find((item) => item.source.memberId === member.id),
);
const choices = computed(
  () =>
    directory.value?.accounts.filter(
      (account) =>
        !directory.value!.links.some(
          (item) =>
            item.account.id === account.id &&
            item.source.memberId !== member.id,
        ),
    ) || [],
);
const selected = computed(() =>
  choices.value.find((account) => account.id === selectedId.value),
);
const { requestClose, confirmLeave, confirmDiscard, discard, markSaved, dirty } =
  useDraftDismiss(
    () => !!directory.value,
    () => selectedId.value,
    () => emit("close"),
  );
async function load() {
  if (busy.value) return;
  busy.value = true;
  loaded.value = false;
  error.value = "";
  try {
    if (
      directoryCanonical(await currentAccountMember(member.id, props.namespace)) !==
      directoryCanonical(member)
    )
      throw Error("成员资料已变化，请关闭后重新打开");
    directory.value = await platformApi<MemberAccounts>(
      `/organization/member-accounts?namespace=${props.namespace}`,
    );
    selectedId.value = link.value?.account.id || "";
    conflict.value = reloadConfirm.value = false;
    markSaved();
    loaded.value = true;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
let previous = "",
  requestId = "";
async function save() {
  if (busy.value || !loaded.value || !selected.value) return;
  const body = {
    accountId: selected.value.id,
    accountRevision: selected.value.revision,
    expectedRevision: link.value?.revision || 0,
  };
  const fingerprint = JSON.stringify(body);
  if (fingerprint !== previous) {
    previous = fingerprint;
    requestId = crypto.randomUUID();
  }
  busy.value = true;
  error.value = "";
  conflict.value = false;
  try {
    await withAccountMember(member, props.namespace, (source) =>
      platformApi<MemberAccountLink>("/organization/member-accounts", "PUT", {
        ...body,
        source,
        requestId,
      }),
    );
    markSaved();
    emit("saved");
    emit("close");
  } catch (cause) {
    error.value = (cause as Error).message;
    conflict.value = cause instanceof PlatformError && cause.status === 409;
  } finally {
    busy.value = false;
  }
}
async function createAccount(input: AccountCreateRequest) {
  if (member.status !== "active")
    throw Error("请先将成员设为在职，再开通登录账号");
  return withAccountMember(member, props.namespace, (source) =>
    platformApi<AccountUser>("/organization/accounts", "POST", {
      ...input,
      member: { source, expectedRevision: link.value?.revision || 0 },
    }),
  );
}
async function accountSaved() {
  editing.value = undefined;
  await load();
  emit("saved");
}
onMounted(load);
onBeforeRouteLeave(() => {
  if (editing.value !== undefined) return;
  return !busy.value && confirmLeave();
});
</script>
<template>
  <BaseDialog
    :open="true"
    :title="`${member.name}的登录账号`"
    width="520px"
    :busy="busy"
    @close="requestClose"
  >
    <p class="member-account-identity">
      {{ member.name }}<span>{{ member.number }}</span>
    </p>
    <p class="field-hint">
      关联后使用此成员的部门和角色。原表单的应用授权仍待接入，账号的已有授权保留。
    </p>
    <p v-if="error" class="field-error" role="alert">
      {{ error }}
      <button v-if="conflict" class="text-button" @click="reloadConfirm = true">
        重新读取关联
      </button>
    </p>
    <div
      v-if="reloadConfirm || confirmDiscard"
      class="config-discard"
      role="alert"
    >
      当前选择尚未保存。
      <button class="button" @click="reloadConfirm = confirmDiscard = false">
        继续编辑
      </button>
      <button v-if="reloadConfirm" class="button" @click="load">
        放弃修改并读取
      </button>
      <button v-else class="button" @click="discard">放弃修改</button>
    </div>
    <p v-if="busy" role="status">正在处理…</p>
    <button v-if="!loaded && !busy" class="button" @click="load">
      重新读取账号
    </button>
    <template v-if="directory">
      <div v-if="link" class="member-account-current">
        <div>
          <strong>{{ link.account.username }}</strong
          ><span
            >{{ link.account.name }} ·
            {{ link.account.active ? "允许登录" : "已停用" }}</span
          >
        </div>
        <button
          class="text-button"
          :disabled="busy || dirty || !loaded"
          @click="editing = link.account"
        >
          管理账号
        </button>
      </div>
      <label class="member-account-select"
        >{{ link ? "更换关联账号" : "关联现有账号" }}
        <select v-model="selectedId" :disabled="busy || !loaded">
          <option value="">请选择账号</option>
          <option
            v-for="account in choices"
            :key="account.id"
            :value="account.id"
          >
            {{ account.username }} · {{ account.name
            }}{{ account.role === "admin" ? "（管理员）" : ""
            }}{{ account.active ? "" : "（已停用）" }}
          </option>
        </select>
      </label>
      <p v-if="selected && selected.id !== link?.account.id" class="field-hint">
        将 {{ member.name }}（{{ member.number }}）关联到
        {{ selected.username }}（{{ selected.name }}）。
      </p>
      <button
        v-if="!link && member.status === 'active'"
        class="text-button"
        :disabled="busy || dirty || !loaded"
        @click="editing = null"
      >
        没有合适的账号？为此成员开通账号
      </button>
    </template>
    <template #footer
      ><button class="button" @click="requestClose">关闭</button
      ><button
        class="button primary"
        :disabled="
          busy || !loaded || !selected || selected.id === link?.account.id
        "
        @click="save"
      >
        保存关联
      </button></template
    >
  </BaseDialog>
  <AccountEditorDialog
    v-if="editing !== undefined"
    :account="editing || undefined"
    :initial-name="member.name"
    :create-account="createAccount"
    @close="editing = undefined"
    @saved="accountSaved"
    @refreshed="load"
  />
</template>
<style scoped>
.member-account-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 600;
}
.member-account-identity span,
.member-account-current span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}
.member-account-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  margin: 16px 0;
  background: var(--canvas);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.member-account-current div {
  display: grid;
  gap: 5px;
}
.member-account-select {
  display: grid;
  gap: 8px;
  margin: 16px 0;
}
</style>
