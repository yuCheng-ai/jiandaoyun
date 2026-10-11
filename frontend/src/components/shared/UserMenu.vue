<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "../AppIcon.vue";
import BaseDialog from "../BaseDialog.vue";
import IdentityInput from "../organization/IdentityInput.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { copy } from "../../domain/form";
import { restoreProfileDraft } from "../../domain/editorDraftAdapters";
import { identityLabel, type Employee } from "../../domain/organization";
import { useWorkspaceStore } from "../../stores/workspace";
import type { SessionUser } from "@platform/contracts";

const props = defineProps<{ account?: SessionUser; busy?: boolean }>();
const emit = defineEmits<{ organization: []; logout: [] }>();

const store = useWorkspaceStore(),
  router = useRouter();
const root = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>();
const open = ref(false),
  dialog = ref(""),
  selectedMember = ref("");
const profile = ref<Employee>();
const dialogError = ref("");
const member = computed(() =>
  store.data.organization.employees.find(
    (e) => e.id === store.data.organization.currentUserId,
  ),
);
const displayName = computed(
  () => props.account?.name || member.value?.name || "当前成员",
);
const department = computed(() =>
  member.value?.primaryDepartmentId
    ? identityLabel(store.data.organization, member.value.primaryDepartmentId)
    : "未设置部门",
);
function closeMenu(focus = false) {
  open.value = false;
  if (focus) trigger.value?.focus();
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target))
    closeMenu();
}
document.addEventListener("pointerdown", outside);
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
function focusItem(index: number) {
  const items = root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]');
  if (items?.length) items[(index + items.length) % items.length]?.focus();
}
async function openKeyboard(last = false) {
  open.value = true;
  await nextTick();
  focusItem(last ? -1 : 0);
}
function menuKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [],
  );
  const index = items.indexOf(document.activeElement as HTMLElement);
  focusItem(
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? -1
        : index + (event.key === "ArrowDown" ? 1 : -1),
  );
}
function leaveMenu(event: FocusEvent) {
  if (
    event.relatedTarget instanceof Node &&
    !root.value?.contains(event.relatedTarget)
  )
    closeMenu();
}
function action(name: string) {
  closeMenu();
  dialogError.value = "";
  if (name === "admin") {
    router.push("/admin/organization");
    return;
  }
  if (name === "home") {
    router.push("/");
    return;
  }
  if (name === "profile") {
    if (!member.value) return;
    profile.value = copy(member.value);
  }
  if (name === "switch")
    selectedMember.value = store.data.organization.currentUserId;
  dialog.value = name;
}
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => dialog.value === "profile" || dialog.value === "switch",
    () =>
      dialog.value === "profile"
        ? {
            name: profile.value?.name || "",
            email: profile.value?.email || "",
            phone: profile.value?.phone || "",
          }
        : selectedMember.value,
    () => {
      dialog.value = "";
    },
    {
      enabled: () => dialog.value === "profile",
      key: () => `profile:${store.data.organization.currentUserId}`,
      title: () => `个人信息 · ${displayName.value}`,
      context: () => ({ member: member.value }),
      restore: (value) => {
        const restored = restoreProfileDraft(value);
        if (!profile.value) throw Error("请先打开个人信息编辑器");
        Object.assign(profile.value, restored);
        confirmDiscard.value = false;
        dialogError.value = "";
      },
    },
  );
function closeDialog() {
  if (dialog.value === "profile" || dialog.value === "switch") requestClose();
  else dialog.value = "";
}
async function saveProfile() {
  if (!profile.value || !member.value) return;
  dialogError.value = "";
  // Personal edits cannot change status, departments, employee number or role membership.
  if (
    await store.saveEmployee({
      ...member.value,
      name: profile.value.name.trim(),
      email: profile.value.email.trim(),
      phone: profile.value.phone.trim(),
    })
  ) {
    markSaved();
    store.notify("个人信息已保存");
    dialog.value = "";
  } else
    dialogError.value =
      store.storageError ||
      store.notices.at(-1)?.message ||
      "个人信息保存失败，请检查后重试。";
}
async function switchMember() {
  dialogError.value = "";
  if (!selectedMember.value) return;
  if (selectedMember.value === store.data.organization.currentUserId) {
    dialog.value = "";
    return;
  }
  if (await store.setCurrentUser(selectedMember.value)) {
    store.notify("当前体验成员已切换");
    dialog.value = "";
  } else
    dialogError.value =
      store.storageError ||
      store.notices.at(-1)?.message ||
      "成员切换失败，请检查后重试。";
}
</script>
<template>
  <div ref="root" class="user-menu" @focusout="leaveMenu" @keydown="menuKey">
    <button
      ref="trigger"
      type="button"
      class="avatar user-menu-trigger"
      :aria-label="`用户菜单：${displayName}`"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
      @keydown.down.prevent.stop="openKeyboard()"
      @keydown.up.prevent.stop="openKeyboard(true)"
    >
      {{ displayName.slice(0, 1) }}
    </button>
    <div v-if="open" class="user-menu-popover">
      <div class="user-menu-summary">
        <span class="avatar">{{ displayName.slice(0, 1) }}</span>
        <div>
          <strong>{{ displayName }}</strong
          ><small>{{
            account
              ? `${account.username} · ${account.role === "admin" ? "管理员" : "普通成员"}`
              : `${department} · ${member?.position || "成员"}`
          }}</small>
        </div>
      </div>
      <div v-if="!account" class="user-menu-organization">
        <AppIcon name="department" /><span>{{
          store.data.organization.name
        }}</span>
      </div>
      <div role="menu" aria-label="用户菜单">
        <template v-if="account">
          <button
            v-if="account.role === 'admin'"
            role="menuitem"
            type="button"
            @click="
              closeMenu();
              emit('organization');
            "
          >
            <AppIcon name="people" />组织与成员<AppIcon name="right" />
          </button>
          <button
            role="menuitem"
            type="button"
            :disabled="busy"
            @click="
              closeMenu();
              emit('logout');
            "
          >
            <AppIcon name="back" />{{ busy ? "正在退出…" : "退出登录"
            }}<AppIcon name="right" />
          </button>
        </template>
        <template v-else>
          <button role="menuitem" type="button" @click="action('profile')">
            <AppIcon name="approval" />个人信息<AppIcon name="right" />
          </button>
          <button role="menuitem" type="button" @click="action('switch')">
            <AppIcon name="people" />切换体验成员<AppIcon name="right" />
          </button>
          <div class="user-menu-divider" role="separator" />
          <button role="menuitem" type="button" @click="action('admin')">
            <AppIcon name="settings" />企业管理<AppIcon name="right" />
          </button>
          <button role="menuitem" type="button" @click="action('home')">
            <AppIcon name="home" />返回工作台<AppIcon name="right" />
          </button>
          <div class="user-menu-divider" role="separator" />
          <button role="menuitem" type="button" @click="action('about')">
            <AppIcon name="info" />关于工作台<AppIcon name="right" />
          </button>
        </template>
      </div>
    </div>
  </div>
  <BaseDialog
    :open="!!dialog"
    :draft-key="dialog === 'profile' ? draftKey : undefined"
    :title="
      dialog === 'profile'
        ? '个人信息'
        : dialog === 'switch'
          ? '切换体验成员'
          : '关于工作台'
    "
    @close="closeDialog"
    @closed="trigger?.focus()"
  >
    <div
      v-if="confirmDiscard"
      class="config-discard"
      tabindex="-1"
      role="alert"
    >
      <span>修改尚未保存，关闭后将丢失本次修改。</span
      ><button class="button" @click="confirmDiscard = false">继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <p v-if="dialogError" class="config-warning" role="alert">
      {{ dialogError }}
    </p>
    <template v-if="dialog === 'profile' && profile">
      <p class="dialog-description">
        用于工作空间内的成员展示，与通讯录保持同步。
      </p>
      <div class="profile-form">
        <label
          >姓名<input v-model="profile.name" maxlength="40" autocomplete="off"
        /></label>
        <label
          >邮箱<input v-model="profile.email" type="email" autocomplete="off"
        /></label>
        <label
          >手机号<input v-model="profile.phone" type="tel" autocomplete="off"
        /></label>
        <dl>
          <dt>工号</dt>
          <dd>{{ member?.number || "未设置" }}</dd>
          <dt>部门</dt>
          <dd>{{ department }}</dd>
          <dt>职位</dt>
          <dd>{{ member?.position || "未设置" }}</dd>
        </dl>
      </div>
    </template>
    <template v-else-if="dialog === 'switch'">
      <p class="dialog-description">
        选择通讯录中的在职成员，用于检查成员选择、默认值和访问范围。当前是本地体验身份，未连接真实账号认证。
      </p>
      <IdentityInput
        v-model="selectedMember"
        label="选择当前体验成员"
        :allow-roles="false"
      />
    </template>
    <template v-else>
      <div class="about-workspace">
        <AppIcon name="cloud" :size="38" />
        <h3>流程工作台</h3>
        <p>连接表单、审批流程与团队数据。</p>
      </div>
      <p class="dialog-description">
        当前使用浏览器内的本地工作空间。表单设计、组织管理和本地数据操作可保存；外部推送、支付及
        AI 能力按页面标注进行模拟或配置演示。
      </p>
    </template>
    <template #footer>
      <button class="button" @click="closeDialog">
        {{ dialog === "about" ? "关闭" : "取消" }}
      </button>
      <button
        v-if="dialog === 'profile'"
        class="button primary"
        @click="saveProfile"
      >
        保存
      </button>
      <button
        v-if="dialog === 'switch'"
        class="button primary"
        :disabled="!selectedMember"
        @click="switchMember"
      >
        确认切换
      </button>
    </template>
  </BaseDialog>
</template>
