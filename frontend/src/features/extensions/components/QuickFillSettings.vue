<script setup lang="ts">
import { computed, ref } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import QuickFillDialog from "../../forms/components/QuickFillDialog.vue";
import { useWorkspaceStore } from "../../../stores/workspace";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { restoreQuickFillDraft } from "../../../domain/extensionDraftAdapters";
import { copy, type FormValues } from "../../../domain/form";
import { runtimeDefaults, displayValue } from "../../../domain/relations";
import {
  newQuickFill,
  parseQuickFill,
  quickFillDesignSchema,
  quickFillFields,
  quickFillIssues,
} from "../../../domain/quickFill";
import type { FormRecord } from "../../../domain/workspace";
const props = defineProps<{ form: FormRecord }>();
const aliasText = ref<Record<string, string>>({});
const store = useWorkspaceStore(),
  open = ref(false),
  draft = ref(newQuickFill()),
  errors = ref<string[]>([]),
  query = ref(""),
  previewOpen = ref(false),
  previewValues = ref<FormValues>({}),
  saving = ref(false);
const schema = computed(() => quickFillDesignSchema(props.form)),
  fields = computed(() => quickFillFields(schema.value)),
  visibleFields = computed(() =>
    fields.value.filter((f) => f.label.includes(query.value.trim())),
  );
const invalid = computed(() =>
  draft.value.fields.filter(
    (c) => !fields.value.some((f) => f.id === c.fieldId),
  ),
);
const previewConfig = computed(() => ({ ...copy(draft.value), enabled: true }));
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => open.value,
    () => ({ config: draft.value, aliasText: aliasText.value }),
    () => (open.value = false),
    {
      key: () => `quick-fill:${props.form.id}`,
      title: () => `快捷填报 · ${props.form.title}`,
      context: () => ({
        schema: schema.value,
        original: props.form.extensions?.quickFill || null,
        member: store.data.organization.currentUserId,
      }),
      restore: (value) => {
        const restored = restoreQuickFillDraft(value);
        draft.value = restored.config;
        aliasText.value = restored.aliasText;
        errors.value = [];
        query.value = "";
        previewValues.value = {};
        previewOpen.value = false;
        confirmDiscard.value = false;
      },
    },
  );
function edit() {
  draft.value = parseQuickFill(
    copy(props.form.extensions?.quickFill || newQuickFill()),
  );
  aliasText.value = Object.fromEntries(
    draft.value.fields.map((f) => [f.fieldId, f.aliases.join("，")]),
  );
  errors.value = [];
  query.value = "";
  previewValues.value = {};
  open.value = true;
}
function toggle(id: string) {
  const at = draft.value.fields.findIndex((f) => f.fieldId === id);
  if (at >= 0) draft.value.fields.splice(at, 1);
  else if (draft.value.fields.length < 30)
    draft.value.fields.push({ fieldId: id, aliases: [], instruction: "" });
}
function aliases(id: string, event: Event) {
  const f = draft.value.fields.find((f) => f.fieldId === id)!;
  aliasText.value[id] = (event.target as HTMLInputElement).value;
  f.aliases = aliasText.value[id]!.split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function preview() {
  errors.value = quickFillIssues(draft.value, schema.value);
  if (errors.value.length) return;
  previewValues.value = runtimeDefaults(schema.value.fields, store.data);
  previewOpen.value = true;
}
async function save() {
  if (saving.value) return;
  errors.value = draft.value.enabled
    ? quickFillIssues(draft.value, schema.value)
    : [];
  if (errors.value.length) return;
  saving.value = true;
  try {
    if (await store.saveQuickFill(props.form.id, copy(draft.value))) {
      markSaved();
      open.value = false;
      store.notify("快捷填报配置已保存，发布新版本后生效");
    } else
      errors.value = [
        store.storageError || "保存未完成，快捷填报配置已保留，请重试。",
      ];
  } catch {
    errors.value = ["保存失败，快捷填报配置已保留，请重试。"];
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div class="quick-fill-settings">
    <div class="quick-fill-notice">
      <span class="mode-tag">本地规则演示</span>
      <p>
        先把文字整理成可检查的字段值，再由填写者确认回填。当前未接入模型或图片识别。
      </p>
    </div>
    <article class="quick-fill-summary">
      <div>
        <span class="mode-tag">{{
          form.extensions?.quickFill?.enabled
            ? "已配置 · 发布后生效"
            : "尚未启用"
        }}</span>
        <h2>从一段文字开始填表</h2>
        <p>
          {{ form.extensions?.quickFill?.fields.length || 0 }} 个目标字段 ·
          支持检查、更正和覆盖确认
        </p>
      </div>
      <button class="button primary" @click="edit">
        {{ form.extensions?.quickFill ? "编辑快捷填报" : "配置快捷填报" }}
      </button>
    </article>
    <p class="field-hint">
      入口显示在发布表单和成员新增记录的填写页。只使用该版本中允许填写的字段，关闭功能会保留配置。
    </p>
    <BaseDialog
      :open="open"
      :draft-key="draftKey"
      :busy="saving"
      title="AI 快捷填报配置"
      class-name="quick-fill-config-dialog"
      width="1000px"
      @close="!saving && requestClose()"
    >
      <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
        <span>快捷填报配置尚未保存。</span
        ><button class="button" @click="confirmDiscard = false">继续编辑</button
        ><button class="button" @click="discard">放弃修改</button>
      </div>
      <ul v-if="errors.length" class="config-errors" role="alert">
        <li v-for="message in errors" :key="message">{{ message }}</li>
      </ul>
      <label class="quick-fill-check"
        ><input v-model="draft.enabled" type="checkbox" />启用 AI 快捷填报<span
          class="mode-tag"
          >本地规则演示</span
        ></label
      >
      <div class="quick-fill-config-grid">
        <section>
          <h3>1. 选择要填报的字段</h3>
          <p class="field-hint">
            最多 30 个。人员、部门、关联及动态选项合计最多 5 个；图片或附件最多
            1 个。只读、隐藏和明细子表字段不参与提取。
          </p>
          <input
            v-model="query"
            class="quick-fill-search"
            placeholder="搜索字段"
            aria-label="搜索填报字段"
          />
          <p v-if="!fields.length" class="field-hint">
            暂无可填写字段，请先在表单设计中添加；流程表单还需开放发起节点的编辑权限。
          </p>
          <div class="quick-fill-field-list">
            <div
              v-for="field in visibleFields"
              :key="field.id"
              class="quick-fill-config-field"
            >
              <label class="quick-fill-check"
                ><input
                  type="checkbox"
                  :checked="draft.fields.some((c) => c.fieldId === field.id)"
                  :disabled="
                    draft.fields.length >= 30 &&
                    !draft.fields.some((c) => c.fieldId === field.id)
                  "
                  :aria-label="`允许填报${field.label}`"
                  @change="toggle(field.id)"
                /><strong>{{ field.label }}</strong></label
              ><template
                v-for="item in draft.fields.filter(
                  (c) => c.fieldId === field.id,
                )"
                :key="item.fieldId"
                ><label class="config-label"
                  >可识别的别名<input
                    :value="aliasText[item.fieldId] || ''"
                    :aria-label="`${field.label}别名`"
                    placeholder="多个别名用逗号分隔"
                    @input="aliases(field.id, $event)" /></label
                ><label class="config-label"
                  >字段说明<textarea
                    v-model="item.instruction"
                    rows="2"
                    maxlength="1000"
                    :aria-label="`${field.label}填报说明`"
                    placeholder="例如：金额单位为元，不含税"
                  /></label
              ></template>
            </div>
          </div>
          <div v-if="invalid.length" class="config-errors">
            <p>以下字段已删除或不再允许填写，请移除后保存。</p>
            <button
              v-for="item in invalid"
              :key="item.fieldId"
              class="text-button"
              @click="toggle(item.fieldId)"
            >
              移除失效字段 {{ item.fieldId }}
            </button>
          </div>
        </section>
        <aside>
          <h3>2. 输入方式与填报示例</h3>
          <label class="quick-fill-check"
            ><input v-model="draft.allowText" type="checkbox" />文字输入</label
          ><label class="quick-fill-check"
            ><input
              v-model="draft.allowImages"
              type="checkbox"
            />附加图片</label
          >
          <p class="field-hint">
            图片可附在指定字段，当前演示不读取图片内文字。
          </p>
          <label class="config-label"
            >填报示例<textarea
              v-model="draft.example"
              rows="7"
              maxlength="10000"
              placeholder="每行一个字段：&#10;服务名称：设计服务&#10;金额：128.50"
            />
          </label>
          <p class="field-hint">
            本地演示匹配字段名和别名，不执行自然语言说明。字段说明供填写者检查，并保留给后续模型接入。
          </p>
          <button class="button" @click="preview">预览填写效果</button>
          <div
            v-if="Object.keys(previewValues).length"
            class="quick-fill-preview-values"
          >
            <h4>最近预览结果（未提交）</h4>
            <dl>
              <template
                v-for="field in fields.filter((f) =>
                  draft.fields.some((c) => c.fieldId === f.id),
                )"
                :key="field.id"
                ><dt>{{ field.label }}</dt>
                <dd>
                  {{
                    displayValue(field, previewValues[field.id], store.data) ||
                    "空值"
                  }}
                </dd></template
              >
            </dl>
          </div>
        </aside>
      </div>
      <template #footer
        ><div class="quick-fill-config-footer">
          <span class="field-hint quick-fill-footer-hint"
            >{{ draft.fields.length }} / 30 个字段 · 发布新版本后生效</span
          ><button class="button" @click="requestClose">取消</button
          ><button class="button primary" @click="save">保存快捷填报</button>
        </div></template
      >
    </BaseDialog>
    <QuickFillDialog
      :open="previewOpen"
      :config="previewConfig"
      :schema="schema"
      :values="previewValues"
      :form-id="form.id"
      preview
      @close="previewOpen = false"
      @apply="previewValues = $event"
    />
  </div>
</template>
