<script setup lang="ts">
import { computed } from "vue";
import {
  dividerColors,
  formDividerStyles,
  type FormField,
} from "@platform/contracts";
import "./form-divider-source.css";
const props = defineProps<{ field: FormField }>();
const colors = computed(() => dividerColors(props.field));
const style = computed(() =>
  props.field.dividerStyle &&
  formDividerStyles.includes(props.field.dividerStyle)
    ? props.field.dividerStyle
    : undefined,
);
const separateTitle = computed(
  () =>
    style.value &&
    ["none", "dashed", "thin", "thick", "style2"].includes(style.value),
);
</script>
<template>
  <div
    class="runtime-divider"
    :class="{
      'legacy-divider': !style,
      'form-divider-source': !!style,
      'without-label': !field.showLabel,
    }"
    :style="{
      '--divider-color': colors.color,
      '--divider-title-color': colors.titleColor,
    }"
  >
    <template v-if="field.showLabel">
      <span v-if="!style">{{ field.label }}</span>
      <template v-else>
        <div v-if="separateTitle" class="divider-separate-title">
          {{ field.label }}
        </div>
        <div class="sep-line" :class="style">
          <template v-if="style === 'style1'">
            <span class="sep-label divider-fill">{{ field.label }}</span>
            <div class="sep-right" aria-hidden="true">
              <div class="right-triangle divider-fill" />
              <div
                v-for="i in 3"
                :key="i"
                :class="`right-parallelogram${i}`"
                class="divider-fill"
              />
              <div class="right-line" />
            </div>
          </template>
          <template v-else-if="style === 'style2' || style === 'style3'">
            <div class="sep-bg-wrapper" aria-hidden="true">
              <div
                class="sep-bg"
                :class="{ 'divider-fill': style === 'style3' }"
              />
            </div>
            <span class="sep-label divider-fill"
              ><span :aria-hidden="style === 'style2' ? true : undefined">{{
                field.label
              }}</span></span
            >
          </template>
          <template v-else-if="style === 'style4'">
            <div class="sep-bg divider-fill" aria-hidden="true" />
            <div class="sep-center">
              <template v-for="side in ['left', 'right']" :key="side"
                ><div
                  class="top-bar divider-fill"
                  :class="`${side}-bar`"
                  aria-hidden="true" />
                <div
                  class="curve divider-fill"
                  :class="`${side}-curve`"
                  aria-hidden="true"
              /></template>
              <span class="sep-label divider-fill">{{ field.label }}</span>
            </div>
          </template>
          <template v-else-if="style === 'style5'">
            <div class="left-wrapper" aria-hidden="true">
              <div class="left-block divider-fill" />
              <div class="left-triangle divider-fill" />
              <div class="left-square" />
              <div class="left-line1" />
              <div class="left-line2" />
            </div>
            <span class="sep-label divider-fill">{{ field.label }}</span>
            <div class="right-wrapper" aria-hidden="true">
              <div class="right-block divider-fill" />
              <div class="right-triangle divider-fill" />
              <div class="right-square" />
              <div class="right-line1" />
              <div class="right-line2" />
            </div>
          </template>
          <template v-else-if="style === 'style6'"
            ><div class="left-bar divider-fill" aria-hidden="true" />
            <span class="sep-label">{{ field.label }}</span></template
          >
          <template v-else-if="style === 'style7'"
            ><div class="parallelogram p1 divider-fill" aria-hidden="true" />
            <div class="parallelogram p2 divider-fill" aria-hidden="true" />
            <span class="sep-label">{{ field.label }}</span></template
          >
          <template v-else-if="style === 'style8'">
            <div class="main">
              <div class="arrow" aria-hidden="true" />
              <div class="arrow small-arrow" aria-hidden="true" />
              <span class="sep-label">{{ field.label }}</span>
            </div>
            <div class="footer" aria-hidden="true">
              <div class="line divider-fill" />
              <div
                v-for="i in 5"
                :key="i"
                class="parallelogram divider-fill"
                :class="`right${i}`"
              />
            </div>
          </template>
          <template v-else-if="style === 'style9'">
            <div class="divider-chevron" aria-hidden="true">
              <div
                v-for="half in ['top', 'bottom']"
                :key="half"
                class="group"
                :class="`${half}-left`"
              >
                <div
                  v-for="i in 4"
                  :key="i"
                  class="parallelogram divider-fill"
                  :class="`p${i}`"
                />
              </div>
            </div>
            <span class="sep-label">{{ field.label }}</span>
            <div class="divider-chevron" aria-hidden="true">
              <div
                v-for="half in ['top', 'bottom']"
                :key="half"
                class="group"
                :class="`${half}-right`"
              >
                <div
                  v-for="i in 4"
                  :key="i"
                  class="parallelogram divider-fill"
                  :class="`p${i}`"
                />
              </div>
            </div>
          </template>
        </div>
      </template>
    </template>
  </div>
</template>
<style scoped>
.form-divider-source {
  container-type: inline-size;
  min-width: 0;
  min-height: 32px;
  --fd-gap: 8px;
  --fd-gap-sm: 4px;
  --fd-color-bg-container: white;
}
.sep-line {
  color: var(--divider-color);
  font-size: 14px;
}
.sep-label,
.divider-separate-title {
  color: var(--divider-title-color);
}
.divider-fill {
  background-color: var(--divider-color);
}
.divider-separate-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.style4 .sep-center .sep-label {
  display: block;
}
.style7 .sep-label {
  background: linear-gradient(90deg, var(--divider-color), transparent);
}
.style9 .divider-chevron {
  flex: none;
}
</style>
