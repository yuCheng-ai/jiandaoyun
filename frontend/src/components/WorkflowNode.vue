<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import type { NodeData } from "../domain/workflow";
import AppIcon from "./AppIcon.vue";
defineProps<{
  id: string;
  data: NodeData;
  selected?: boolean;
  active?: boolean;
  readonly?: boolean;
}>();
const emit = defineEmits<{
  add: [id: string, direction: "before" | "after", event: MouseEvent];
}>();
let pointer = { x: 0, y: 0 };
function requestAdd(
  id: string,
  direction: "before" | "after",
  event: MouseEvent,
) {
  if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6)
    emit("add", id, direction, event);
}
</script>
<template>
  <div
    class="workflow-node"
    :class="[
      data.kind,
      {
        'is-selected': selected,
        'is-active': active,
        'is-terminal': ['start', 'end'].includes(data.kind),
      },
    ]"
    :title="data.label"
  >
    <Handle
      v-if="data.kind !== 'start'"
      id="top"
      type="target"
      :position="Position.Top"
      :connectable="!readonly"
      class="node-handle top"
      @mousedown="pointer = { x: $event.clientX, y: $event.clientY }"
      @click.stop="!readonly && requestAdd(id, 'before', $event)"
      ><AppIcon v-if="!readonly" name="add" :size="12"
    /></Handle>
    <AppIcon
      :name="data.kind"
      :size="data.kind === 'start' || data.kind === 'end' ? 19 : 18"
    />
    <span class="node-label">{{ data.label || "未命名节点" }}</span>
    <span v-if="data.timeout" class="node-time" title="已设置限时处理"
      ><AppIcon name="time" :size="13"
    /></span>
    <Handle
      v-if="data.kind !== 'end'"
      id="bottom"
      type="source"
      :position="Position.Bottom"
      :connectable="!readonly"
      class="node-handle bottom"
      @mousedown="pointer = { x: $event.clientX, y: $event.clientY }"
      @click.stop="!readonly && requestAdd(id, 'after', $event)"
      ><AppIcon v-if="!readonly" name="add" :size="12"
    /></Handle>
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
        @mousedown="pointer = { x: $event.clientX, y: $event.clientY }"
        @click.stop="!readonly && requestAdd(id, 'after', $event)"
        ><AppIcon v-if="!readonly" name="add" :size="12"
      /></Handle>
    </template>
  </div>
</template>
