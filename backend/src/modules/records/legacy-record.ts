import { BadRequestException } from "@nestjs/common";
import type { LegacyRecordLifecycle } from "@platform/contracts";
import { object } from "../../core/database/schema";

/**
 * 校验并提取迁移记录的原生命周期信息（状态、时间戳与历史处理轨迹）：
 * - 严格保留原始时间字符串与轨迹顺序，不伪造操作人或重放历史动作。
 */
export function legacyRecordLifecycle(entry: any): LegacyRecordLifecycle {
  const fail = (message: string): never => {
    throw new BadRequestException(message);
  };

  if (!["draft", "submitted", "approved", "rejected"].includes(entry.status)) {
    fail("原记录状态无效。");
  }

  const time = (value: unknown, label: string): string => {
    if (typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value))) {
      return value;
    }
    return fail(`${label}时间无效。`);
  };

  const result: LegacyRecordLifecycle = {
    status: entry.status,
    createdAt: time(entry.createdAt, "原创建"),
    history: [],
  };

  if (entry.updatedAt !== undefined) {
    result.updatedAt = time(entry.updatedAt, "原修改");
  }
  if (entry.deletedAt !== undefined) {
    result.deletedAt = time(entry.deletedAt, "原删除");
  }

  if (entry.currentNodeId !== undefined) {
    if (
      typeof entry.currentNodeId !== "string" ||
      entry.currentNodeId.length > 200 ||
      /[\u0000-\u001f]/.test(entry.currentNodeId)
    ) {
      fail("原当前节点身份无效。");
    }
    result.currentNodeId = entry.currentNodeId;
  }

  if (!Array.isArray(entry.history) || entry.history.length > 10000) {
    fail("原处理轨迹不是列表或超过检查容量。");
  }

  result.history = entry.history.map((item: unknown, index: number) => {
    object(item);
    if (
      typeof item.label !== "string" ||
      typeof item.action !== "string" ||
      item.label.length > 10000 ||
      item.action.length > 10000
    ) {
      fail(`第 ${index + 1} 条原处理轨迹格式无效。`);
    }
    return {
      label: item.label,
      action: item.action,
      time: time(item.time, `第 ${index + 1} 条原处理轨迹`),
    };
  });

  return result;
}
