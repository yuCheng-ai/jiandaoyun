import { createRouter, createWebHashHistory } from "vue-router";
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/applications/:applicationId",
      name: "data-workspace",
      component: () =>
        import("../features/workspace/ServerApplicationHome.vue"),
    },
    {
      path: "/applications/:applicationId/pages/:pageId/design",
      name: "page-designer",
      component: () => import("../features/data/PageDesignerView.vue"),
    },
    {
      path: "/applications",
      redirect: "/",
    },
    {
      path: "/collaboration",
      name: "collaboration",
      redirect: "/",
    },
    {
      path: "/admin/payments",
      redirect: { path: "/", query: { notice: "legacy-link" } },
    },
    {
      path: "/admin/organization",
      name: "organization",
      component: () => import("../features/organization/EmployeesView.vue"),
    },
    {
      path: "/admin/members",
      redirect: "/admin/organization",
    },
    {
      path: "/admin/roles",
      name: "roles",
      component: () => import("../features/organization/RolesView.vue"),
    },
    {
      path: "/admin/permissions",
      name: "permissions",
      component: () => import("../features/organization/PermissionsView.vue"),
    },
    {
      path: "/",
      name: "home",
      component: () => import("../features/workspace/WorkbenchView.vue"),
    },
    // Local app/form IDs have no implicit correspondence to server UUIDs.
    // Retired bookmarks lead to the authorized application list, never to a guessed record.
    {
      path: "/apps/:pathMatch(.*)*",
      redirect: { path: "/", query: { notice: "legacy-link" } },
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.afterEach((to, _from, failure) => {
  if (failure) return;
  const labels: Record<string, string> = {
    "data-workspace": "应用",
    "page-designer": "表单页面设计",
    organization: "内部组织",
    roles: "角色管理",
    permissions: "权限查询",
    home: "工作台",
  };
  document.title = `${labels[String(to.name)] || "工作台"} · 流程工作台`;
});
