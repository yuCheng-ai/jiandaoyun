<script setup lang="ts">
import { ref, computed } from "vue";
import FieldPermissionEditor from "./FieldPermissionEditor.vue";
import FlowSettingsPanel from "./FlowSettingsPanel.vue";
import AppIcon from "./AppIcon.vue";
import { pluginRegistry } from "../domain/extensions";
import { useWorkspaceStore } from "../stores/workspace";
import { identityLabel, resolveIdentities } from "../domain/organization";
const workspace = useWorkspaceStore();
import {
  reaches,
  type FlowNode,
  type FlowDocument,
  type NodeData,
} from "../domain/workflow";
const props = defineProps<{
  node?: FlowNode;
  document: FlowDocument;
  tab: string;
}>();
const emit = defineEmits<{
  "update:tab": [tab: string];
  update: [patch: Partial<NodeData>];
  members: [];
  timeout: [];
  export: [];
  import: [];
  plugin: [];
}>();
const detailTab = ref("rules");
const disconnected = computed(() => {
  const start = props.document.nodes.find((n) => n.data.kind === "start");
  const end = props.document.nodes.find((n) => n.data.kind === "end");
  return (
    props.node &&
    start &&
    end &&
    (!reaches(start.id, props.node.id, props.document.edges) ||
      !reaches(props.node.id, end.id, props.document.edges))
  );
});
const actionOptions = computed(() =>
  props.node?.data.kind === "start"
    ? ["提交", "保存草稿", "暂存", "提交并打印", "结束流程"]
    : ["同意", "退回", "转交", "加签", "评论", "暂存", "结束流程"],
);
const detailTabs = [
  { id: "fields", label: "字段权限" },
  { id: "actions", label: "节点操作" },
  { id: "rules", label: "流转规则" },
];
function value(event: Event) {
  return (event.target as HTMLInputElement).value;
}
function toggleAction(action: string) {
  if (!props.node) return;
  const current = props.node.data.actions;
  emit("update", {
    actions: current.includes(action)
      ? current.filter((a) => a !== action)
      : [...current, action],
  });
}
</script>
<template>
  <aside class="property-panel" aria-label="属性配置">
    <div class="property-tabs" role="tablist" aria-label="属性类型">
      <button
        v-for="item in [
          { id: 'node', label: '节点属性' },
          { id: 'flow', label: '流程属性' },
        ]"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :class="{ active: tab === item.id }"
        @click="emit('update:tab', item.id)"
      >
        {{ item.label }}
      </button>
    </div>
    <div v-if="tab === 'node' && node" class="property-content" :key="node.id">
      <div v-if="disconnected" class="connection-warning">节点尚未正确连接</div>
      <div v-if="node.data.kind !== 'end'" class="form-group node-name-group">
        <div class="label-line">
          <label for="node-name"><span class="required">*</span>节点名称</label
          ><span class="node-id"
            >节点ID：{{
              node.id === "start" ? "0" : node.id === "end" ? "结束" : node.id
            }}</span
          >
        </div>
        <input
          id="node-name"
          :value="node.data.label"
          maxlength="40"
          @input="emit('update', { label: value($event) })"
        />
      </div>
      <template v-if="['approval', 'copy'].includes(node.data.kind)">
        <div class="form-group owner-group">
          <label for="owner-mode"
            ><span class="required">*</span
            >{{ node.data.kind === "copy" ? "抄送成员" : "节点负责人" }}
            <AppIcon
              name="help"
              class="muted-icon"
              :size="14"
              title="指定负责处理当前节点的成员或部门"
          /></label>
          <div class="select-wrap">
            <select
              id="owner-mode"
              :value="node.data.ownerMode"
              @change="emit('update', { ownerMode: value($event) })"
            >
              <option value="regular">常规审批</option>
              <option value="initiator">发起人本人</option>
              <option value="manager">发起人部门主管</option></select
            ><AppIcon name="down" />
          </div>
          <button
            v-if="node.data.ownerMode === 'regular'"
            class="member-picker"
            @click="emit('members')"
          >
            <template v-if="node.data.members.length"
              ><span
                v-for="id in node.data.members"
                :key="id"
                class="member-chip"
                ><AppIcon name="approval" :size="12" />{{
                  identityLabel(workspace.data.organization, id)
                }}</span
              ><AppIcon name="add" :size="16" /></template
            ><template v-else
              ><AppIcon name="add" :size="17" />选择成员或部门</template
            >
          </button>
          <p
            v-if="node.data.ownerMode === 'regular' && node.data.members.length"
            class="field-hint"
          >
            当前包含
            {{
              resolveIdentities(workspace.data.organization, node.data.members)
                .length
            }}
            位在职成员
          </p>
          <p v-if="node.data.ownerMode !== 'regular'" class="field-hint">
            {{
              node.data.ownerMode === "initiator"
                ? "由提交申请的发起人处理"
                : "由发起人所在部门的主管处理"
            }}
          </p>
          <label v-if="node.data.kind === 'approval'" class="checkbox-line"
            ><input
              type="checkbox"
              :checked="node.data.copyEnabled"
              @change="
                emit('update', { copyEnabled: !node.data.copyEnabled })
              " />启用抄送
            <AppIcon
              name="help"
              class="muted-icon"
              :size="14"
              title="完成节点时同时通知所选成员"
          /></label>
        </div>
        <div class="ai-banner">
          <span
            ><AppIcon name="ai" :size="18" /> <strong>AI 流程助手</strong
            ><small>Beta</small></span
          ><button
            class="switch"
            :class="{ on: node.data.aiEnabled }"
            role="switch"
            :aria-checked="node.data.aiEnabled"
            aria-label="AI 流程助手"
            @click="emit('update', { aiEnabled: !node.data.aiEnabled })"
          >
            <span />
          </button>
        </div>
        <div v-if="node.data.aiEnabled" class="helper-note">
          配置建议：{{
            !resolveIdentities(workspace.data.organization, node.data.members)
              .length
              ? "请先指定负责人，避免流程中断。"
              : "可开启限时提醒，帮助负责人及时处理。"
          }}<small>当前为本地规则建议。</small>
        </div>
      </template>
      <template v-if="['approval', 'copy', 'start'].includes(node.data.kind)">
        <div class="segmented detail-tabs" role="tablist" aria-label="节点配置">
          <button
            v-for="item in detailTabs"
            :key="item.id"
            role="tab"
            :aria-selected="detailTab === item.id"
            :class="{ active: detailTab === item.id }"
            @click="detailTab = item.id"
          >
            {{ item.label }}
          </button>
        </div>
        <template v-if="detailTab === 'rules'">
          <div class="form-group">
            <label for="submit-rule">节点提交条件</label>
            <div class="select-wrap">
              <select
                id="submit-rule"
                :value="node.data.submitRule"
                @change="emit('update', { submitRule: value($event) })"
              >
                <option value="all">所有数据均可提交</option>
                <option value="required">
                  必填字段填写完整后可提交
                </option></select
              ><AppIcon name="down" />
            </div>
          </div>
          <template v-if="node.data.kind !== 'start'">
            <div class="form-group">
              <label for="multi-rule">有多位负责人时</label>
              <div class="select-wrap">
                <select
                  id="multi-rule"
                  :value="node.data.multiRule"
                  @change="emit('update', { multiRule: value($event) })"
                >
                  <option value="any">任意负责人提交后进入下一节点</option>
                  <option value="all">所有负责人提交后进入下一节点</option>
                  <option value="sequential">
                    按负责人顺序依次审批
                  </option></select
                ><AppIcon name="down" />
              </div>
            </div>
            <div class="form-group">
              <label for="missing-rule">找不到节点负责人时</label>
              <div class="select-wrap">
                <select
                  id="missing-rule"
                  :value="node.data.missingRule"
                  @change="emit('update', { missingRule: value($event) })"
                >
                  <option value="stop">停止流转并报错</option>
                  <option value="skip">自动通过，进入下一节点</option>
                  <option value="admin">转交给流程管理员</option></select
                ><AppIcon name="down" />
              </div>
            </div>
            <div class="form-group timeout-group">
              <label
                >节点限时处理
                <AppIcon
                  name="help"
                  class="muted-icon"
                  :size="14"
                  title="设置节点处理时限及超时动作" /></label
              ><button class="button full-width" @click="emit('timeout')">
                {{
                  node.data.timeout
                    ? `${node.data.timeout} 小时后${node.data.timeoutAction === "remind" ? "提醒负责人" : "自动通过"}`
                    : "设置限时处理"
                }}
              </button>
            </div>
          </template>
        </template>
        <template v-else-if="detailTab === 'fields'">
          <FieldPermissionEditor
            :data="node.data"
            :form-fields="document.formFields"
            @update="emit('update', $event)"
          />
        </template>
        <template v-else>
          <label class="standalone-label">节点操作</label>
          <div class="node-action-list">
            <div
              v-for="action in actionOptions"
              :key="action"
              class="node-action-row"
            >
              <span>{{ action }}</span
              ><button
                class="switch compact-switch"
                :class="{
                  on: node.data.actions.includes(action) || action === '提交',
                }"
                role="switch"
                :aria-label="action"
                :aria-checked="
                  node.data.actions.includes(action) || action === '提交'
                "
                :disabled="action === '提交'"
                @click="toggleAction(action)"
              >
                <span />
              </button>
            </div>
          </div>
        </template>
      </template>
      <template v-else-if="node.data.kind === 'condition'"
        ><div class="form-group">
          <label for="condition-field">比较字段</label>
          <div class="select-wrap">
            <select
              id="condition-field"
              :value="node.data.conditionFieldId"
              @change="emit('update', { conditionFieldId: value($event) })"
            >
              <option value="">申请金额（默认）</option>
              <option
                v-for="field in document.formFields"
                :key="field.id"
                :value="field.id"
              >
                {{ field.label }}
              </option></select
            ><AppIcon name="down" />
          </div>
          <label for="condition-value">分支条件</label
          ><input
            id="condition-value"
            :value="node.data.condition"
            @input="emit('update', { condition: value($event) })"
          />
          <p class="field-hint">
            所选字段按数值比较，例如：申请金额 &gt;
            5000。满足条件进入第一分支，其他情况进入默认分支。
          </p>
        </div></template
      >
      <template v-else-if="node.data.kind === 'subflow'"
        ><div class="form-group">
          <label for="subflow">选择子流程</label>
          <div class="select-wrap">
            <select
              id="subflow"
              :value="node.data.subflow"
              @change="emit('update', { subflow: value($event) })"
            >
              <option value="">请选择子流程</option>
              <option value="expense">费用报销流程</option>
              <option value="purchase">采购申请流程</option>
              <option value="contract">合同审批流程</option></select
            ><AppIcon name="down" />
          </div>
          <p class="field-hint">主流程将等待子流程完成后继续。</p>
        </div></template
      >
      <template v-else-if="node.data.kind === 'plugin'"
        ><div class="form-group">
          <label>执行动作</label>
          <div class="plugin-summary">
            <AppIcon name="plugin" :size="24" /><strong>{{
              pluginRegistry.find((p) => p.id === node?.data.plugin)?.name ||
              "尚未选择动作"
            }}</strong>
            <p>
              {{
                pluginRegistry.find((p) => p.id === node?.data.plugin)
                  ?.description || "选择动作，绑定输入参数与返回结果。"
              }}
            </p>
            <span
              >{{
                node.data.pluginConfig?.outputs.length || 0
              }}
              个回填字段</span
            >
          </div>
          <button class="button primary full-width" @click="emit('plugin')">
            配置与试运行
          </button>
          <p class="field-hint">
            插件成功后继续流转，失败则停留在此节点。外部动作使用本地模拟。
          </p>
        </div></template
      >
      <template v-else
        ><div class="terminal-info">
          <AppIcon
            :name="node.data.kind"
            :size="32"
            :class="node.data.kind"
          /><strong>{{
            node.data.kind === "start" ? "流程从这里开始" : "流程在这里结束"
          }}</strong>
          <p>
            {{
              node.data.kind === "start"
                ? "提交表单后，将按连线顺序进入后续节点。"
                : "所有审批完成后，申请进入已完成状态。"
            }}
          </p>
        </div>
        <button class="button full-width" @click="emit('update:tab', 'flow')">
          设置流程属性
        </button></template
      >
    </div>
    <div v-else-if="tab === 'node'" class="empty-properties">
      <AppIcon name="locate" :size="28" />
      <p>选择节点以编辑属性</p>
    </div>
    <div v-else class="property-content flow-properties">
      <FlowSettingsPanel :document="document" />
      <details class="flow-extra">
        <summary>流程信息与配置文件</summary>
        <div class="form-group">
          <label for="flow-title">流程名称</label
          ><input id="flow-title" v-model="document.title" maxlength="60" />
        </div>
        <div class="form-group">
          <label for="flow-description">流程说明</label
          ><textarea
            id="flow-description"
            v-model="document.description"
            rows="4"
            placeholder="简要描述此流程的用途"
          />
        </div>
        <div class="flow-summary">
          <span
            >当前版本<strong>V{{ document.version }}</strong></span
          ><span
            >流程节点<strong>{{ document.nodes.length }} 个</strong></span
          ><span
            >流程状态<strong :class="{ teal: document.enabled }">{{
              document.enabled ? "已启用" : "草稿"
            }}</strong></span
          >
        </div>
        <div class="data-actions">
          <button class="button" @click="emit('export')">
            <AppIcon name="export" />导出 JSON</button
          ><button class="button" @click="emit('import')">
            <AppIcon name="import" />导入 JSON
          </button>
        </div>
      </details>
    </div>
  </aside>
</template>
