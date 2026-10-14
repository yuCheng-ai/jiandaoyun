<script setup lang="ts">
import AppIcon from "../AppIcon.vue";
import { useNotices } from "../../stores/notices";

const { notices, dismiss } = useNotices();
const icons = {
  success: "success",
  warning: "warning",
  error: "warning",
  info: "info",
};
</script>

<template>
  <Teleport to="body">
    <div
      class="toast-stack"
      role="status"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <div
        v-for="notice in notices"
        :key="notice.id"
        class="toast"
        :class="notice.type"
      >
        <AppIcon :name="icons[notice.type]" />
        <span>{{ notice.message }}</span>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭提示"
          @click="dismiss(notice.id)"
        >
          <AppIcon name="close" :size="14" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  left: 50%;
  top: 65px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 10000;
  pointer-events: none;
  max-width: calc(100vw - 24px);
}
.toast {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 4px 22px #22365222;
  border: 1px solid #e4edea;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  pointer-events: auto;
}
.toast > .app-icon,
.toast > button {
  flex-shrink: 0;
}
.toast.success > .app-icon {
  color: #29b280;
}
.toast.warning > .app-icon {
  color: #c48b22;
}
.toast.error > .app-icon {
  color: #c84444;
}
.toast.info > .app-icon {
  color: #4b78bc;
}
</style>
