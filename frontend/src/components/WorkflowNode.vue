<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";

import AppIcon from "./AppIcon.vue";
defineProps<{
  id: string;
  data: {
    kind: "start" | "end" | "approval" | "copy";
    label: string;
    owner?: string;
  };
  selected?: boolean;
  readonly?: boolean;
}>();
</script>
<template>
  <div
    class="workflow-node"
    :class="[
      data.kind,
      {
        'is-selected': selected,
        'is-terminal': ['start', 'end'].includes(data.kind),
      },
    ]"
    :title="data.owner ? `${data.label} · ${data.owner}` : data.label"
  >
    <Handle
      v-if="data.kind !== 'start'"
      id="top"
      type="target"
      :position="Position.Top"
      :connectable="!readonly"
      class="node-handle top"
    />
    <AppIcon
      :name="data.kind"
      :size="data.kind === 'start' || data.kind === 'end' ? 19 : 18"
    />
    <span class="node-label">{{ data.label || "未命名节点" }}</span>
    <Handle
      v-if="data.kind !== 'end'"
      id="bottom"
      type="source"
      :position="Position.Bottom"
      :connectable="!readonly"
      class="node-handle bottom"
    />
    <template v-if="!['start', 'end'].includes(data.kind)">
      <Handle
        v-for="side in ['left', 'right'] as const"
        :id="side"
        :key="side"
        type="source"
        :position="side === 'left' ? Position.Left : Position.Right"
        :connectable="!readonly"
        class="node-handle"
        :class="side"
      />
    </template>
  </div>
</template>
