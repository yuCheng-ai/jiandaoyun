import type {
  QuickFillConfig,
  QuickFillSource,
  QuickFillExtraction,
  QuickFillSuggestion,
} from "../domain/quickFill";
import { quickFillFields } from "../domain/quickFill";
import type { FormSchema } from "../domain/form";
export interface QuickFillExtractor {
  extract(
    config: QuickFillConfig,
    schema: FormSchema,
    source: QuickFillSource,
    signal: AbortSignal,
  ): Promise<QuickFillExtraction>;
}
/** Local labelled-text demonstration. No model calls, OCR, uploads or network requests. */
export const localQuickFillExtractor: QuickFillExtractor = {
  async extract(config, schema, source, signal) {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (source.text.length > 20000) throw Error("每次最多解析 20,000 字");
    if (source.text.trim() && !config.allowText)
      throw Error("当前配置未启用文字输入");
    if (source.attachments.length && !config.allowImages)
      throw Error("当前配置未启用图片输入");
    if (!source.text.trim() && !source.attachments.length)
      throw Error("请输入文字或选择图片");
    const fields = quickFillFields(schema).filter((f) =>
      config.fields.some((s) => s.fieldId === f.id),
    );
    const suggestions: QuickFillSuggestion[] = [],
      unmatched: string[] = [];
    const add = (key: string, value: unknown, evidence: string) => {
      const matches = fields.filter(
        (f) =>
          f.id === key ||
          f.label === key ||
          config.fields.find((s) => s.fieldId === f.id)?.aliases.includes(key),
      );
      if (matches.length !== 1) {
        unmatched.push(
          matches.length ? `${key} 对应多个字段，请使用唯一别名` : evidence,
        );
        return;
      }
      const old = suggestions.find((s) => s.fieldId === matches[0]!.id);
      if (old) {
        old.error = "同一字段出现多次，请检查原文或手动填写";
        return;
      }
      suggestions.push({ fieldId: matches[0]!.id, raw: value, evidence });
    };
    const text = source.text.trim();
    if (text.startsWith("{")) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw Error("JSON 格式不完整，请检查后重试");
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw Error("请输入字段名到值的 JSON 对象");
      for (const [key, value] of Object.entries(parsed))
        add(
          key,
          value,
          `${key}：${typeof value === "string" ? value : JSON.stringify(value)}`,
        );
    } else {
      for (const line of text
        .split(/\n|；/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const match = line.match(/^([^:：]+)[:：]\s*([\s\S]*)$/);
        if (match) add(match[1]!.trim(), match[2]!, line);
        else unmatched.push(line);
      }
    }
    if (source.attachments.length) {
      const target = fields.find((f) => ["image", "file"].includes(f.type));
      if (!target) throw Error("未配置图片或附件接收字段");
      if (suggestions.some((s) => s.fieldId === target.id))
        throw Error("图片接收字段同时出现在文字中，请保留一种来源");
      suggestions.push({
        fieldId: target.id,
        raw: source.attachments,
        evidence: "所选图片将附在记录中；未识别图片内文字",
      });
    }
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    return { mode: "local-demo", suggestions, unmatched };
  },
};
