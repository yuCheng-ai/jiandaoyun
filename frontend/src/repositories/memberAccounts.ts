import {
  directoryCanonical,
  type DirectorySnapshot,
  type MemberAccountSource,
} from "@platform/contracts";
import { platformApi } from "./platformApi";
import type { Employee } from "../domain/organization";

/** Read the authoritative member again without rebasing an open editor. */
export async function currentAccountMember(
  id: string,
  namespace: string,
): Promise<Employee> {
  const { directory } = await platformApi<{
    directory: DirectorySnapshot | null;
  }>("/organization/directory");
  if (!directory || directory.namespace !== namespace)
    throw Error("通讯录已变化，请关闭后重新读取");
  const member = directory.spec.employees.find((item) => item.id === id);
  if (!member) throw Error("成员已不存在，请关闭后重新选择");
  return member;
}

export async function withAccountMember<T>(
  member: Employee,
  namespace: string,
  action: (source: MemberAccountSource) => Promise<T>,
): Promise<T> {
  const current = await currentAccountMember(member.id, namespace);
  if (directoryCanonical(current) !== directoryCanonical(member))
    throw Error("成员资料已变化，请关闭后重新打开；当前操作尚未保存");
  // The API repeats this check inside the account-association transaction.
  return action({
    namespace,
    memberId: member.id,
    name: member.name,
    number: member.number,
  });
}
