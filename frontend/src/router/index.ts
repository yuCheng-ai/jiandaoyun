import { createRouter, createWebHashHistory } from "vue-router";
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("../features/session/PlatformLogin.vue"),
    },
    {
      path: "/applications/:applicationId",
      name: "data-workspace",
      component: () =>
        import("../features/workspace/ServerApplicationHome.vue"),
    },
    {
      path: "/applications/:applicationId/pages/:pageId/design",
      name: "page-designer",
      meta: { requiresAdmin: true },
      component: () => import("../features/data/PageDesignerView.vue"),
    },
    {
      path: "/applications/:applicationId/pages/:pageId/flow",
      name: "page-workflow",
      meta: { requiresAdmin: true },
      component: () => import("../features/workflow/WorkflowView.vue"),
    },
    {
      path: "/applications/:applicationId/pages/:pageId/extensions",
      name: "page-extensions",
      meta: { requiresAdmin: true },
      component: () => import("../features/extensions/ExtensionsView.vue"),
    },
    {
      path: "/applications/:applicationId/pages/:pageId/publish",
      name: "page-publish",
      meta: { requiresAdmin: true },
      component: () => import("../features/forms/PublishView.vue"),
    },
    {
      path: "/applications",
      redirect: "/",
    },
    {
      path: "/admin/organization",
      name: "organization",
      meta: { requiresAdmin: true },
      component: () => import("../features/organization/EmployeesView.vue"),
    },
    {
      path: "/admin/members",
      redirect: "/admin/organization",
    },
    {
      path: "/admin/roles",
      name: "roles",
      meta: { requiresAdmin: true },
      component: () => import("../features/organization/RolesView.vue"),
    },
    {
      path: "/admin/permissions",
      name: "permissions",
      meta: { requiresAdmin: true },
      component: () => import("../features/organization/PermissionsView.vue"),
    },
    {
      path: "/",
      name: "home",
      component: () => import("../features/workspace/WorkbenchView.vue"),
    },
    // 已删除页面统一回到工作台，未登录时由会话守卫转到登录页。
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.afterEach((to, _from, failure) => {
  if (failure) return;
  const labels: Record<string, string> = {
    login: "登录",
    "data-workspace": "应用",
    "page-designer": "表单设计",
    "page-workflow": "流程设计",
    "page-extensions": "扩展功能",
    "page-publish": "表单发布",
    organization: "内部组织",
    roles: "角色管理",
    permissions: "权限查询",
    home: "工作台",
  };
  document.title = `${labels[String(to.name)] || "工作台"} · 流程工作台`;
});
