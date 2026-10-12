import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  seedOrganization,
  parseOrganization,
  descendants,
  roleMembers,
  resolveIdentities,
  allowedEmployees,
  allowedDepartments,
  emptyScope,
  organizationDefault,
  emptyOrganizationField,
  permissionsFor,
  newEmployee,
  validateDepartment,
} from "../src/domain/organization";
import { parseWorkspace } from "../src/repositories/workspaceRepository";
import { seedWorkspace } from "../src/domain/workspace";
import { computed, ref, type Ref } from "vue";
import { organizationActions } from "../src/stores/organizationActions";
import { copy } from "../src/domain/form";

// Exercise the pure organization reducer; server persistence is covered by directory API tests.
function organizationFixture() {
  const data = ref(seedWorkspace()) as Ref<ReturnType<typeof seedWorkspace>>;
  const persist = () => {
    localStorage.setItem("organization-fixture", JSON.stringify(data.value));
    return true;
  };
  return { get data() { return data.value; }, ...organizationActions(computed({ get: () => data.value.organization, set: (value) => { data.value.organization = value; } }), persist, vi.fn()) };
}

let saved = new Map<string, string>();
let setItem = vi.fn();
beforeEach(() => {
  saved = new Map();
  setItem = vi.fn((k, v) => saved.set(k, v));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => saved.get(k) || null,
    setItem,
  });
  setActivePinia(createPinia());
});
describe("organization and identity", () => {
  it("migrates legacy workspaces without replacing forms or entries", () => {
    const raw = seedWorkspace();
    delete (raw as any).organization;
    const result = parseWorkspace(JSON.stringify(raw));
    expect(result.organization.employees.length).toBe(6);
    expect(result.forms.map((f) => f.id)).toEqual(raw.forms.map((f) => f.id));
  });
  it("rejects cycles and moving a department beneath its descendant", () => {
    const org = seedOrganization();
    const engineering = org.departments.find((d) => d.id === "engineering")!;
    expect(
      validateDepartment(org, { ...engineering, parentId: "frontend" }),
    ).toContain("不能将部门移动到自身或下级部门");
    engineering.parentId = "frontend";
    expect(() => parseOrganization(org)).toThrow("循环");
  });
  it("unions direct, department and role assignees and excludes inactive employees", () => {
    const org = seedOrganization();
    org.employees.find((e) => e.id === "lin")!.status = "inactive";
    expect(
      resolveIdentities(org, ["wang", "engineering", "role_finance"]).map(
        (e) => e.id,
      ),
    ).toEqual(["wang", "zhao"]);
  });
  it("changes role membership when departments or employee status change", () => {
    const org = seedOrganization(),
      role = org.roles[1]!;
    expect(roleMembers(org, role)).toHaveLength(6);
    org.employees[0]!.status = "left";
    expect(roleMembers(org, role)).toHaveLength(5);
  });
  it("restricts pickers by department dependencies and explicit role unions", () => {
    const org = seedOrganization();
    const scope = {
      ...emptyScope(),
      mode: "fieldDepartment" as const,
      fieldId: "dep",
    };
    expect(allowedEmployees(org, scope, {})).toEqual([]);
    expect(
      allowedEmployees(org, scope, { dep: "engineering" }).map((e) => e.id),
    ).toEqual(["wang", "lin"]);
    scope.includeChildren = false;
    expect(
      allowedEmployees(org, scope, { dep: "engineering" }).map((e) => e.id),
    ).toEqual(["wang"]);
    expect(
      allowedEmployees(org, {
        ...emptyScope(),
        mode: "custom",
        roleIds: ["role_finance"],
        employeeIds: ["li"],
      }).map((e) => e.id),
    ).toEqual(["li", "zhao"]);
  });
  it("resolves current user, main department and manager defaults within scope", () => {
    const org = seedOrganization();
    expect(
      organizationDefault(
        org,
        { ...emptyOrganizationField(), defaultMode: "currentUser" },
        "member",
        false,
      ),
    ).toBe("zhang");
    expect(
      organizationDefault(
        org,
        { ...emptyOrganizationField(), defaultMode: "currentDepartment" },
        "department",
        false,
      ),
    ).toBe("product");
    expect(
      organizationDefault(
        org,
        {
          ...emptyOrganizationField(),
          defaultMode: "currentUser",
          scope: {
            ...emptyScope(),
            mode: "custom",
            departmentIds: ["finance"],
          },
        },
        "member",
        true,
      ),
    ).toEqual([]);
  });
  it("merges role grants and scopes and revokes archived roles", () => {
    const org = seedOrganization();
    expect(permissionsFor(org, "zhang", "oa", "expense").actions).toContain(
      "manage",
    );
    org.roles[0]!.archived = true;
    expect(permissionsFor(org, "zhang", "oa", "expense").actions).not.toContain(
      "manage",
    );
    expect(permissionsFor(org, "zhang", "oa", "expense").dataScope).toBe(
      "self",
    );
  });
  it("persists employee edits and prevents duplicate employee numbers", async () => {
    const store = organizationFixture();
    const employee = newEmployee();
    Object.assign(employee, {
      name: "测试成员",
      number: "E0099",
      departmentIds: ["engineering"],
      primaryDepartmentId: "engineering",
    });
    expect(await store.saveEmployee(employee, ["role_finance"])).toBe(true);
    expect(
      store.data.organization.roles.find((r) => r.id === "role_finance")!
        .memberIds,
    ).toContain(employee.id);
    expect(await store.saveEmployee({ ...employee, id: "duplicate" })).toBe(
      false,
    );
    expect(
      parseWorkspace([...saved.values()][0]!).organization.employees.find(
        (e) => e.id === employee.id,
      )?.name,
    ).toBe("测试成员");
  });
  it("rejects archiving occupied departments and can restore empty departments", async () => {
    const store = organizationFixture();
    expect(await store.archiveDepartment("engineering")).toBe(false);
    expect(
      await store.saveDepartment({
        id: "empty",
        name: "空部门",
        parentId: "company",
        managerIds: [],
        archived: false,
      }),
    ).toBe(true);
    expect(await store.archiveDepartment("empty")).toBe(true);
    expect(await store.archiveDepartment("empty", false)).toBe(true);
  });
  it("rolls back failed writes and protects the current user during bulk changes", async () => {
    const store = organizationFixture(),
      before = copy(store.data.organization);
    expect(await store.bulkEmployees(["zhang"], { status: "left" })).toBe(
      false,
    );
    setItem.mockImplementation(() => {
      throw Error("quota");
    });
    expect(await store.bulkEmployees(["li"], { status: "inactive" })).toBe(
      false,
    );
    expect(store.data.organization).toEqual(before);
  });
});
