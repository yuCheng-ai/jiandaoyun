<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BaseDialog from "../../components/BaseDialog.vue";
import EditorDraftRecovery from "./EditorDraftRecovery.vue";
import { WORKSPACE_KEY } from "../../repositories/workspaceRepository";
import { useWorkspaceStore } from "../../stores/workspace";
const store = useWorkspaceStore(),
  router = useRouter(),
  route = useRoute();
const latest = shallowRef<ReturnType<typeof store.inspectLatest>>();
const selected = ref("");
const restoredHref = ref("");
const restoreError = ref("");
const backupText = ref("");
const downloadMessage = ref("");
const more = ref(false);
// Already-open development tabs can retain the previous store during a UI update.
const changedItems = computed(() => store.storageChanges || []);
const latestHref = computed(() => {
  const id = String(route.params.formId || "");
  return router.resolve(
    id &&
      !latest.value?.workspace?.forms.some((f) => f.id === id && !f.archived)
      ? { name: "home" }
      : route.fullPath,
  ).href;
});
const activeCandidate = computed(() =>
  store.recoveryCandidates.find((c) => c.key === selected.value),
);
function refresh() {
  latest.value = store.inspectLatest();
}
watch(
  () => store.recoveryOpen,
  (open) => {
    if (!open) return;
    refresh();
    selected.value =
      store.recoveryCandidates.find((c) => c.form.id === route.params.formId)
        ?.key ||
      store.recoveryCandidates[0]?.key ||
      "";
    more.value = false;
    restoredHref.value = "";
    restoreError.value = "";
    backupText.value = "";
    downloadMessage.value = "";
  },
  { immediate: true },
);
watch(selected, () => {
  restoredHref.value = "";
  restoreError.value = "";
});
function storageChanged(event: StorageEvent) {
  if (event.key === WORKSPACE_KEY || event.key === null) {
    if (store.recoveryOpen) refresh();
  }
}
function focusChanged() {
  if (store.recoveryOpen) refresh();
}
function visibilityChanged() {
  if (!document.hidden) focusChanged();
}
onMounted(() => {
  window.addEventListener("storage", storageChanged);
  window.addEventListener("focus", focusChanged);
  document.addEventListener("visibilitychange", visibilityChanged);
  focusChanged();
});
onUnmounted(() => {
  window.removeEventListener("storage", storageChanged);
  window.removeEventListener("focus", focusChanged);
  document.removeEventListener("visibilitychange", visibilityChanged);
});
function downloadBackup() {
  const text = store.exportRecovery();
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `工作空间恢复副本-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  downloadMessage.value =
    "已请求下载，请确认文件已保存后再关闭本页。也可以展开副本文本手动复制。";
}
async function recover() {
  restoreError.value = "";
  const form = await store.recoverDesign(selected.value);
  if (!form) {
    restoreError.value =
      store.notices.at(-1)?.message || "另存失败，请重试或先下载副本。";
    return;
  }
  restoredHref.value = router.resolve({
    name: "designer",
    params: { appId: form.appId, formId: form.id },
  }).href;
  refresh();
}
</script>
<template>
  <BaseDialog
    :open="store.recoveryOpen"
    :busy="store.writePending"
    :title="store.storageConflict ? '查看内容更新' : '处理保存问题'"
    width="560px"
    class-name="workspace-recovery-dialog"
    @close="store.recoveryOpen = false"
  >
    <template v-if="store.recoveryOpen">
      <p v-if="restoreError" class="field-error" role="alert">
        {{ restoreError }}
      </p>
      <p class="dialog-description">
        {{
          store.storageConflict
            ? "其他页面保存了新内容。你在本页的修改仍然保留。"
            : "本次保存没有完成，当前输入仍在本页。请保留本页后重试。"
        }}
      </p>
      <div
        v-if="store.storageConflict && changedItems.length"
        class="recovery-changes"
      >
        <span>更新的内容</span>
        <ul>
          <li v-for="label in changedItems.slice(0, 3)" :key="label">
            {{ label }}
          </li>
        </ul>
        <small v-if="changedItems.length > 3"
          >另有 {{ changedItems.length - 3 }} 项更新</small
        >
      </div>
      <p
        v-if="latest?.error || !latest?.workspace"
        class="config-warning"
        role="alert"
      >
        暂时无法读取最新内容。请继续保留本页，可在“更多处理方式”中保存副本。
      </p>
      <section
        v-if="store.recoveryCandidates.length"
        class="recovery-design-choice"
      >
        <label v-if="store.recoveryCandidates.length > 1" class="config-label">
          要保留的设计
          <select v-model="selected" aria-label="要保留的设计">
            <option
              v-for="candidate in store.recoveryCandidates"
              :key="candidate.key"
              :value="candidate.key"
            >
              {{ candidate.form.title }} · {{ candidate.source }}
            </option>
          </select>
        </label>
        <strong v-else>{{ activeCandidate?.form.title }}</strong>
        <p>
          可将本页设计另存为新表单，继续编辑。新表单未发布，自动执行的功能关闭。
        </p>
        <div class="recovery-actions">
          <button
            v-if="!restoredHref"
            type="button"
            class="button primary"
            :disabled="!activeCandidate || !latest?.workspace"
            @click="recover"
          >
            另存当前设计
          </button>
          <a
            v-else
            :href="restoredHref"
            class="button primary"
            target="_blank"
            rel="noopener"
            >继续编辑新表单 ↗</a
          >
        </div>
        <p v-if="restoredHref" role="status">
          设计已保留为新表单。原表单的数据未改动。
        </p>
      </section>
      <p class="recovery-next-hint">查看最新内容会打开新页面，本页不会关闭。</p>
      <details
        class="recovery-more"
        :open="more"
        @toggle="more = ($event.target as HTMLDetailsElement).open"
      >
        <summary>更多处理方式</summary>
        <template v-if="more">
          <EditorDraftRecovery />
          <section class="recovery-section">
            <h3>保留当前工作</h3>
            <p>
              副本包含本页工作空间、表单设计草稿、上方登记的编辑暂存、最近一次保存失败的操作和读取到的原始数据。未接入暂存的编辑器仍需保留本页对照。
            </p>
            <div class="recovery-actions">
              <button type="button" class="button" @click="downloadBackup">
                下载工作副本
              </button>
              <button
                type="button"
                class="text-button"
                @click="backupText = backupText ? '' : store.exportRecovery()"
              >
                {{ backupText ? "收起副本文本" : "查看副本文本" }}
              </button>
            </div>
            <p v-if="downloadMessage" role="status" class="field-hint">
              {{ downloadMessage }}
            </p>
            <textarea
              v-if="backupText"
              class="recovery-json"
              aria-label="工作空间恢复副本 JSON"
              readonly
              :value="backupText"
              spellcheck="false"
            />
            <p v-if="store.failedSave" class="field-hint">
              最近一次保存尝试：{{
                new Date(store.failedSave.at).toLocaleString("zh-CN")
              }}。其中的提交、发布或支付操作没有保存成功。
            </p>
          </section>
          <section class="recovery-section">
            <h3>查看最新数据</h3>
            <p v-if="latest?.error" class="config-warning">
              最新数据无法读取：{{ latest.error }}。请先下载副本。
            </p>
            <p v-else-if="!latest?.workspace" class="config-warning">
              浏览器中的工作空间已被清除或尚未保存。请先保留本页副本。
            </p>
            <div class="recovery-actions">
              <button type="button" class="text-button" @click="refresh">
                重新检查
              </button>
            </div>
          </section>
        </template>
      </details>
    </template>
    <template #footer
      ><button type="button" class="button" @click="store.recoveryOpen = false">
        返回编辑
      </button>
      <a
        v-if="latest?.workspace"
        class="button"
        :class="{ primary: !store.recoveryCandidates.length }"
        :href="latestHref"
        target="_blank"
        rel="noopener"
        >查看最新内容 ↗</a
      >
    </template>
  </BaseDialog>
</template>
