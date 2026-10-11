/** Application resources keep their own context, outside any one form editor. */
export type ApplicationResourceTab = "pages" | "objects" | "processes";

export function applicationResourceTab(value: unknown): ApplicationResourceTab {
  return value === "objects" || value === "processes" ? value : "pages";
}

export function applicationDataLocation(
  applicationId: string,
  definitionId: string,
) {
  return {
    path: `/applications/${applicationId}`,
    query: { tab: "objects", object: definitionId },
  };
}
