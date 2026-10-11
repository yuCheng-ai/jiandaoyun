<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import BaseDialog from "../BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  prepareButton,
  type CustomButton,
  type ButtonPosition,
  type ButtonResult,
} from "../../domain/buttons";
import { copy, type FormSchema, type FormValues } from "../../domain/form";
import { matchesFilters, scopeFields } from "../../domain/relations";
const props = defineProps<{
  buttons: CustomButton[];
  position: ButtonPosition;
  schema: FormSchema;
  values: FormValues;
  formId: string;
  entryId?: string;
  preview?: boolean;
}>();
const emit = defineEmits<{ apply: [values: FormValues] }>();
const store = useWorkspaceStore(),
  router = useRouter();
const selected = ref(""),
  result = ref<ButtonResult>(),
  message = ref("");
const entry = computed(() =>
  props.entryId
    ? store.data.entries.find(
        (e) => e.id === props.entryId && !e.deletedAt && e.status !== "draft",
      )
    : undefined,
);
const currentValues = computed(() =>
  props.entryId ? entry.value?.values || {} : props.values,
);
const available = computed(() =>
  props.entryId && !entry.value
    ? []
    : props.buttons.filter(
        (c) =>
          c.enabled &&
          !c.archived &&
          c.positions.includes(props.position) &&
          matchesFilters(
            c.filters,
            currentValues.value,
            currentValues.value,
            store.data,
            "all",
            scopeFields(props.schema.fields),
          ),
      ),
);
const active = computed(() =>
  props.buttons.find((c) => c.id === selected.value),
);
function prepare() {
  const c = active.value;
  if (
    !c ||
    (props.entryId && !entry.value) ||
    store.data.forms.find((f) => f.id === props.formId)?.archived
  )
    return {
      status: "error",
      message: "表单、记录或按钮已不可用",
      changes: [],
    } as ButtonResult;
  return prepareButton(
    c,
    props.schema,
    currentValues.value,
    store.data,
    props.position,
  );
}
function open(c: CustomButton) {
  selected.value = c.id;
  message.value = "";
  result.value = prepare();
}
async function confirm() {
  const latest = prepare();
  if (JSON.stringify(latest) !== JSON.stringify(result.value)) {
    result.value = latest;
    message.value = "数据或配置已变化，请重新确认。";
    return;
  }
  if (latest.status !== "ready" || !active.value) return;
  if (props.preview) {
    message.value = "预览检查通过，未修改记录或打开目标页面。";
    return;
  }
  if (active.value.action === "link") {
    window.open(latest.url, "_blank", "noopener,noreferrer");
    selected.value = "";
    return;
  }
  if (active.value.action === "openForm") {
    const token = store.queuePrefill(
      latest.targetFormId!,
      latest.version!,
      latest.values!,
    );
    selected.value = "";
    void router.push({
      path: `/apps/${latest.appId}/forms/${latest.targetFormId}/fill`,
      query: { prefill: token },
    });
    return;
  }
  if (props.entryId) {
    if (
      !(await store.updateEntry(
        props.entryId,
        latest.values!,
        active.value.name,
      ))
    ) {
      message.value = "未保存，请处理页面提示后重试。";
      return;
    }
    store.notify("记录已更新，流程位置保持不变");
  } else {
    emit("apply", copy(latest.values!));
    store.notify("已更新填写内容，请检查后提交");
  }
  selected.value = "";
}
</script>
<template>
  <div
    v-if="available.length"
    class="custom-button-bar"
    :class="{ compact: position === 'row' }"
    aria-label="自定义操作"
  >
    <button
      v-for="c in available"
      :key="c.id"
      type="button"
      :class="
        position === 'row' ? 'text-button' : ['button', { primary: c.primary }]
      "
      @click="open(c)"
    >
      {{ c.name }}
    </button>
  </div>
  <BaseDialog
    :open="!!selected"
    :title="active?.name || '自定义操作'"
    width="620px"
    @close="selected = ''"
  >
    <p v-if="active?.confirmation">{{ active.confirmation }}</p>
    <p :class="result?.status === 'error' ? 'field-error' : 'field-hint'">
      {{ result?.message }}
    </p>
    <p
      v-if="active?.action === 'update' && result?.status === 'ready'"
      class="field-hint"
    >
      {{
        entryId
          ? "保存到当前记录，同时触发已配置的数据更新事件。"
          : "应用到当前填写内容，提交后才生成记录。"
      }}
    </p>
    <p v-if="result?.targetTitle" class="field-hint">
      目标：{{ result.targetTitle }} · V{{ result.version }}
    </p>
    <p v-if="result?.url" class="button-url-preview">{{ result.url }}</p>
    <div v-if="result?.changes.length" class="button-change-list">
      <div v-for="c in result.changes" :key="c.id">
        <strong>{{ c.label }}</strong
        ><span>{{ c.before }} → {{ c.after }}</span>
      </div>
    </div>
    <p
      v-else-if="result?.status === 'ready' && active?.action === 'update'"
      class="field-hint"
    >
      字段值没有变化。
    </p>
    <p v-if="message" role="status" class="config-warning">{{ message }}</p>
    <template #footer
      ><button type="button" class="button" @click="selected = ''">取消</button
      ><button
        v-if="result?.status === 'ready'"
        type="button"
        class="button primary"
        @click="confirm"
      >
        {{
          preview
            ? "检查操作"
            : active?.action === "update"
              ? "确认应用"
              : active?.action === "link"
                ? "打开链接"
                : "打开表单"
        }}
      </button></template
    >
  </BaseDialog>
</template>
