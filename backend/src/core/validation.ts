import { BadRequestException } from "@nestjs/common";

// ============================================================================
// 1. 基础入参断言与工具函数
// ============================================================================

/** 断言输入为非数组的普通对象 */
export function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("需要对象格式");
  }
}

/** 断言输入为合法的标识符（字母开头，仅含字母/数字/下划线/短横线，且非原型链属性） */
export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(value) ||
    ["constructor", "prototype", "__proto__"].includes(value)
  ) {
    throw new BadRequestException("标识不合法");
  }
}

/** 断言输入为标准 UUID（v1-v5）格式 */
export function uuid(value: unknown): asserts value is string {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new BadRequestException("记录或请求标识不合法");
  }
}

/** 断言输入为 1–100 字符的非空白名称 */
export function title(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new BadRequestException("名称应为 1–100 个字符");
  }
}
