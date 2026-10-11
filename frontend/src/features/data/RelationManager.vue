<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { DefinitionSummary, RelationDefinition } from "@platform/contracts";
import { platformApi } from "../../repositories/platformApi";
import RelationEditor from "./RelationEditor.vue";
import "./relations.css";
const props = defineProps<{ sourceId: string; objects: DefinitionSummary[] }>();
const relations = ref<RelationDefinition[]>([]), editing = ref(false), selected = ref<RelationDefinition>(), busy = ref(false), error = ref("");
async function load() {
  busy.value = true; error.value = "";
  try { relations.value = await platformApi<RelationDefinition[]>(`/relations?definitionId=${props.sourceId}`); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <section class="relation-manager"><div class="collab-toolbar"><div><h3>数据关系</h3><p class="collab-help">在记录之间建立关联，按需要展示目标数据或回填字段。</p></div><button class="button" :disabled="busy || !objects.find(o => o.id === sourceId)?.latestVersion" @click="selected = undefined; editing = true">新建关系</button></div>
    <p v-if="error" class="collab-error" role="alert">{{ error }} <button class="text-button" @click="load">重试</button></p><p v-if="busy" role="status">正在读取关系…</p>
    <div class="collab-table-wrap"><table v-if="relations.length" class="collab-table"><thead><tr><th>关系名称</th><th>来源 → 目标</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="relation in relations" :key="relation.id"><td>{{ relation.spec.title }}</td><td>{{ objects.find(o => o.id === relation.spec.sourceDefinitionId)?.title || '其他应用数据' }} → {{ objects.find(o => o.id === relation.spec.targetDefinitionId)?.title || '其他应用数据' }}</td><td>{{ relation.latestVersion ? `已发布 V${relation.latestVersion}${relation.hasDraftChanges ? ' · 有未发布修改' : ''}` : '草稿' }}</td><td><button class="text-button" @click="selected = relation; editing = true">配置关系</button></td></tr></tbody></table></div>
    <p v-if="!busy && !relations.length" class="collab-help">暂无关系。先发布来源和目标数据对象，再配置关联。</p>
    <RelationEditor v-if="editing" :source-id="sourceId" :objects="objects" :relation="selected" @close="editing = false; load()" @saved="editing = false; load()" />
  </section>
</template>
