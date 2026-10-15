<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlatformSession } from "../../stores/platformSession";
import { signInDestination } from "../../router/sessionGuard";
import "../collaboration/collaboration.css";
const router = useRouter();
const route = useRoute();
const session = usePlatformSession(),
  username = ref(""),
  password = ref(""),
  busy = ref(false),
  error = ref("");
async function login() {
  if (busy.value || !username.value.trim() || !password.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.login(username.value.trim(), password.value);
    password.value = "";
    await router.replace(signInDestination(router, route.query.next) || "/");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main class="login-page">
    <form
      class="panel-card platform-login"
      :aria-busy="busy"
      @submit.prevent="login"
    >
      <h2>登录</h2>
      <p class="collab-help">登录后填写表单、查看记录和处理待办。</p>
      <label class="collab-field"
        >账号<input v-model="username" autocomplete="username" :disabled="busy"
      /></label>
      <label class="collab-field"
        >密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="busy"
      /></label>
      <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
      <p v-if="busy" class="dialog-pending" role="status">
        <span class="visually-hidden">正在登录…</span>
      </p>
      <button
        class="button primary"
        type="submit"
        :disabled="busy || !username.trim() || !password"
      >
        登录
      </button>
    </form>
  </main>
</template>
<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: clamp(48px, 12vh, 120px) 20px 40px;
  background: #f2f3f8;
}
.platform-login {
  position: relative;
  width: min(100%, 420px);
  padding: 28px;
}
.platform-login h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
</style>
