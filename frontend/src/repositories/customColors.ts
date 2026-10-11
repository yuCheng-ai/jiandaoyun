import type { InjectionKey, Ref } from "vue";

export const customColorOwnerKey: InjectionKey<Readonly<Ref<string>>> =
  Symbol("customColorOwner");

export function customColorStorageKey(owner: string) {
  return `workflow-studio-custom-colors:${encodeURIComponent(owner)}`;
}

export function normalizeCustomColors(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter(
          (value): value is string =>
            typeof value === "string" && /^#[\da-f]{6}$/i.test(value),
        )
        .map((value) => value.toLowerCase()),
    ),
  ].slice(0, 7);
}

export function readCustomColors(owner: string): string[] {
  if (!owner) return [];
  try {
    return normalizeCustomColors(
      JSON.parse(localStorage.getItem(customColorStorageKey(owner)) || "[]"),
    );
  } catch {
    return [];
  }
}

/** Harmless personal preferences never write or block the business workspace. */
export function rememberCustomColor(owner: string, color: string): string[] {
  const next = normalizeCustomColors([color, ...readCustomColors(owner)]);
  if (owner) {
    try {
      localStorage.setItem(customColorStorageKey(owner), JSON.stringify(next));
    } catch {
      /* Selecting a field color still works when preferences cannot persist. */
    }
  }
  return next;
}
