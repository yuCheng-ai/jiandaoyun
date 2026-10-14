import type { Ref } from "vue";
import { copy, uid } from "../domain/form";
import {
  validateDepartment,
  validateEmployee,
  type Department,
  type Employee,
  type Organization,
  type OrganizationRole,
  type EmployeeStatus,
} from "../domain/organization";
import { directoryContextMatches, validateDirectory } from "@platform/contracts";
export function organizationActions(
  data: Ref<Organization>,
  notify: (message: string, type?: string) => void,
) {
  function mutate(
    action: (org: Organization) => void,
    expectedContext?: string,
  ): boolean {
    const previous = copy(data.value);
    try {
      if (
        expectedContext !== undefined &&
        !directoryContextMatches(data.value, expectedContext)
      )
        throw Error("组织或授权对象已变化，请重新核对后保存");
      action(data.value);
      // 这里只修改待提交的候选通讯录；服务端确认后 store 才更新正式状态。
      const { currentUserId, ...spec } = data.value;
      data.value = { ...validateDirectory(copy(spec)), currentUserId };
      return true;
    } catch (error) {
      data.value = previous;
      notify(
        error instanceof Error ? error.message : "组织配置保存失败",
        "warning",
      );
      return false;
    }
  }
  function saveDepartment(item: Department, expectedContext?: string) {
    const errors = validateDepartment(data.value, item);
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
    const errors = validateEmployee(data.value, item);
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
  return {
    saveDepartment,
    archiveDepartment,
    saveEmployee,
    bulkEmployees,
    saveRole,
    archiveRole,
    saveRoleGroup,
    removeRoleGroup,
  };
}
