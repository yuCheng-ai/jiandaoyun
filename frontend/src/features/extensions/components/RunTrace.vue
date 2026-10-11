<script setup lang="ts">
import { computed } from "vue";
import type { AutomationChange } from "../../../domain/automation";
import AppIcon from "../../../components/AppIcon.vue";
import type { ConfigIssue, ExtensionRun } from "../../../domain/extensions";
import type { FormField } from "../../../domain/form";
const props = defineProps<{ run: ExtensionRun; fields?: FormField[] }>();
const changes = computed(() =>
  props.run.kind === "automation" && Array.isArray(props.run.output.changes)
    ? (props.run.output.changes as AutomationChange[])
    : [],
);
const emit = defineEmits<{ locate: [issue: ConfigIssue] }>();
</script>
<template>
  <section class="run-trace" aria-label="执行结果" aria-live="polite">
    <div class="run-result" :class="run.status">
      <AppIcon
        :name="
          run.status === 'failed'
            ? 'warning'
            : run.status === 'skipped'
              ? 'info'
              : 'success'
        "
        :size="23"
      />
      <div>
        <strong>{{
          run.status === "failed"
            ? "执行停在这里"
            : run.status === "skipped"
              ? "未触发本次动作"
              : run.origin !== "trial"
                ? "执行完成"
                : "试运行完成"
        }}</strong>
        <p>
          {{
            run.mode === "simulation"
              ? "模拟外部响应 · 未发送网络请求或消息"
              : run.origin === "record"
                ? run.kind === "automation"
                  ? run.output.committed
                    ? "本地记录已整组保存"
                    : "本助手未写入目标记录"
                  : "本地运算 · 结果已用于当前记录流转"
                : "本地运算 · 未修改原始记录"
          }}
        </p>
      </div>
    </div>
    <ol class="trace-steps">
      <li v-for="(step, index) in run.steps" :key="index" :class="step.status">
        <AppIcon
          :name="
            step.status === 'failed'
              ? 'warning'
              : step.status === 'skipped'
                ? 'minus'
                : 'check'
          "
        />
        <div>
          <strong>{{ step.label }}</strong>
          <p>{{ step.detail }}</p>
        </div>
      </li>
    </ol>
    <button v-if="run.error" class="button" @click="emit('locate', run.error)">
      <AppIcon name="locate" />定位并检查配置
    </button>
    <div v-if="changes.length" class="automation-diffs">
      <h4>
        {{ run.output.committed ? "已应用的变更" : "预计变更 · 未写入" }}（{{
          changes.length
        }}
        次）
      </h4>
      <details
        v-for="(change, index) in changes"
        :key="`${change.stepId}-${change.entryId}`"
        :open="index < 3"
      >
        <summary>
          {{ index + 1 }}. {{ change.formTitle }} · V{{ change.version }} ·
          {{ change.action === "create" ? "新增记录" : "更新记录" }}
        </summary>
        <div class="button-change-list">
          <div v-for="field in change.fields" :key="field.id">
            <strong>{{ field.label }}</strong
            ><span
              >{{ field.before || "（空）" }} →
              {{ field.after || "（空）" }}</span
            >
          </div>
        </div>
      </details>
    </div>
    <details :open="run.status === 'success' && run.kind !== 'automation'">
      <summary>输入与输出</summary>
      <div class="trace-json">
        <div>
          <h4>输入</h4>
          <pre>{{ JSON.stringify(run.input, null, 2) }}</pre>
        </div>
        <div>
          <h4>输出</h4>
          <pre>{{ JSON.stringify(run.output, null, 2) }}</pre>
        </div>
      </div>
    </details>
    <div v-if="Object.keys(run.mappedValues).length" class="mapping-result">
      <h4>{{ run.origin === "record" ? "回填结果" : "预计回填" }}</h4>
      <div v-for="(value, id) in run.mappedValues" :key="id">
        <span>{{ fields?.find((f) => f.id === id)?.label || id }}</span
        ><strong>{{ value }}</strong>
      </div>
    </div>
  </section>
</template>
