import { createField, copy, uid } from "./form";
import {
  emptyChoiceSource,
  emptyReference,
  emptyOrganizationConfig,
} from "./fieldConfig";
import { newForm, type FormEntry, type FormRecord } from "./workspace";
/** Explicitly installed sample; existing user forms and entries are never replaced. */
export function createRelationDemo(appId: string): {
  forms: FormRecord[];
  entries: FormEntry[];
} {
  const customer = newForm(appId, "客户档案 · 关联示例"),
    order = newForm(appId, "销售订单 · 关联示例");
  const name = createField("text", { label: "客户名称", required: true }),
    region = createField("select", {
      label: "所在区域",
      options: [
        { id: "east", label: "华东" },
        { id: "south", label: "华南" },
      ],
    }),
    contact = createField("text", { label: "联系人" }),
    phone = createField("phone", { label: "联系电话" });
  const regionInput = createField("select", {
    label: "业务区域",
    required: true,
    options: copy(region.options),
    width: 6,
  });
  const dynamic = createField("select", {
    label: "客户简称（动态选项）",
    choiceSource: {
      ...emptyChoiceSource(),
      mode: "form",
      formId: customer.id,
      labelFieldId: name.id,
      valueFieldId: name.id,
      sort: "asc",
      filters: [
        {
          id: uid("filter"),
          sourceFieldId: region.id,
          operator: "equals",
          source: "field",
          value: regionInput.id,
        },
      ],
    },
  });
  const contactInput = createField("text", { label: "联系人", width: 6 }),
    phoneInput = createField("phone", { label: "联系电话", width: 6 });
  const relation = createField("relation", {
    label: "签约客户",
    required: true,
    referenceFormId: customer.id,
    referenceFieldId: name.id,
    reference: {
      ...emptyReference(),
      columns: [name.id, region.id, contact.id, phone.id],
      filters: [
        {
          id: uid("filter"),
          sourceFieldId: region.id,
          operator: "equals",
          source: "field",
          value: regionInput.id,
        },
      ],
      mappings: [
        { sourceFieldId: contact.id, targetFieldId: contactInput.id },
        { sourceFieldId: phone.id, targetFieldId: phoneInput.id },
      ],
    },
  });
  const related = createField("relationTable", {
    label: "协作客户",
    referenceFormId: customer.id,
    referenceFieldId: name.id,
    reference: {
      ...emptyReference(),
      columns: [name.id, contact.id, phone.id],
    },
  });
  const amount = createField("number", {
    label: "订单金额",
    min: 0,
    required: true,
    width: 6,
  });
  const team = createField("department", {
    label: "负责部门",
    width: 6,
    organization: {
      ...emptyOrganizationConfig(),
      defaultMode: "currentDepartment",
    },
  });
  const owner = createField("member", {
    label: "业务负责人",
    width: 6,
    organization: {
      ...emptyOrganizationConfig(),
      defaultMode: "currentUser",
      scope: {
        ...emptyOrganizationConfig().scope,
        mode: "fieldDepartment",
        fieldId: team.id,
      },
    },
  });
  const tags = createField("multiselect", {
    label: "服务项目",
    options: [
      { id: "design", label: "设计服务" },
      { id: "development", label: "开发服务" },
      { id: "support", label: "维护支持" },
    ],
    defaultValue: ["design", "development"],
  });
  const reverse = createField("relationTable", {
    label: "客户订单",
    referenceFormId: order.id,
    referenceFieldId: amount.id,
    reference: {
      ...emptyReference(),
      mode: "reverse",
      reverseFieldId: relation.id,
      columns: [relation.id, contactInput.id, amount.id, owner.id],
    },
  });
  customer.schema.fields = [name, region, contact, phone, reverse];
  customer.schema.settings.description =
    "维护客户资料，并在记录详情中查看关联订单。";
  order.schema.fields = [
    regionInput,
    dynamic,
    relation,
    contactInput,
    phoneInput,
    team,
    owner,
    amount,
    tags,
    related,
  ];
  order.schema.settings.description =
    "先选择业务区域，再选择签约客户；联系人与电话自动回填。负责人的范围由部门决定。";
  for (const form of [customer, order]) {
    form.published = {
      version: 1,
      title: form.title,
      schema: copy(form.schema),
      workflow: copy(form.workflow),
      publishedAt: new Date().toISOString(),
    };
    form.versions = [copy(form.published)];
  }
  const entries: FormEntry[] = [
    ["青禾设计", "east", "林小禾", "13800000001"],
    ["南屿科技", "south", "陈知南", "13800000002"],
    ["星河制造", "east", "周星远", "13800000003"],
  ].map(([n, r, c, p]) => ({
    id: uid("entry"),
    formId: customer.id,
    definitionVersion: 1,
    values: { [name.id]: n, [region.id]: r, [contact.id]: c, [phone.id]: p },
    createdAt: new Date().toISOString(),
    status: "submitted",
    history: [
      {
        label: "示例数据",
        action: "submitted",
        time: new Date().toISOString(),
      },
    ],
  }));
  return { forms: [customer, order], entries };
}
