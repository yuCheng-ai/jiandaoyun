import type { Ref } from "vue";
import { copy, uid } from "../domain/form";
import {
  parseOrganization,
  validateDepartment,
  validateEmployee,
  type Department,
  type Employee,
  type Organization,
  type OrganizationRole,
  type EmployeeStatus,
} from "../domain/organization";
import type { WorkspaceData } from "../domain/workspace";
import { organizationContextMatches } from "../domain/organizationDraftAdapters";
export function organizationActions(
  data: Ref<WorkspaceData>,
  persist: () => boolean,
  notify: (message: string, type?: string) => void,
) {
  function mutate(
    action: (org: Organization) => void,
    expectedContext?: string,
  ): boolean {
    const previous = copy(data.value.organization);
    try {
      if (
        expectedContext !== undefined &&
        !organizationContextMatches(data.value, expectedContext)
      )
        throw Error("组织或授权对象已变化，请重新核对后保存");
      action(data.value.organization);
      data.value.organization = parseOrganization(data.value.organization);
      if (!persist()) {
        data.value.organization = previous;
        return false;
      }
      return true;
    } catch (error) {
      data.value.organization = previous;
      notify(
        error instanceof Error ? error.message : "组织配置保存失败",
        "warning",
      );
      return false;
    }
  }
  function saveDepartment(item: Department, expectedContext?: string) {
    const errors = validateDepartment(data.value.organization, item);
    if (errors.length) {
      notify(errors[0]!, "warning");
      return false;
    }
    return mutate((org) => {
      const index = org.departments.findIndex((d) => d.id === item.id);
      if (index < 0) org.departments.push(copy(item));
      else org.departments[index] = copy(item);
    }, expectedContext);
  }
  function archiveDepartment(id: string, archived = true) {
    return mutate((org) => {
      const d = org.departments.find((d) => d.id === id);
      if (!d) throw Error("部门不存在");
      if (
        archived &&
        (org.departments.some((c) => c.parentId === id && !c.archived) ||
          org.employees.some(
            (e) => e.status === "active" && e.departmentIds.includes(id),
          ))
      )
        throw Error("请先移动下级部门和在职成员");
      if (
        !archived &&
        d.parentId &&
        org.departments.find((p) => p.id === d.parentId)?.archived
      )
        throw Error("请先恢复上级部门");
      if (!archived) {
        const errors = validateDepartment(org, { ...d, archived: false });
        if (errors.length) throw Error(errors[0]);
      }
      d.archived = archived;
    });
  }
  function saveEmployee(
    item: Employee,
    roleIds?: string[],
    expectedContext?: string,
  ) {
    const errors = validateEmployee(data.value.organization, item);
    if (errors.length) {
      notify(errors[0]!, "warning");
      return false;
    }
    return mutate((org) => {
      if (
        roleIds?.some(
          (id) => !org.roles.some((r) => r.id === id && !r.archived),
        )
      )
        throw Error("所选角色已停用或不存在，请重新选择");
      if (item.id === org.currentUserId && item.status !== "active")
        throw Error("请先切换当前体验成员，再停用此成员");
      const index = org.employees.findIndex((e) => e.id === item.id);
      if (index < 0) org.employees.push(copy(item));
      else org.employees[index] = copy(item);
      if (roleIds)
        for (const role of org.roles) {
          role.memberIds = role.memberIds.filter((id) => id !== item.id);
          if (roleIds.includes(role.id)) role.memberIds.push(item.id);
        }
    }, expectedContext);
  }
  function bulkEmployees(
    ids: string[],
    action: { status?: EmployeeStatus; departmentId?: string; roleId?: string },
    expectedContext?: string,
  ) {
    return mutate((org) => {
      if (
        action.status &&
        action.status !== "active" &&
        ids.includes(org.currentUserId)
      )
        throw Error("批量操作不能停用当前体验成员");
      for (const e of org.employees.filter((e) => ids.includes(e.id))) {
        if (action.status) e.status = action.status;
        if (action.departmentId) {
          if (
            !org.departments.some(
              (d) => d.id === action.departmentId && !d.archived,
            )
          )
            throw Error("目标部门不存在");
          e.departmentIds = [action.departmentId];
          e.primaryDepartmentId = action.departmentId;
        }
      }
      if (action.roleId) {
        const role = org.roles.find(
          (r) => r.id === action.roleId && !r.archived,
        );
        if (!role) throw Error("角色不存在");
        role.memberIds = [...new Set([...role.memberIds, ...ids])];
      }
    }, expectedContext);
  }
  function saveRole(item: OrganizationRole, expectedContext?: string) {
    return mutate((org) => {
      if (!item.name.trim()) throw Error("请输入角色名称");
      if (!org.roleGroups.some((g) => g.id === item.groupId))
        throw Error("请选择角色分组");
      if (
        item.grants.some(
          (grant) =>
            !data.value.apps.some((app) => app.id === grant.appId) ||
            grant.formIds.some(
              (id) =>
                !data.value.forms.some(
                  (form) =>
                    form.id === id &&
                    form.appId === grant.appId &&
                    !form.archived,
                ),
            ),
        )
      )
        throw Error("授权的应用或表单已不存在，请重新选择授权范围");
      if (
        org.roles.some(
          (r) =>
            r.id !== item.id &&
            !r.archived &&
            r.groupId === item.groupId &&
            r.name === item.name.trim(),
        )
      )
        throw Error("该分组下已存在同名角色");
      const index = org.roles.findIndex((r) => r.id === item.id);
      if (index < 0) org.roles.push(copy(item));
      else org.roles[index] = copy(item);
    }, expectedContext);
  }
  function archiveRole(id: string, archived = true) {
    return mutate((org) => {
      const r = org.roles.find((r) => r.id === id);
      if (r) {
        if (
          !archived &&
          org.roles.some(
            (other) =>
              other.id !== id &&
              !other.archived &&
              other.groupId === r.groupId &&
              other.name === r.name,
          )
        )
          throw Error("此分组存在同名角色，请先修改名称");
        r.archived = archived;
      }
    });
  }
  function saveRoleGroup(
    name: string,
    id = uid("roleGroup"),
    expectedContext?: string,
  ) {
    return mutate((org) => {
      if (!name.trim()) throw Error("请输入分组名称");
      if (org.roleGroups.some((g) => g.id !== id && g.name === name.trim()))
        throw Error("分组名称已存在");
      const group = org.roleGroups.find((g) => g.id === id);
      if (group) group.name = name.trim();
      else org.roleGroups.push({ id, name: name.trim() });
    }, expectedContext);
  }
  function removeRoleGroup(id: string, expectedContext?: string) {
    return mutate((org) => {
      if (org.roles.some((r) => r.groupId === id))
        throw Error("请先将此分组下的角色移入其他分组");
      org.roleGroups = org.roleGroups.filter((g) => g.id !== id);
    }, expectedContext);
  }
  function setCurrentUser(id: string) {
    return mutate((org) => {
      if (!org.employees.some((e) => e.id === id && e.status === "active"))
        throw Error("请选择在职成员");
      org.currentUserId = id;
    });
  }
  return {
    saveDepartment,
    archiveDepartment,
    saveEmployee,
    bulkEmployees,
    saveRole,
    archiveRole,
    saveRoleGroup,
    removeRoleGroup,
    setCurrentUser,
  };
}
