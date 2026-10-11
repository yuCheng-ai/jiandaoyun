<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  useEditorDraftStore,
  type DraftRestoreTicket,
} from "../../stores/editorDrafts";
import { useWorkspaceStore } from "../../stores/workspace";
const drafts = useEditorDraftStore(),
  workspace = useWorkspaceStore(),
  router = useRouter();
const message = ref(""),
  ticket = ref<DraftRestoreTicket>(),
  removing = ref(false),
  importing = ref(false),
  sourceText = ref("");
const selected = computed(() =>
  drafts.entries.find((d) => d.id === drafts.selectedId),
);
watch(
  () => drafts.entries,
  () => {
    if (!selected.value) drafts.selectedId = drafts.entries[0]?.id || "";
  },
  { immediate: true },
);
watch(
  () => drafts.selectedId,
  () => {
    ticket.value = undefined;
    removing.value = false;
    message.value = "";
  },
);
function remove() {
  if (selected.value && drafts.remove(selected.value.id)) {
    removing.value = false;
    message.value = "所选暂存已移除，编辑器和业务数据保持不变。";
  }
}
function checkpoint() {
  if (selected.value && drafts.checkpoint(selected.value.id))
    message.value = "已暂存到此标签页，刷新后可恢复；尚未保存或提交业务数据。";
}
function restore() {
  if (ticket.value && drafts.restore(ticket.value)) {
    workspace.notify("已放回编辑器，请检查后再保存或提交");
    workspace.recoveryOpen = false;
  }
  ticket.value = undefined;
}
async function importText(text: string) {
  message.value = "";
  const count = drafts.importDrafts(text);
  if (count !== undefined) {
    // Selecting the first imported entry clears stale confirmation feedback.
    // Publish the import receipt after that selection has settled.
    await nextTick();
    message.value = `已读取 ${count} 份新暂存，尚未写入业务数据。`;
    sourceText.value = "";
    importing.value = false;
  }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  message.value = "";
  try {
    if (file.size > 15_000_000)
      throw Error("恢复文件超过 15 MB，请使用编辑暂存副本");
    await importText(await file.text());
  } catch (e) {
    drafts.error = (e as Error).message;
  } finally {
    input.value = "";
  }
}
function download() {
  const url = URL.createObjectURL(
    new Blob([drafts.exportDrafts()], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `编辑暂存-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message.value = "已请求下载编辑暂存，请确认文件已保存。";
}
function openSource() {
  if (!selected.value) return;
  const path = selected.value.path;
  workspace.recoveryOpen = false;
  router.push(path);
}
</script>
<template>
  <section class="recovery-section">
    <h3>
      未提交的编辑内容 <small>{{ drafts.entries.length }} 份</small>
    </h3>
    <p>
      个人信息、数据推送、插件和智能助手配置的修改会自动暂存；表单填写遵循“自动暂存填写内容”设置。暂存仅保留在当前标签页，不等同于保存或提交。这里也可以处理导入的恢复副本。
    </p>
    <p v-if="drafts.error" class="field-error" role="alert">
      {{ drafts.error }}
    </p>
    <template v-if="drafts.entries.length">
      <label class="config-label"
        >选择编辑暂存
        <select v-model="drafts.selectedId" aria-label="选择编辑暂存">
          <option
            v-for="draft in drafts.entries"
            :key="draft.id"
            :value="draft.id"
          >
            {{ draft.title }} ·
            {{ new Date(draft.updatedAt).toLocaleString("zh-CN") }}
          </option>
        </select>
      </label>
      <template v-if="selected">
        <p>
          {{
            drafts.isCheckpoint(selected)
              ? "此版本已暂存到当前标签页"
              : "此版本仅保留在本页内存中"
          }}
          · {{ drafts.availability(selected).message }}
        </p>
        <div class="recovery-actions">
          <button type="button" class="button" @click="checkpoint">
            暂存到此标签页
          </button>
          <button
            type="button"
            class="button primary"
            :disabled="!drafts.availability(selected).ready"
            @click="ticket = drafts.prepareRestore(selected.id)"
          >
            放回当前编辑器
          </button>
          <button
            v-if="!drafts.availability(selected).ready"
            type="button"
            class="text-button"
            @click="openSource"
          >
            前往来源页面
          </button>
          <button
            type="button"
            class="text-button"
            @click="
              removing = true;
              ticket = undefined;
            "
          >
            移除所选暂存
          </button>
        </div>
        <div v-if="removing" class="config-discard" role="alert">
          <span>移除此份编辑暂存？需要保留时请先下载副本。</span>
          <button type="button" class="button" @click="removing = false">
            保留暂存
          </button>
          <button type="button" class="button" @click="remove">确认移除</button>
        </div>
        <div v-if="ticket" class="config-discard" role="alert">
          <span
            >将替换当前编辑器中的输入，请确认所选暂存。恢复后不会自动保存、提交或执行扩展；原暂存副本继续保留。</span
          >
          <button type="button" class="button" @click="ticket = undefined">
            取消恢复
          </button>
          <button type="button" class="button primary" @click="restore">
            确认放回
          </button>
        </div>
      </template>
    </template>
    <p v-else>当前没有已登记的编辑暂存。</p>
    <div class="recovery-actions editor-draft-file-actions">
      <button
        type="button"
        class="button"
        :disabled="!drafts.entries.length"
        @click="download"
      >
        下载编辑暂存
      </button>
      <label class="button editor-draft-import"
        >导入暂存文件<input
          type="file"
          accept=".json,application/json"
          aria-label="导入暂存文件"
          @change="importFile"
      /></label>
      <button type="button" class="text-button" @click="importing = !importing">
        粘贴暂存 JSON
      </button>
    </div>
    <div v-if="importing">
      <textarea
        v-model="sourceText"
        class="recovery-json"
        aria-label="待导入的编辑暂存 JSON"
        placeholder="粘贴编辑暂存或工作空间恢复副本的 JSON"
        spellcheck="false"
      />
      <button
        type="button"
        class="button"
        :disabled="!sourceText.trim()"
        @click="importText(sourceText)"
      >
        读取暂存内容
      </button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
