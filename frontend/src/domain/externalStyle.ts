import type { CustomExternalStyle } from "@platform/contracts";
import { externalThemes } from "./externalThemes";

function hex(value: string, fallback: string) {
  const rgb = value.match(/[\d.]+/g)?.map(Number);
  if (!rgb || rgb.length < 3 || rgb[3] === 0) return fallback;
  return `#${rgb
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}
export function customStyleFromTheme(index: number): CustomExternalStyle {
  const theme = externalThemes[index] || externalThemes[0];
  const backgroundImage = "backgroundImage" in theme;
  return {
    background: {
      type: backgroundImage ? "image" : "color",
      color: hex(theme.background, "#f7f8fa"),
      ...(backgroundImage ? { image: index } : {}),
    },
    header: {
      type: theme.banner ? "image" : "color",
      color: hex(theme.bannerColor, "#03aba0"),
      ...(theme.banner ? { image: index } : {}),
    },
    title: {
      visible: true,
      align: "left",
      size: 20,
      bold: true,
      italic: false,
      underline: false,
      color: hex(theme.titleColor, "#131d2e"),
    },
    buttonColor: hex(theme.buttonColor, "#03aba0"),
  };
}
