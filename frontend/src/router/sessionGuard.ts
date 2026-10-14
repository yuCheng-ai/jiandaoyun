import type { Router } from "vue-router";
import { usePlatformSession } from "../stores/platformSession";
import { useNotices } from "../stores/notices";

// 登录页是唯一匿名入口；业务页面不再各自嵌入登录表单。
export function installSessionGuard(router: Router) {
  router.beforeEach(async (to) => {
    const session = usePlatformSession();
    try {
      await session.restore();
    } catch (cause) {
      useNotices().notify(
        cause instanceof Error
          ? cause.message
          : "暂时无法连接服务，请稍后重试。",
        "error",
      );
      // 无法核实会话时保留当前页面；首次访问仍可进入登录页重试。
      if (session.user) return false;
    }
    if (to.name === "login") {
      if (session.user) return signInDestination(router, to.query.next) || "/";
      return;
    }
    if (!session.user) {
      return {
        name: "login",
        query: to.fullPath === "/" ? {} : { next: to.fullPath },
      };
    }
    if (to.meta.requiresAdmin && session.user.role !== "admin")
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
    route.name !== "login" &&
    route.matched.every((record) => !record.redirect)
  )
    return route.fullPath;
}
