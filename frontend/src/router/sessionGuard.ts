import type { Router } from "vue-router";
import { usePlatformSession } from "../stores/platformSession";

// All live business routes use authenticated server accounts.
export function installSessionGuard(router: Router) {
  router.beforeEach(async (to) => {
    if (to.name === "home") return;
    const session = usePlatformSession();
    try {
      await session.restore();
    } catch {
      return { name: "home", query: { next: to.fullPath } };
    }
    if (!session.user) return { name: "home", query: { next: to.fullPath } };
    if (
      (to.path.startsWith("/admin/") ||
        to.name === "page-designer") &&
      session.user.role !== "admin"
    )
      return { name: "home", query: { notice: "access-denied" } };
  });
}

export function signInDestination(
  router: Router,
  next: unknown,
): string | undefined {
  if (
    typeof next !== "string" ||
    !next.startsWith("/") ||
    next.startsWith("//")
  )
    return;
  const route = router.resolve(next);
  if (
    route.name &&
    route.name !== "home" &&
    route.matched.every((record) => !record.redirect)
  )
    return route.fullPath;
}
