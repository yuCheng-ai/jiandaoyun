<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import type { SessionUser } from "@platform/contracts";
import AppIcon from "../AppIcon.vue";

defineProps<{ account?: SessionUser; busy?: boolean }>();
const emit = defineEmits<{ organization: []; logout: [] }>();
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>();
const open = ref(false);
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
</script>
<template>
  <div v-if="account" ref="root" class="user-menu" @focusout="leaveMenu" @keydown="menuKey">
    <button
      ref="trigger" type="button" class="avatar user-menu-trigger"
      :aria-label="`用户菜单：${account.name}`" aria-haspopup="menu" :aria-expanded="open"
      @click="open = !open" @keydown.down.prevent.stop="openKeyboard()" @keydown.up.prevent.stop="openKeyboard(true)"
    >{{ account.name.slice(0, 1) }}</button>
    <div v-if="open" class="user-menu-popover">
      <div class="user-menu-summary">
        <span class="avatar">{{ account.name.slice(0, 1) }}</span>
        <div><strong>{{ account.name }}</strong><small>{{ account.username }} · {{ account.role === 'admin' ? '管理员' : '普通成员' }}</small></div>
      </div>
      <div role="menu" aria-label="用户菜单">
        <button v-if="account.role === 'admin'" role="menuitem" type="button" @click="closeMenu(); emit('organization')">
          <AppIcon name="people" />组织与成员<AppIcon name="right" />
        </button>
        <button role="menuitem" type="button" :disabled="busy" @click="closeMenu(); emit('logout')">
          <AppIcon name="back" />{{ busy ? '正在退出…' : '退出登录' }}<AppIcon name="right" />
        </button>
      </div>
    </div>
  </div>
</template>
