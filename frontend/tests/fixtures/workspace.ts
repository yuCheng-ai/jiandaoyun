import {
  subformPermissions,
  type DirectoryDepartment as Department,
  type DirectoryEmployee as Employee,
} from "@platform/contracts";
import {
  createField,
  flattenFields,
  uid,
  type FormSchema,
} from "../../src/domain/form";
import type { AccessGroup } from "../../src/domain/access";
import type { Organization } from "../../src/domain/organization";
import {
  newForm,
  type WorkspaceApp,
  type WorkspaceData,
} from "../../src/domain/workspace";

// 示例企业和应用只服务测试；生产运行上下文从服务端数据构造。
export function seedOrganization(): Organization {
  const departments: Department[] = [
    {
      id: "company",
      name: "示例企业",
      parentId: null,
      managerIds: ["zhang"],
      archived: false,
    },
    {
      id: "product",
      name: "产品部",
      parentId: "company",
      managerIds: ["zhang"],
      archived: false,
    },
    {
      id: "engineering",
      name: "研发部",
      parentId: "company",
      managerIds: ["wang"],
      archived: false,
    },
    {
      id: "frontend",
      name: "前端组",
      parentId: "engineering",
      managerIds: ["wang"],
      archived: false,
    },
    {
      id: "finance",
      name: "财务部",
      parentId: "company",
      managerIds: ["zhao"],
      archived: false,
    },
    {
      id: "administration",
      name: "行政人事部",
      parentId: "company",
      managerIds: ["chen"],
      archived: false,
    },
  ];
  const employees: Employee[] = [
    ["zhang", "张三", "product", "产品经理"],
    ["li", "李四", "product", "产品设计师"],
    ["wang", "王五", "engineering", "研发负责人"],
    ["zhao", "赵六", "finance", "财务负责人"],
    ["chen", "陈晨", "administration", "人事专员"],
    ["lin", "林悦", "frontend", "前端工程师"],
  ].map(([id, name, department, position], i) => ({
    id: id!,
    name: name!,
    number: `E${String(i + 1).padStart(4, "0")}`,
    email: `${id}@example.com`,
    phone: "",
    departmentIds: [department!],
    primaryDepartmentId: department!,
    position: position!,
    status: "active",
    joinedAt: "2026-01-01",
  }));
  return {
    version: 1,
    name: "示例企业",
    departments,
    employees,
    roleGroups: [
      { id: "group_system", name: "系统角色" },
      { id: "group_business", name: "业务角色" },
    ],
    roles: [
      {
        id: "role_admin",
        name: "工作空间管理员",
        groupId: "group_system",
        description: "管理应用与组织配置",
        memberIds: ["zhang"],
        departmentIds: [],
        includeChildren: true,
        grants: [
          {
            appId: "*",
            formIds: [],
            actions: ["view", "submit", "manage"],
            dataScope: "all",
          },
        ],
        archived: false,
      },
      {
        id: "role_employee",
        name: "内部员工",
        groupId: "group_business",
        description: "所有在职内部成员",
        memberIds: [],
        departmentIds: ["company"],
        includeChildren: true,
        grants: [
          {
            appId: "*",
            formIds: [],
            actions: ["view", "submit"],
            dataScope: "self",
          },
        ],
        archived: false,
      },
      {
        id: "role_finance",
        name: "财务审批人",
        groupId: "group_business",
        description: "负责财务审核",
        memberIds: ["zhao"],
        departmentIds: [],
        includeChildren: false,
        grants: [
          {
            appId: "oa",
            formIds: ["expense"],
            actions: ["view", "manage"],
            dataScope: "all",
          },
        ],
        archived: false,
      },
    ],
    currentUserId: "zhang",
  };
}

export function seedWorkspace(): WorkspaceData {
  const apps: WorkspaceApp[] = [
    {
      id: "oa",
      name: "OA审批系统",
      color: "#56ae72",
      icon: "department",
      folders: ["行政类", "人事类", "财务类", "其他"],
      description: "让日常办公和团队协作更高效",
    },
    {
      id: "product",
      name: "产品需求管理",
      color: "#f1af56",
      icon: "layers",
      folders: ["需求管理", "项目协作"],
      description: "从需求收集到项目交付",
    },
    {
      id: "production",
      name: "生产流转管理",
      color: "#548ddb",
      icon: "settings",
      folders: ["生产计划", "质量检查"],
      description: "连接生产流程与质量数据",
    },
    {
      id: "quality",
      name: "质量管理",
      color: "#a777d4",
      icon: "success",
      folders: ["质量巡检"],
      description: "记录问题，跟踪改善",
    },
    {
      id: "assets",
      name: "资产管理",
      color: "#53b0bd",
      icon: "database",
      folders: ["资产台账"],
      description: "管理团队的设备和物资",
    },
    {
      id: "tickets",
      name: "工单管理",
      color: "#dc7d87",
      icon: "form",
      folders: ["工单中心"],
      description: "接收需求，及时响应",
    },
  ];
  const expense = newForm("oa", "费用报销", "workflow", "财务类");
  expense.id = "expense";
  expense.schema.fields = [
    createField("member", { id: "applicant", label: "申请人", required: true }),
    createField("department", {
      id: "department",
      label: "申请部门",
      required: true,
    }),
    createField("datetime", { id: "date", label: "申请日期", required: true }),
    createField("number", {
      id: "amount",
      label: "申请金额",
      required: true,
      min: 0,
    }),
    createField("textarea", { id: "note", label: "申请说明" }),
  ];
  const leave = newForm("oa", "请假申请", "workflow", "人事类");
  leave.id = "leave";
  leave.schema.fields = [
    createField("member", {
      id: "leave_applicant",
      label: "申请人",
      required: true,
    }),
    createField("select", {
      id: "leave_type",
      label: "请假类型",
      required: true,
      options: ["事假", "病假", "年假", "调休"].map((label) => ({
        id: uid("option"),
        label,
      })),
    }),
    createField("datetime", {
      id: "leave_start",
      label: "开始时间",
      format: "datetime-local",
      width: 6,
      required: true,
    }),
    createField("datetime", {
      id: "leave_end",
      label: "结束时间",
      format: "datetime-local",
      width: 6,
      required: true,
    }),
    createField("textarea", {
      id: "leave_reason",
      label: "请假事由",
      required: true,
    }),
  ];
  const employee = newForm("oa", "员工详情", "form", "人事类");
  employee.id = "employee";
  employee.schema.fields = [
    createField("text", { label: "姓名", required: true }),
    createField("phone", { label: "手机号码", required: true }),
    createField("department", { label: "所属部门" }),
    createField("datetime", { label: "入职日期" }),
  ];
  const unnamed = newForm("oa", "未命名表单", "workflow", "其他");
  unnamed.id = "untitled";
  unnamed.schema.fields = [
    createField("text", { id: "sample_text", label: "单行文本" }),
    createField("number", { id: "sample_number", label: "数字" }),
  ];
  const supplies = newForm("oa", "办公用品申请", "workflow", "行政类");
  supplies.id = "supplies";
  const items = createField("subform", { label: "物品明细" });
  items.children = [
    createField("text", { label: "物品名称", required: true }),
    createField("number", { label: "数量", required: true, min: 1 }),
    createField("textarea", { label: "备注" }),
  ];
  supplies.schema.fields = [
    createField("member", { label: "申请人", required: true }),
    items,
  ];
  const forms = [
    leave,
    employee,
    expense,
    supplies,
    unnamed,
    ...apps
      .slice(1)
      .map((app) =>
        newForm(app.id, `${app.folders[0]}表单`, "form", app.folders[0]),
      ),
  ];
  return {
    version: 1,
    organization: seedOrganization(),
    apps,
    forms,
    entries: [],
    recentFormIds: ["leave", "employee", "untitled"],
  };
}

/** 旧权限投影的测试配置；真实权限由服务端提供。 */
export function newAccessGroup(
  schema: FormSchema,
  preset = "read",
): AccessGroup {
  const group: AccessGroup = {
    id: uid("access"),
    name: "自定义权限组",
    enabled: true,
    archived: false,
    identities: [],
    actions: ["view"],
    scope: "all",
    filters: [],
    fields: {},
  };
  if (preset === "read") group.name = "查看全部数据";
  if (preset === "create") {
    group.name = "仅添加数据";
    group.actions = ["create"];
  }
  if (preset === "self") {
    group.name = "添加并管理本人数据";
    group.actions = ["view", "create", "edit", "delete"];
    group.scope = "self";
  }
  if (preset === "manage") {
    group.name = "管理全部数据";
    group.actions = [
      "view",
      "create",
      "edit",
      "delete",
      "import",
      "export",
      "print",
    ];
  }
  for (const field of flattenFields(schema.fields)) {
    group.fields[field.id] = ["manage", "self"].includes(preset)
      ? "edit"
      : "read";
    if (field.type === "subform") {
      group.subformPermissions ??= {};
      group.subformPermissions[field.id] = subformPermissions();
    }
  }
  return group;
}
