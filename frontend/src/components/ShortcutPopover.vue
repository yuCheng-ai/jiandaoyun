<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
defineProps<{ modifier: string; left: number; top: number }>();
</script>

<template>
  <section
    id="shortcut-popover"
    class="shortcut-popover"
    role="region"
    aria-label="画布快捷键"
    :style="{ left: `${left}px`, top: `${top}px` }"
    @click.stop
  >
    <div class="shortcut-column">
      <div class="shortcut-section">
        <h3>选中节点/连接线时</h3>
        <div class="shortcut-row">
          <span>取消选中</span><span class="shortcut-keys"><kbd>Esc</kbd></span>
        </div>
        <div class="shortcut-row">
          <span>删除</span><span class="shortcut-keys"><kbd>Delete</kbd></span>
        </div>
        <div class="shortcut-row">
          <span>复制</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>C</kbd></span
          >
        </div>
        <div class="shortcut-row">
          <span>粘贴</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>V</kbd></span
          >
        </div>
      </div>
      <div class="shortcut-section">
        <h3>移动画布</h3>
        <div class="shortcut-row">
          <span>移动</span
          ><span class="shortcut-keys"
            ><kbd>Space</kbd
            ><kbd aria-label="鼠标拖动" title="按住空格并拖动鼠标"
              ><AppIcon name="hand" :size="12" /></kbd
          ></span>
        </div>
      </div>
    </div>
    <div class="shortcut-column">
      <div class="shortcut-section">
        <h3>撤销/重做</h3>
        <div class="shortcut-row">
          <span>撤销</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>Z</kbd></span
          >
        </div>
        <div class="shortcut-row">
          <span>重做</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>Y</kbd></span
          >
        </div>
      </div>
      <div class="shortcut-section">
        <h3>缩放画布</h3>
        <div class="shortcut-row">
          <span>放大</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>鼠标滚轮</kbd><span class="key-alternative">/</span
            ><kbd>{{ modifier }}</kbd
            ><kbd>+</kbd></span
          >
        </div>
        <div class="shortcut-row">
          <span>缩小</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>鼠标滚轮</kbd><span class="key-alternative">/</span
            ><kbd>{{ modifier }}</kbd
            ><kbd>-</kbd></span
          >
        </div>
        <div class="shortcut-row">
          <span>自适应</span
          ><span class="shortcut-keys"
            ><kbd>{{ modifier }}</kbd
            ><kbd>0</kbd></span
          >
        </div>
      </div>
    </div>
  </section>
</template>
