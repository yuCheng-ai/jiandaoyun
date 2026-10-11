import { ConflictException } from "@nestjs/common";
import { tokenHash, type Actor } from "./auth";
import type { Transaction } from "./database";
import { uuid } from "./schema";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Store resource identities, never stale permission-bearing responses. */
export async function once(tx: Transaction, actor: Actor, requestId: unknown, payload: unknown, execute: () => Promise<string>) {
  uuid(requestId);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${actor.id}:${requestId}`]);
  const hash = `v2:${tokenHash(JSON.stringify(canonical(payload)))}`;
  const prior = (await tx.query("SELECT * FROM commands WHERE actor_id=$1 AND request_id=$2", [actor.id, requestId])).rows[0];
  if (prior) {
    const expected = prior.request_hash.startsWith("v2:") ? hash : tokenHash(JSON.stringify(payload));
    if (prior.request_hash !== expected) throw new ConflictException("同一提交标识不能用于不同内容");
    return prior.resource_id as string;
  }
  const id = await execute();
  await tx.query("INSERT INTO commands(actor_id,request_id,request_hash,resource_id) VALUES($1,$2,$3,$4)", [actor.id, requestId, hash, id]);
  return id;
}
