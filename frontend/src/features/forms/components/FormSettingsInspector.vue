<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import VisibilityRules from "./VisibilityRules.vue";
import FormValidationSettings from "./FormValidationSettings.vue";
import HiddenValueSettings from "./HiddenValueSettings.vue";
import FormLayoutSettings from "./FormLayoutSettings.vue";
import FormExternalStyleSettings from "./FormExternalStyleSettings.vue";
import FrontendEventSettings from "./FrontendEventSettings.vue";
import { type FormSchema } from "../../../domain/form";
const props = withDefaults(
  defineProps<{ schema: FormSchema; title?: string; formId?: string }>(),
  { title: "未命名表单", formId: "" },
);
const dialog = ref<"" | "details">("");
const operation = ref<"" | "submit" | "draft">("");
const submitButton = ref<HTMLButtonElement>();
const draftButton = ref<HTMLButtonElement>();
const operationTitle = computed(() =>
  operation.value === "draft" ? "保存草稿" : "提交",
);
const operationEnabled = computed({
  get: () =>
    operation.value === "draft"
      ? props.schema.settings.allowDraft
      : props.schema.settings.allowSubmit !== false,
  set: (value: boolean) => {
    if (operation.value === "draft") props.schema.settings.allowDraft = value;
    else props.schema.settings.allowSubmit = value;
  },
});
const operationLabel = computed({
  get: () =>
    operation.value === "draft"
      ? (props.schema.settings.draftLabel ?? "保存草稿")
      : props.schema.settings.submitLabel,
  set: (value: string) => {
    if (operation.value === "draft") props.schema.settings.draftLabel = value;
    else props.schema.settings.submitLabel = value;
  },
});
async function completeOperation() {
  const previous = operation.value;
  operation.value = "";
  await nextTick();
  (previous === "draft" ? draftButton.value : submitButton.value)?.focus();
}
</script>
<template>
  <div
    class="form-settings-inspector"
    :class="{ 'operation-settings': operation }"
  >
    <template v-if="operation">
      <button class="button primary full-width" @click="completeOperation">
        完成
      </button>
      <div class="setting-toggle operation-toggle">
        <strong>{{ operationTitle }}</strong>
        <button
          class="switch"
          :class="{ on: operationEnabled }"
          role="switch"
          :aria-label="`启用${operationTitle}`"
          :aria-checked="operationEnabled"
          @click="operationEnabled = !operationEnabled"
        >
          <span />
        </button>
      </div>
      <p v-if="operation === 'draft'" class="operation-description">
        保存后，可在草稿箱中继续填写或提交。
      </p>
      <div class="form-group">
        <label for="operation-label"
          >按钮文字 <AppIcon name="help" :size="13" class="muted-icon"
        /></label>
        <input
          id="operation-label"
          v-model="operationLabel"
          maxlength="12"
          :aria-label="`${operationTitle}按钮文字`"
        />
        <button
          class="button full-width restore-operation-label"
          @click="operationLabel = operationTitle"
        >
          恢复默认按钮文字
        </button>
      </div>
    </template>
    <template v-else>
      <FormValidationSettings :schema="schema" />
      <VisibilityRules :schema="schema" />
      <HiddenValueSettings :schema="schema" />
      <div class="form-group setting-toggle">
        <strong
          title="自动保留未提交的填写内容，刷新后可继续；仅保留在当前标签页。"
          >表单前台缓存
          <AppIcon name="help" :size="13" class="muted-icon" /></strong
        ><button
          class="switch"
          :class="{ on: schema.settings.cacheDraft }"
          role="switch"
          aria-label="表单前台缓存"
          :aria-checked="schema.settings.cacheDraft"
          @click="schema.settings.cacheDraft = !schema.settings.cacheDraft"
        >
          <span />
        </button>
      </div>
      <FormLayoutSettings :schema="schema" />
      <div class="form-group">
        <label
          >操作按钮 <AppIcon name="help" :size="13" class="muted-icon"
        /></label>
        <button
          ref="submitButton"
          class="operation-setting"
          aria-label="设置提交按钮"
          @click="operation = 'submit'"
        >
          <span>提交</span
          ><span
            class="operation-state"
            :class="{ enabled: schema.settings.allowSubmit !== false }"
            >{{
              schema.settings.allowSubmit !== false ? "已开启" : "已关闭"
            }}</span
          >
        </button>
        <button
          ref="draftButton"
          class="operation-setting"
          aria-label="设置保存草稿按钮"
          @click="operation = 'draft'"
        >
          <span>保存草稿</span
          ><span
            class="operation-state"
            :class="{ enabled: schema.settings.allowDraft }"
            >{{ schema.settings.allowDraft ? "已开启" : "已关闭" }}</span
          >
        </button>
      </div>
      <FormExternalStyleSettings
        :schema="schema"
        :title="title"
        :form-id="formId"
      />
      <FrontendEventSettings :schema="schema" :form-id="formId" />
      <button class="text-button" @click="dialog = 'details'">
        表单说明与提交提示
      </button>
    </template>
    <BaseDialog
      :open="!!dialog"
      :title="
        {
          '': '',
          details: '表单说明与提交提示',
        }[dialog]
      "
      width="600px"
      @close="dialog = ''"
      ><template v-if="dialog === 'details'">
        <div class="form-group">
          <label for="form-description">表单说明</label
          ><textarea
            id="form-description"
            v-model="schema.settings.description"
            rows="3"
            placeholder="帮助填写者了解表单用途"
          />
        </div>
        <div class="form-group">
          <label for="success-message">提交成功提示</label
          ><input
            id="success-message"
            v-model="schema.settings.successMessage"
            maxlength="100"
          />
        </div> </template
      ><template #footer
        ><button class="button" @click="dialog = ''">关闭</button></template
      ></BaseDialog
    >
  </div>
</template>
