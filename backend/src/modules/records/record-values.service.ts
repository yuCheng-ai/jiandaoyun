import { BadRequestException, Injectable } from "@nestjs/common";
import {
  fieldDefaultValue,
  isOrganizationField,
  fieldPermission as permission,
  resolveCalculations,
  type AccessGrant,
  type FormField,
  type FormSchema,
  type FormValues,
} from "@platform/contracts";
import { Actor } from "../../core/auth/auth.service";
import { Database } from "../../core/database/database";
import { object } from "../../core/validation";
import { OrganizationService } from "../directory/organization.service";
import {
  historicalLabels,
  organizationDefaultResolver,
  organizationLabels,
  validateOrganizationDefinition,
  validateOrganizationValues,
} from "./organization-fields";
import { allFields, masked, newValues } from "./record-schema";

type Queryable = Pick<Database, "query">;

/** 记录字段的组织上下文、默认值和写入校验；不负责页面设计或流程调度。 */
@Injectable()
export class RecordValuesService {
  constructor(private readonly organizations: OrganizationService) {}

  /** 校验表单定义中的组织字段配置在当前工作空间组织架构下是否有效 */
  async validateOrganizationModel(tx: Queryable, actor: Actor, schema: FormSchema) {
    if (allFields(schema).some((field) => isOrganizationField(field.type))) {
      const snapshot = await this.organizations.snapshot(tx, actor);
      validateOrganizationDefinition(schema, snapshot);
    }
  }

  /** 校验记录中的组织字段值是否符合组织范围与权限约束 */
  async validateRecordOrganizations(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    values: FormValues,
    before?: FormValues,
    access?: AccessGrant,
  ) {
    if (allFields(schema).some((field) => isOrganizationField(field.type))) {
      const snapshot = await this.organizations.snapshot(tx, actor);
      const visibleFieldIds = access
        ? new Set(allFields(masked(schema, values, {}, access).schema).map((field) => field.id))
        : undefined;
      validateOrganizationValues(schema, values, snapshot, actor.id, before, visibleFieldIds);
    }
  }

  /** 解析记录中涉及的组织成员、部门与角色历史身份显示名称 */
  async identityLabels(tx: Queryable, actor: Actor, schema: FormSchema, values: FormValues) {
    if (!allFields(schema).some((field) => isOrganizationField(field.type))) {
      return [];
    }
    const snapshot = await this.organizations.snapshot(tx, actor);
    return historicalLabels(tx, actor, organizationLabels(schema, values, snapshot));
  }

  /**
   * 构造字段默认值解析器：
   * - 支持静态默认值、日期当时值、动态组织默认值（当前成员/主部门/部门负责人）以及默认值公式计算。
   */
  async defaultResolver(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    values: FormValues = {},
    base: FormValues = {},
    fullSchema = schema,
    access?: AccessGrant,
    strict = false,
  ) {
    const hasOrgField = allFields(schema).some((field) => isOrganizationField(field.type));
    const resolveOrg = hasOrgField
      ? organizationDefaultResolver(
          fullSchema,
          await this.organizations.snapshot(tx, actor),
          actor.id,
          values,
          base,
        )
      : (field: FormField) => field.defaultValue;

    const now = new Date();
    const basic = (field: FormField, row?: FormValues) =>
      isOrganizationField(field.type) ? resolveOrg(field, row) : fieldDefaultValue(field, now);

    const formulas = allFields(schema).filter((field) => field.defaultFormula);
    if (!formulas.length) return basic;

    const supplied = (field: FormField, input: FormValues, parent?: FormField) =>
      (!access || permission(access, field, parent) === "edit") && input[field.id] != null;

    const seed = (fields: FormField[], input: FormValues, parent?: FormField): FormValues =>
      Object.fromEntries(
        fields.map((field) => {
          if (field.type === "subform") {
            const rawRows = Array.isArray(input[field.id]) ? (input[field.id] as FormValues[]) : [];
            const seededRows = rawRows.map((row) =>
              row && typeof row === "object" && !Array.isArray(row)
                ? seed(field.children, row, field)
                : {},
            );
            return [field.id, seededRows];
          }
          if (supplied(field, input, parent)) {
            return [field.id, input[field.id]];
          }
          const fallback = field.defaultFormula
            ? undefined
            : basic(field, parent ? input : undefined);
          return [field.id, fallback];
        }),
      );

    const failures = new Set<string>();
    const calculated = resolveCalculations(schema.fields, seed(schema.fields, values), base, {
      fields: fullSchema.fields,
      now,
      defaults: formulas.map((field) => field.id),
      enabled: (field, input) => input[field.id] === undefined,
      onError: (field) => failures.add(field.id),
    });

    if (strict && failures.size) {
      throw new BadRequestException("默认值计算未完成，请检查相关填写内容或联系表单管理员。");
    }

    return (field: FormField, row?: FormValues) => {
      const parent = schema.fields.find((item) =>
        item.children.some((child) => child.id === field.id),
      );
      if (!parent) return calculated[field.id];

      const index = Array.isArray(values[parent.id])
        ? (values[parent.id] as FormValues[]).findIndex(
            (item) => item === row || (!!row?._rowId && item._rowId === row._rowId),
          )
        : -1;
      const target = (calculated[parent.id] as FormValues[])?.[index];
      return target && Object.hasOwn(target, field.id) ? target[field.id] : basic(field, row);
    };
  }

  /** 生成新建记录时的主表初始默认值映射 */
  async recordDefaults(tx: Queryable, actor: Actor, schema: FormSchema) {
    const resolve = await this.defaultResolver(tx, actor, schema);
    return Object.fromEntries(
      schema.fields.map((field) => [field.id, field.type === "subform" ? [] : resolve(field)]),
    );
  }

  /** 根据用户输入与默认值规则构造新记录的值与初始单元格版本 */
  async createValues(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    input: unknown,
    access: AccessGrant,
    base: FormValues = {},
    fullSchema = schema,
    strictDefaults = true,
  ) {
    object(input);
    const resolve = await this.defaultResolver(
      tx,
      actor,
      schema,
      input,
      base,
      fullSchema,
      access,
      strictDefaults,
    );
    return newValues(schema, input, access, resolve);
  }
}
