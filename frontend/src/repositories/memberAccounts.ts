import {
  directoryCanonical,
  type DirectorySnapshot,
  type MemberAccountSource,
} from "@platform/contracts";
import { platformApi } from "./platformApi";
import { seedOrganization, type Employee } from "../domain/organization";
import { LocalWorkspaceRepository } from "./workspaceRepository";
import { withWorkspaceWriteLock } from "./workspaceWriteLock";

// Keep the source identity already used by historical migration decisions.
const NAMESPACE_KEY = "business-platform.migration-source.v1";
export async function memberAccountNamespace(): Promise<string> {
  if (!navigator.locks) throw Error("当前浏览器不支持安全关联账号");
  return navigator.locks.request(NAMESPACE_KEY, () => {
    let value = localStorage.getItem(NAMESPACE_KEY);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(NAMESPACE_KEY, value);
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw Error("成员来源无法读取，原数据已保留，请联系管理员");
    return value;
  });
}
export async function setMemberAccountNamespace(namespace: string) {
  await navigator.locks.request(NAMESPACE_KEY, () =>
    localStorage.setItem(NAMESPACE_KEY, namespace),
  );
}

export async function currentAccountMember(id: string): Promise<Employee> {
  // An independent reader must not advance any open editor's write baseline.
  const { directory } = await platformApi<{
    directory: DirectorySnapshot | null;
  }>("/organization/directory");
  const organization =
    directory?.spec ||
    new LocalWorkspaceRepository().load()?.organization ||
    seedOrganization();
  const member = organization.employees.find((item) => item.id === id);
  if (!member) throw Error("成员已不存在，请关闭后重新选择");
  return member;
}

export async function withAccountMember<T>(
  member: Employee,
  namespace: string,
  action: (source: MemberAccountSource) => Promise<T>,
): Promise<T> {
  const current = await currentAccountMember(member.id);
  const source = await withWorkspaceWriteLock(() => {
    if (
      localStorage.getItem(NAMESPACE_KEY) !== namespace ||
      directoryCanonical(current) !== directoryCanonical(member)
    )
      throw Error("成员资料已变化，请关闭后重新打开；当前操作尚未保存");
    return {
      namespace,
      memberId: member.id,
      name: member.name,
      number: member.number,
    };
  });
  // The account link uses the stable member ID; network I/O must not block unrelated workspace saves.
  return action(source);
}
