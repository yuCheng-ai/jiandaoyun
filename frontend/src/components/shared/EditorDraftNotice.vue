<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  useEditorDraftStore,
  type DraftRestoreTicket,
} from "../../stores/editorDrafts";
import { useWorkspaceStore } from "../../stores/workspace";
const props = defineProps<{ draftKey: string; disabled?: boolean }>();
const drafts = useEditorDraftStore(),
  workspace = useWorkspaceStore();
const ignored = ref<string[]>([]),
  selectedId = ref(""),
  ticket = ref<DraftRestoreTicket>(),
  restoreError = ref("");
const root = ref<HTMLElement>();
function focusEditor(scope: Element | null | undefined) {
  nextTick(() => {
    const input = Array.from(
      scope?.querySelectorAll<HTMLElement>(
        "input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled])",
      ) || [],
    ).find(
      (element) =>
        element.offsetParent !== null && !root.value?.contains(element),
    );
    input?.focus();
  });
}
const matching = computed(() =>
  drafts
    .recoverable(props.draftKey)
    .filter((d) => !ignored.value.includes(d.id)),
);
const selected = computed(
  () =>
    matching.value.find((d) => d.id === selectedId.value) || matching.value[0],
);
const busy = computed(() => props.disabled);
const captureFailed = computed(
  () => drafts.issues[props.draftKey] || drafts.loadError,
);
watch(
  () => props.draftKey,
  () => {
    ignored.value = [];
    selectedId.value = "";
    restoreError.value = "";
    ticket.value = undefined;
  },
);
watch(
  () => selected.value?.id,
  () => {
    restoreError.value = "";
    ticket.value = undefined;
  },
);
function prepare() {
  if (busy.value || !selected.value) return;
  ticket.value = drafts.prepareRestore(selected.value.id);
  if (!ticket.value)
    restoreError.value = "这份内容已无法恢复，请重新打开编辑器后检查。";
}
function restore() {
  if (busy.value || !ticket.value) return;
  const scope = root.value?.closest("dialog, form");
  if (drafts.restore(ticket.value)) {
    workspace.notify("已恢复上次编辑内容，请检查后保存或提交");
    restoreError.value = "";
    focusEditor(scope);
  } else {
    restoreError.value = "恢复未完成，当前输入已保留。请重新选择草稿后重试。";
  }
  ticket.value = undefined;
}
function ignore() {
  const scope = root.value?.closest("dialog, form");
  ignored.value = [...ignored.value, ...matching.value.map((d) => d.id)];
  ticket.value = undefined;
  focusEditor(scope);
}
</script>
<template>
  <aside
    ref="root"
    v-if="selected || captureFailed"
    class="editor-draft-notice"
    aria-label="编辑内容恢复"
  >
    <div
      v-if="captureFailed"
      class="editor-draft-line editor-draft-error"
      role="alert"
    >
      <span>当前内容暂未自动保留，请保持页面打开并保存。</span>
      <button
        type="button"
        class="text-button"
        :disabled="busy"
        @click="drafts.retryCapture(draftKey)"
      >
        重试暂存
      </button>
    </div>
    <template v-if="selected">
      <div class="editor-draft-line">
        <span>有上次未保存的编辑内容。</span>
        <div class="editor-draft-actions">
          <button
            type="button"
            class="text-button"
            :disabled="busy || !drafts.availability(selected).ready"
            @click="prepare"
          >
            恢复内容
          </button>
          <button
            type="button"
            class="text-button"
            :disabled="busy"
            @click="ignore"
          >
            暂不恢复
          </button>
        </div>
      </div>
      <label v-if="matching.length > 1" class="editor-draft-choice">
        选择要恢复的内容
        <select
          v-model="selectedId"
          aria-label="选择要恢复的编辑内容"
          :disabled="busy"
        >
          <option disabled value="">最近一次编辑</option>
          <option v-for="entry in matching" :key="entry.id" :value="entry.id">
            {{ new Date(entry.updatedAt).toLocaleString("zh-CN") }} ·
            {{ entry.title }}
          </option>
        </select>
      </label>
      <p v-if="!drafts.availability(selected).ready" class="editor-draft-hint">
        表单、原数据或当前成员已变化，这份内容暂时无法直接恢复。
      </p>
      <div v-if="ticket" class="editor-draft-confirm" role="alert">
        <p>用这份内容替换当前输入？恢复后仍需保存或提交。</p>
        <div class="editor-draft-actions">
          <button
            type="button"
            class="button"
            :disabled="busy"
            @click="ticket = undefined"
          >
            继续当前编辑
          </button>
          <button
            type="button"
            class="button primary"
            :disabled="busy"
            @click="restore"
          >
            确认恢复
          </button>
        </div>
      </div>
      <p v-if="restoreError" class="field-error" role="alert">
        {{ restoreError }}
      </p>
    </template>
  </aside>
</template>
