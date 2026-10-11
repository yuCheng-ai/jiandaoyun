<script setup lang="ts">
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { computed } from "vue";
import {
  flattenFields,
  type FormSchema,
  type FormValues,
} from "../../../domain/form";
import {
  buildRecordBlocks,
  type DetailSettings,
} from "../../../domain/presentation";
import RelationControl from "./RelationControl.vue";
import FileFieldControl from "./FileFieldControl.vue";
import RichTextEditor from "./RichTextEditor.vue";
const props = defineProps<{
  schema: FormSchema;
  values: FormValues;
  settings: DetailSettings;
  entryId?: string;
  interactive?: boolean;
}>();
const runtimeData = useRuntimeData();
const blocks = computed(() =>
  buildRecordBlocks(
    props.schema,
    props.values,
    props.settings,
    runtimeData.value,
    props.entryId,
  ),
);
const fields = computed(() =>
  Object.fromEntries(flattenFields(props.schema.fields).map((f) => [f.id, f])),
);
</script>
<template>
  <div class="record-body" :style="{ '--record-columns': settings.columns }">
    <section
      v-for="block in blocks"
      :key="block.id"
      class="record-block"
      :class="{ wide: block.rows || block.images.length }"
    >
      <h4>{{ block.label }}</h4>
      <RichTextEditor
        v-if="fields[block.id]?.type === 'richtext'"
        :model-value="String(values[block.id] || '')"
        :label="block.label"
        variant="field"
        readonly
      />
      <FileFieldControl
        v-else-if="interactive && block.files"
        :field="(fields[block.id] || block.sourceField)!"
        :model-value="block.files"
        disabled
      />
      <RelationControl
        :fields="schema.fields"
        v-else-if="
          interactive &&
          ['query', 'relation', 'relationTable'].includes(
            fields[block.id]?.type || '',
          )
        "
        :field="fields[block.id]!"
        :label="block.label"
        :model-value="values[block.id]"
        :values="values"
        :entry-id="entryId"
        disabled
      />
      <div
        v-else-if="block.rows && block.headers?.length"
        class="record-table-scroll"
      >
        <table class="record-subtable">
          <thead>
            <tr>
              <th v-for="(label, index) in block.headers" :key="index">
                {{ label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in block.rows" :key="index">
              <td v-for="(cell, col) in row" :key="col">
                <FileFieldControl
                  v-if="interactive && block.rowFiles?.[index]?.[col]"
                  :field="
                    (fields[block.columnIds![col]!] ||
                      block.columnFields?.[col])!
                  "
                  :model-value="block.rowFiles[index]![col]"
                  disabled
                /><template v-else>
                  {{ cell }}
                  <div
                    v-if="block.rowImages?.[index]?.[col]?.length"
                    class="record-images"
                  >
                    <img
                      v-for="(src, imageIndex) in block.rowImages[index]![col]"
                      :key="imageIndex"
                      :src="src"
                      :alt="block.headers?.[col]"
                    />
                  </div>
                </template>
              </td>
            </tr>
            <tr v-if="!block.rows.length">
              <td :colspan="block.headers.length">暂无明细</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else>{{ block.text }}</p>
      <div
        v-if="block.images.length && !(interactive && block.files)"
        class="record-images"
      >
        <img
          v-for="(src, index) in block.images"
          :key="index"
          :src="src"
          :alt="block.label"
        />
      </div>
    </section>
    <p v-if="!blocks.length" class="field-hint">没有可展示的字段。</p>
  </div>
</template>
