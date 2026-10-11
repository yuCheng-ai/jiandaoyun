<script setup lang="ts">
import { computed, ref } from "vue";
import type { FormRecord } from "../../../domain/workspace";
import { copy, uid } from "../../../domain/form";
import {
  printTemplateIssues,
  expandedPrintFieldIds,
  type PrintTemplate,
} from "../../../domain/presentation";
import { useWorkspaceStore } from "../../../stores/workspace";
import AppIcon from "../../../components/AppIcon.vue";
import PrintTemplateEditor from "./PrintTemplateEditor.vue";
const props = defineProps<{ form: FormRecord; query: string }>();
const store = useWorkspaceStore(),
  archived = ref(false),
  open = ref(false),
  editing = ref<PrintTemplate>();
const templates = computed(() =>
  (props.form.extensions?.printTemplates || []).filter(
    (t) => t.archived === archived.value && t.name.includes(props.query),
  ),
);
function edit(t?: PrintTemplate) {
  editing.value = t;
  open.value = true;
}
function duplicate(t: PrintTemplate) {
  const next = copy(t);
  next.id = uid("print");
  next.name += " 副本";
  edit(next);
}
async function archive(t: PrintTemplate) {
  if (
    await store.savePrintTemplate(props.form.id, {
      ...copy(t),
      archived: !t.archived,
    })
  )
    store.notify(
      t.archived
        ? "模板已恢复，发布后生效"
        : "模板已归档，历史发布版本不受影响",
    );
}
</script>
<template>
  <div>
    <div class="extension-list-tools">
      <span>{{ templates.length }} 个模板</span
      ><label><input type="checkbox" v-model="archived" />查看已归档模板</label
      ><button class="button primary" @click="edit()">
        <AppIcon name="add" />新建打印模板
      </button>
    </div>
    <div v-if="!templates.length" class="extension-empty">
      <AppIcon name="print" :size="40" />
      <h2>
        {{
          archived
            ? "没有归档模板"
            : query
              ? "没有匹配的模板"
              : "把业务记录变成清晰的单据"
        }}
      </h2>
      <p>选择字段、调整顺序和纸张。在数据详情中预览打印，或另存为 PDF。</p>
      <button v-if="!archived && !query" class="button" @click="edit()">
        创建第一个打印模板
      </button>
    </div>
    <div class="push-config-list">
      <article v-for="t in templates" :key="t.id" class="push-config-card">
        <div class="config-card-title">
          <AppIcon name="print" :size="24" />
          <div>
            <h3>{{ t.name }}</h3>
            <p>
              {{ t.paper }} ·
              {{ t.orientation === "portrait" ? "纵向" : "横向" }} ·
              {{
                t.fieldMode === "all"
                  ? "全部字段"
                  : `${expandedPrintFieldIds(form.schema, t.fieldIds).length} 个字段`
              }}
            </p>
          </div>
          <span class="mode-tag">{{ t.archived ? "已归档" : "本地打印" }}</span>
        </div>
        <p
          v-if="printTemplateIssues(t, form.schema, store.data).length"
          class="config-warning"
        >
          {{ printTemplateIssues(t, form.schema, store.data)[0] }}
        </p>
        <div class="config-card-footer">
          <span>{{ t.title || form.title }}</span
          ><button class="text-button" @click="edit(t)">编辑与预览</button
          ><button v-if="!t.archived" class="text-button" @click="duplicate(t)">
            复制模板</button
          ><button class="text-button" @click="archive(t)">
            {{ t.archived ? "恢复模板" : "归档模板" }}
          </button>
        </div>
      </article>
    </div>
    <PrintTemplateEditor
      :open="open"
      :model-value="editing"
      :schema="form.schema"
      :title="form.title"
      :form-id="form.id"
      @close="open = false"
    />
  </div>
</template>
