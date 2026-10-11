<script setup lang="ts">
import { computed } from "vue";
import type { FormSchema } from "@platform/contracts";
import { externalThemes } from "../../../domain/externalThemes";
import { useExternalStyleImage } from "../../../composables/useExternalStyleImage";
const props = defineProps<{
  appearance?: FormSchema["settings"]["externalStyle"];
  title: string;
  device?: "desktop" | "mobile";
}>();
const theme = computed(() => externalThemes[props.appearance?.theme ?? -1]);
const custom = computed(() => props.appearance?.custom);
const backgroundImage = useExternalStyleImage(
  () =>
    custom.value?.background.type === "image"
      ? custom.value.background.image
      : undefined,
  "background",
);
const headerImage = useExternalStyleImage(
  () =>
    custom.value?.header.type === "image"
      ? custom.value.header.image
      : undefined,
  "header",
);
const banner = computed(() =>
  custom.value ? headerImage.url.value : theme.value?.banner,
);
const titleStyle = computed(() =>
  custom.value
    ? {
        color: custom.value.title.color,
        textAlign: custom.value.title.align,
        fontSize: `${custom.value.title.size}px`,
        fontWeight: custom.value.title.bold ? 700 : 400,
        fontStyle: custom.value.title.italic ? "italic" : "normal",
        textDecoration: custom.value.title.underline ? "underline" : "none",
        lineHeight: "1.5",
      }
    : { color: theme.value?.titleColor },
);
const background = computed(() => {
  const value = theme.value;
  const image = custom.value
    ? backgroundImage.url.value
    : value && "backgroundImage" in value
      ? value.backgroundImage
      : "";
  return value
    ? {
        "--external-background":
          custom.value?.background.color || value.background,
        "--external-background-image": image ? `url("${image}")` : "none",
        "--external-button": custom.value?.buttonColor || value.buttonColor,
        "--form-tab-theme": custom.value?.buttonColor || value.buttonColor,
      }
    : undefined;
});
</script>
<template>
  <div
    class="external-form"
    :class="{ themed: !!theme, mobile: device === 'mobile' }"
    :style="background"
  >
    <div :class="theme ? 'external-form-sheet' : 'fill-page-sheet'">
      <header v-if="theme" class="external-form-head">
        <div
          class="external-form-banner"
          :style="{
            backgroundColor: custom
              ? banner
                ? 'transparent'
                : custom.header.color
              : theme.bannerColor,
          }"
        >
          <img v-if="banner" :src="banner" alt="" @error="headerImage.failed" />
        </div>
        <h2 v-if="!custom || custom.title.visible" :style="titleStyle">
          {{ title }}
        </h2>
      </header>
      <slot />
      <p
        v-if="backgroundImage.error.value || headerImage.error.value"
        class="external-image-error"
        role="status"
      >
        样式图片暂不可用，仍可继续填写。
      </p>
    </div>
  </div>
</template>
<style>
.external-form:not(.themed) {
  display: contents;
}
.external-form.themed {
  min-height: 100%;
  padding: 20px 0;
  background-color: var(--external-background);
  background-image: var(--external-background-image);
  background-size: cover;
  background-position: center;
}
.external-form-sheet {
  width: 780px;
  max-width: calc(100% - 40px);
  margin: 0 auto;
  background: white;
  border-radius: 6px;
  box-shadow: 0 2px 8px #1c2a3c26;
  overflow: clip;
}
.external-form-banner {
  min-height: 20px;
}
.external-image-error {
  margin: 0;
  padding: 8px 24px;
  font-size: 12px;
  color: #7d8797;
}
.external-form-banner:has(img) {
  padding-bottom: 6px;
}
.external-form-banner img {
  display: block;
  width: 100%;
  height: auto;
}
.external-form-head h2 {
  margin: 0;
  padding: 20px 24px 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 30px;
  overflow-wrap: anywhere;
}
.external-form.themed .runtime-content {
  padding: 20px 24px;
}
.external-form.themed .runtime-content:has(.runtime-fields:empty) {
  padding-bottom: 0;
}
.external-form.themed .runtime-footer {
  position: static;
  padding: 9px 24px;
}
.external-form.themed .runtime-footer .button.primary {
  background-color: var(--external-button);
  border-color: var(--external-button);
}
.external-form.themed .runtime-footer .button {
  height: 32px;
  min-height: 32px;
  flex: 0 0 auto;
}
.external-form.mobile {
  padding: 0;
  background: white;
}
.external-form.mobile .external-form-sheet {
  width: 390px;
  max-width: 100%;
  border-radius: 0;
  box-shadow: none;
}
.external-form.mobile .external-form-head h2 {
  padding: 16px 16px 0;
}
.external-form.mobile .runtime-content {
  padding: 16px;
}
.external-form.mobile .runtime-footer {
  padding: 10px 16px;
}
.external-form.mobile .runtime-footer > div {
  flex-direction: column;
}
.external-form.mobile .runtime-footer .button {
  width: 100%;
  border-radius: 20px;
}
@media (max-width: 650px) {
  .external-form.themed {
    padding: 0;
    background: white;
  }
  .external-form.themed .external-form-sheet {
    max-width: 100%;
    border-radius: 0;
    box-shadow: none;
  }
  .external-form.themed .external-form-head h2 {
    padding: 16px 16px 0;
  }
  .external-form.themed .runtime-content {
    padding: 16px;
  }
  .external-form.themed .runtime-footer {
    padding: 10px 16px;
  }
  .external-form.themed .runtime-footer > div {
    flex-direction: column;
  }
  .external-form.themed .runtime-footer .button {
    width: 100%;
    border-radius: 20px;
  }
}
</style>
