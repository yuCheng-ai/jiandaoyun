<script setup lang="ts">
import { computed, ref, watch } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import { copy, type FormValues } from "../../../domain/form";
import type { FormRecord } from "../../../domain/workspace";
import {
  defaultCollaboration,
  newTitlePart,
  titleFields,
  collaborationIssues,
  renderDataTitle,
} from "../../../domain/collaboration";
import { sampleValues } from "../../../domain/extensions";
import { useWorkspaceStore } from "../../../stores/workspace";
import SampleEditor from "./SampleEditor.vue";
const props = defineProps<{ form: FormRecord }>();
const store = useWorkspaceStore(),
  errors = ref<string[]>([]),
  sample = ref<FormValues>({});
watch(
  () => props.form,
  (form) => {
    form.extensions ||= { webhooks: [] };
    form.extensions.collaboration ||= defaultCollaboration();
    sample.value = sampleValues(form.schema);
  },
  { immediate: true },
);
const settings = computed(() => props.form.extensions!.collaboration!);
const fields = computed(() => titleFields(props.form.schema));
const preview = computed(() =>
  renderDataTitle(
    settings.value,
    props.form.schema,
    sample.value,
    store.data,
    props.form.title + " · 示例记录",
  ),
);
function add(kind: "text" | "field") {
  settings.value.titleParts.push(newTitlePart(kind));
}
function move(index: number, direction: number) {
  const parts = settings.value.titleParts,
    next = index + direction;
  if (next < 0 || next >= parts.length) return;
  [parts[index], parts[next]] = [parts[next]!, parts[index]!];
}
async function save() {
  errors.value = collaborationIssues(settings.value, props.form.schema);
  if (
    !errors.value.length &&
    (await store.saveCollaboration(props.form.id, copy(settings.value)))
  )
    store.notify("数据协作设置已保存，发布后用于新记录");
}
</script>
<template>
  <div class="submission-settings collaboration-settings">
    <section class="submission-controls">
      <h3>让每条数据都有清晰的名字</h3>
      <label class="config-label"
        >数据标题<select v-model="settings.titleMode">
          <option value="default">默认：第一个有内容的可见字段</option>
          <option value="custom">自定义文字和字段组合</option>
        </select></label
      >
      <template v-if="settings.titleMode === 'custom'">
        <p class="field-hint">
          从上到下拼接标题，可加入空格、分隔符和固定文字；未填写或不可见字段不显示。
        </p>
        <div
          v-for="(part, index) in settings.titleParts"
          :key="part.id"
          class="title-part-row"
        >
          <span class="title-part-kind">{{
            part.kind === "text" ? "文字" : "字段"
          }}</span>
          <input
            v-if="part.kind === 'text'"
            v-model="part.value"
            :aria-label="`标题片段 ${index + 1} 文字`"
            maxlength="200"
            placeholder="例如：合同 · "
          />
          <select
            v-else
            v-model="part.value"
            :aria-label="`标题片段 ${index + 1} 字段`"
          >
            <option value="">选择字段</option>
            <option v-for="f in fields" :key="f.id" :value="f.id">
              {{ f.label }}
            </option>
          </select>
          <div class="title-part-actions">
            <button
              type="button"
              class="icon-button"
              :disabled="index === 0"
              :aria-label="`上移标题片段 ${index + 1}`"
              @click="move(index, -1)"
            >
              <AppIcon name="up" /></button
            ><button
              type="button"
              class="icon-button"
              :disabled="index === settings.titleParts.length - 1"
              :aria-label="`下移标题片段 ${index + 1}`"
              @click="move(index, 1)"
            >
              <AppIcon name="down" /></button
            ><button
              type="button"
              class="icon-button"
              :aria-label="`移除标题片段 ${index + 1}`"
              @click="settings.titleParts.splice(index, 1)"
            >
              <AppIcon name="trash" />
            </button>
          </div>
        </div>
        <div class="title-add-actions">
          <button
            type="button"
            class="text-button"
            :disabled="settings.titleParts.length >= 20"
            @click="add('field')"
          >
            ＋ 添加字段</button
          ><button
            type="button"
            class="text-button"
            :disabled="settings.titleParts.length >= 20"
            @click="add('text')"
          >
            ＋ 添加文字
          </button>
        </div>
      </template>
      <div class="collaboration-inline-setting">
        <h3>减少小修改的来回切换</h3>
        <label class="button-check"
          ><input
            type="checkbox"
            v-model="settings.inlineEdit"
          />启用表格快捷编辑</label
        >
        <p class="field-hint">
          点击列表中可编辑的单元格，直接修改并保存。支持文字、数字、日期、选择、人员、部门、地址和单条关联；明细、附件等仍在完整编辑页处理。
        </p>
        <p class="field-hint">
          仍遵循字段可见/可编辑、必填、唯一性和联动规则。保存前展示实际变更，更新不会重新发起流程。
        </p>
      </div>
      <ul v-if="errors.length" class="config-errors" role="alert">
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>
      <div class="submission-save">
        <span>发布后用于新记录，旧记录保留原版本设置</span
        ><button type="button" class="button primary" @click="save">
          保存协作设置
        </button>
      </div>
    </section>
    <aside class="submission-preview collaboration-preview">
      <span class="eyebrow">数据标题 · 实时预览</span>
      <div class="record-title-example">
        <AppIcon name="document" :size="22" />
        <div>
          <strong>{{ preview }}</strong>
          <p>{{ form.title }} · 示例记录</p>
        </div>
      </div>
      <p class="field-hint">
        标题显示在数据列表、详情和工作台。总长度最多 200
        字；内容为空时使用表单名称和记录编号。
      </p>
      <SampleEditor v-model="sample" :schema="form.schema" :form-id="form.id" />
    </aside>
  </div>
</template>
