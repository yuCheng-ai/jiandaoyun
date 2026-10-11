<script setup lang="ts">
import { ref } from "vue";
import { usePlatformSession } from "../../stores/platformSession";
const emit = defineEmits<{ signedIn: [] }>();
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
    emit("signedIn");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form
    class="panel-card platform-login"
    :aria-busy="busy"
    @submit.prevent="login"
  >
    <h2>登录</h2>
    <p class="collab-help">
      登录后按你的权限填写表单、查看记录和处理待办。当前使用本项目的开发账号。
    </p>
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
    <p v-if="busy" role="status">正在登录…</p>
    <button
      class="button primary"
      type="submit"
      :disabled="busy || !username.trim() || !password"
    >
      登录
    </button>
  </form>
</template>
<style scoped>
.platform-login {
  max-width: 420px;
  margin: 24px auto;
  padding: 24px;
}
.platform-login h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
</style>
