/** Compatibility defaults may be added; existing business values must never disappear. */
export function workspaceReadIsLossless(
  source: unknown,
  parsed: unknown,
): boolean {
  function retained(before: unknown, after: unknown): boolean {
    if (Array.isArray(before))
      return (
        Array.isArray(after) &&
        before.length === after.length &&
        before.every((value, index) => retained(value, after[index]))
      );
    if (before && typeof before === "object")
      return (
        !!after &&
        typeof after === "object" &&
        Object.entries(before).every(([key, value]) =>
          retained(value, (after as Record<string, unknown>)[key]),
        )
      );
    return before === after;
  }
  const business = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const { recentFormIds: _, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  return retained(business(source), business(parsed));
}

// Ignore object key order and absent optional properties, but retain array order.
export function sameWorkspaceValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
