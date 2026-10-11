import { mapFrontendValues } from "./frontendEventValues";
import { compile } from "json-p3";
import {
  choiceValueLabel,
  validDateValue,
  type FrontendRequest,
  type ValueBinding,
} from "@platform/contracts";
import {
  copy,
  findField,
  uid,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { resolveChoices } from "./relations";
import {
  bindingReferences,
  validEndpoint,
  type ConfigIssue,
  type ExtensionRun,
} from "./extensions";
import type { WorkspaceData } from "./workspace";

export const requestOutputTypes = new Set([
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "address",
]);
export function newFrontendRequest(): FrontendRequest {
  return {
    method: "GET",
    url: { source: "template", value: "" },
    headers: [],
    bodyFormat: "json",
    body: [],
    responseFormat: "json",
    outputs: [],
    subformFill: "merge",
    simulation: { status: 200, response: "{}" },
  };
}
export function requestBindings(
  request: FrontendRequest,
  includeInactive = false,
) {
  return [
    request.url,
    ...request.headers.map((row) => row.value),
    ...(request.method === "POST" || includeInactive
      ? request.body.map((row) => row.value)
      : []),
    ...request.outputs.map((row) => row.path),
  ];
}
export function requestBindingValue(
  binding: ValueBinding,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  encode = false,
): unknown {
  const value = (id: string) => {
    const field = findField(schema.fields, id);
    if (!field) throw Error("引用字段已被移除");
    const raw = values[id];
    if (raw === undefined || raw === null) return "";
    if (["radio", "select", "checkbox", "multiselect"].includes(field.type)) {
      const choices = resolveChoices(field, data, values, schema.fields);
      return (Array.isArray(raw) ? raw : [raw])
        .map((item) => choiceValueLabel(choices, item))
        .join(",");
    }
    if (field.type === "datetime" && raw) {
      if (typeof raw !== "string" || !validDateValue(field.format, raw))
        throw Error(`${field.label}：日期值无效`);
      const date = new Date(
        raw.length === 7
          ? `${raw}-01T00:00:00`
          : raw.length === 10
            ? `${raw}T00:00:00`
            : raw,
      );
      return date.toISOString();
    }
    if (
      ["file", "image", "signature"].includes(field.type) &&
      raw &&
      (!Array.isArray(raw) || raw.length)
    )
      throw Error("文件尚无可访问的服务器URL，请使用已接通的文本地址字段");
    if (["address", "location"].includes(field.type) && typeof raw === "object")
      return Object.values(raw)
        .filter((item) => item !== undefined && item !== "")
        .join("/");
    return raw;
  };
  const print = (v: unknown) =>
    typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
  if (binding.source === "field") return value(binding.value);
  if (binding.source === "constant") return binding.value;
  if (/^\{\{[^{}]+\}\}$/.test(binding.value))
    return value(binding.value.slice(2, -2).trim());
  return binding.value.replace(/\{\{([^{}]+)\}\}/g, (_, id: string) =>
    encode
      ? encodeURIComponent(print(value(id.trim())))
      : print(value(id.trim())),
  );
}
export function requestParameterIssues(
  request: FrontendRequest,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [label, rows] of [
    ["Header", request.headers],
    ...(request.method === "POST" ? [["Body", request.body]] : []),
  ] as [string, FrontendRequest["headers"]][]) {
    const names = new Set<string>();
    for (const row of rows) {
      const name = label === "Header" ? row.name.toLowerCase() : row.name;
      if (
        !row.name.trim() ||
        row.name !== row.name.trim() ||
        ["__proto__", "constructor", "prototype"].includes(row.name) ||
        (label === "Header" && !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(row.name))
      )
        issues.push({
          step: 1,
          target: "request-parameters",
          message: `${label}：请填写有效的参数名`,
        });
      else if (names.has(name))
        issues.push({
          step: 1,
          target: "request-parameters",
          message: `${label}：参数名不能重复`,
        });
      names.add(name);
    }
  }
  return issues;
}
export function requestIssues(
  request: FrontendRequest,
  inputSchema: FormSchema,
  outputs: FormField[],
): ConfigIssue[] {
  const issues = requestParameterIssues(request);
  for (const binding of requestBindings(request))
    if (
      bindingReferences(binding).some(
        (id) => !inputSchema.fields.some((field) => field.id === id),
      )
    )
      issues.push({
        step: 1,
        target: "request-fields",
        message: "请求引用字段已移除或不在触发范围",
      });
  if (
    !request.url.value.trim() ||
    (!bindingReferences(request.url).length &&
      !validEndpoint(request.url.value))
  )
    issues.push({
      step: 1,
      target: "request-url",
      message: "请输入有效的HTTP或HTTPS请求地址",
    });
  const seen = new Set<string>();
  for (const mapping of request.outputs) {
    if (
      !outputs.some(
        (field) =>
          field.id === mapping.fieldId && requestOutputTypes.has(field.type),
      )
    )
      issues.push({
        step: 1,
        target: "request-outputs",
        message: "回填字段已移除、类型不支持或不在触发范围",
      });
    if (seen.has(mapping.fieldId))
      issues.push({
        step: 1,
        target: "request-outputs",
        message: "同一字段只能配置一个返回值",
      });
    seen.add(mapping.fieldId);
    if (!mapping.path.value.trim())
      issues.push({
        step: 1,
        target: "request-outputs",
        message: "请填写返回值的解析路径",
      });
    else if (!bindingReferences(mapping.path).length)
      try {
        validateResponsePath(request.responseFormat, mapping.path.value);
      } catch {
        issues.push({
          step: 1,
          target: "request-outputs",
          message: `返回值${request.responseFormat === "json" ? "JSON Path" : "XPath"}无效`,
        });
      }
  }
  return issues;
}
export function validateResponsePath(format: "json" | "xml", path: string) {
  if (format === "json") return compile(path);
  if (typeof DOMParser === "undefined") throw Error("当前环境不支持XML解析");
  const doc = new DOMParser().parseFromString("<root/>", "application/xml");
  doc.createExpression(path, null);
}
function responseValue(
  format: "json" | "xml",
  response: unknown,
  path: string,
) {
  if (format === "json") {
    const parsed = compile(path),
      nodes = parsed.query(response as any).values();
    if (!nodes.length && parsed.singularQuery())
      throw Error("返回数据中找不到该路径");
    return parsed.singularQuery() ? nodes[0] : nodes;
  }
  const doc = response as Document;
  const result = doc.evaluate(
    path,
    doc,
    (prefix) => doc.lookupNamespaceURI(prefix),
    0,
    null,
  );
  if (result.resultType === 1) return result.numberValue;
  if (result.resultType === 2) return result.stringValue;
  if (result.resultType === 3) return result.booleanValue;
  const values: string[] = [];
  let node: Node | null;
  while ((node = result.iterateNext())) values.push(node.textContent || "");
  if (!values.length) throw Error("返回数据中找不到该路径");
  return values.length === 1 ? values[0] : values;
}
export function runFrontendRequest(
  request: FrontendRequest,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  fields: (FormField & { parentId: string })[],
  row?: { subformId: string; index: number },
  forceFailure = false,
): ExtensionRun {
  const run: ExtensionRun = {
    id: uid("run"),
    formId: "",
    subjectId: "",
    name: "自定义请求",
    kind: "plugin",
    time: new Date().toISOString(),
    status: "success",
    mode: "simulation",
    origin: "trial",
    input: {},
    output: {},
    mappedValues: {},
    steps: [],
    snapshot: { config: copy(request), schema: copy(schema), values: {} },
  };
  let target = "request-url",
    stage = "构造请求";
  try {
    const url = String(
      requestBindingValue(request.url, schema, values, data, true),
    );
    if (!validEndpoint(url)) throw Error("解析后的请求地址无效");
    const headers: Record<string, unknown> = {},
      body: Record<string, unknown> = {};
    target = "request-parameters";
    for (const param of request.headers) {
      const value = String(
        requestBindingValue(param.value, schema, values, data),
      );
      if (/[\r\n]/.test(value)) throw Error("Header值不能包含换行");
      headers[param.name] = /authorization|cookie|api.?key|token|secret/i.test(
        param.name,
      )
        ? "（已隐藏）"
        : value;
    }
    if (request.method === "POST")
      for (const param of request.body)
        body[param.name] = String(
          requestBindingValue(param.value, schema, values, data),
        );
    run.input = {
      method: request.method,
      url,
      headers,
      ...(request.method === "POST"
        ? {
            body:
              request.bodyFormat === "json"
                ? body
                : new URLSearchParams(
                    Object.entries(body).map(([name, value]) => [
                      name,
                      String(value),
                    ]),
                  ).toString(),
            bodyFormat:
              request.bodyFormat === "json"
                ? "application/json"
                : "application/x-www-form-urlencoded",
          }
        : {}),
    };
    run.steps.push({
      label: stage,
      status: "success",
      detail: "已解析当前填写的请求参数",
    });
    stage = "模拟响应";
    target = "request-simulation";
    if (
      forceFailure ||
      request.simulation.status < 200 ||
      request.simulation.status >= 300
    )
      throw Error(
        `模拟请求失败（${forceFailure ? 500 : request.simulation.status}），未回填任何字段`,
      );
    if (
      new TextEncoder().encode(request.simulation.response).byteLength > 262144
    )
      throw Error("返回数据不能超过256KB");
    let response: unknown;
    if (request.responseFormat === "json") {
      try {
        response = JSON.parse(request.simulation.response);
      } catch {
        throw Error("模拟返回内容不是有效JSON");
      }
    } else {
      if (/<!DOCTYPE|<!ENTITY/i.test(request.simulation.response))
        throw Error("XML返回内容不能包含外部实体声明");
      const doc = new DOMParser().parseFromString(
        request.simulation.response,
        "application/xml",
      );
      if (doc.querySelector("parsererror"))
        throw Error("模拟返回内容不是有效XML");
      response = doc;
    }
    run.output = {
      statusCode: request.simulation.status,
      response: request.simulation.response,
    };
    run.steps.push({
      label: stage,
      status: "success",
      detail: "已载入配置的模拟返回数据",
    });
    stage = "解析并回填";
    target = "request-outputs";
    const parsed = request.outputs.map((mapping) => {
      const field = fields.find((field) => field.id === mapping.fieldId)!;
      const path = String(
        requestBindingValue(mapping.path, schema, values, data),
      );
      let value: unknown;
      try {
        value = responseValue(request.responseFormat, response, path);
      } catch {
        throw Error(`${field.label}：返回值路径无效或未找到数据`);
      }
      if (
        field.parentId &&
        !row &&
        request.responseFormat === "xml" &&
        !Array.isArray(value)
      )
        value = [value];
      return { fieldId: field.id, value };
    });
    run.mappedValues = mapFrontendValues(
      schema,
      values,
      data,
      fields,
      parsed,
      request.subformFill,
      row,
    );
    run.steps.push({
      label: stage,
      status: "success",
      detail: `已解析${request.outputs.length}个返回值`,
    });
  } catch (e) {
    run.status = "failed";
    run.mappedValues = {};
    run.output = {};
    run.error = { step: 1, target, message: (e as Error).message };
    run.steps.push({
      label: stage,
      status: "failed",
      detail: run.error.message,
    });
  }
  return run;
}
