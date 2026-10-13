import { ConflictException } from "@nestjs/common";
import { tokenHash, type Actor } from "../../core/auth/auth.service";
import type { Transaction } from "../../core/database/database";
import { uuid } from "../../core/database/schema";

/** 递归将对象属性按字典序排列，用于生成稳定的请求负载摘要 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

/**
 * 幂等写操作执行器：
 * - 通过事务级咨询锁（Advisory Lock）串行化同一用户同一 requestId 的并发请求；
 * - 仅持久化目标资源 ID（resource_id），避免缓存带权限状态的过期响应内容；
 * - 若同一 requestId 被用于不同请求内容，则抛出冲突异常。
 */
export async function once(
  tx: Transaction,
  actor: Actor,
  requestId: unknown,
  payload: unknown,
  execute: () => Promise<string>,
) {
  uuid(requestId);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${actor.id}:${requestId}`]);

  const hash = `v2:${tokenHash(JSON.stringify(canonical(payload)))}`;
  const { rows } = await tx.query(
    "SELECT * FROM commands WHERE actor_id=$1 AND request_id=$2",
    [actor.id, requestId],
  );
  const prior = rows[0];

  if (prior) {
    const expected = prior.request_hash.startsWith("v2:")
      ? hash
      : tokenHash(JSON.stringify(payload));
    if (prior.request_hash !== expected) {
      throw new ConflictException("同一提交标识不能用于不同内容");
    }
    return prior.resource_id as string;
  }

  const id = await execute();
  await tx.query(
    "INSERT INTO commands(actor_id,request_id,request_hash,resource_id) VALUES($1,$2,$3,$4)",
    [actor.id, requestId, hash, id],
  );
  return id;
}
