import type { FieldType } from "./form";

export interface OcrContent {
  id: string;
  label: string;
  types: FieldType[];
  defaultType: FieldType;
  detail?: boolean;
}
export type OcrType =
  | "general"
  | "idCard"
  | "vatInvoice"
  | "businessLicense"
  | "drivingLicense"
  | "vehicleLicense"
  | "bankCard"
  | "trainTicket";
export interface OcrSettings {
  type: OcrType | "";
  mappings: { contentId: string; fieldId: string }[];
}
/** Output IDs are fixed catalogue IDs, independent of form field labels and IDs. */
export const ocrTemplates: {
  value: OcrType;
  label: string;
  contents: OcrContent[];
}[] = [
  {
    value: "general",
    label: "通用文字",
    contents: [
      {
        id: "general_01",
        label: "识别原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "general_02",
        label: "识别内容",
        types: ["text", "textarea"],
        defaultType: "text",
      },
    ],
  },
  {
    value: "idCard",
    label: "身份证",
    contents: [
      {
        id: "idCard_01",
        label: "身份证人像面原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "idCard_02",
        label: "姓名",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "idCard_03",
        label: "性别",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "idCard_04",
        label: "出生日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "idCard_05",
        label: "民族",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "idCard_06",
        label: "地址",
        types: ["text", "textarea", "address"],
        defaultType: "address",
      },
      {
        id: "idCard_07",
        label: "身份证号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "idCard_08",
        label: "身份证国徽面原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "idCard_09",
        label: "发证机关",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "idCard_10",
        label: "有效期限起始日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "idCard_11",
        label: "有效期限结束日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
    ],
  },
  {
    value: "vatInvoice",
    label: "增值税发票",
    contents: [
      {
        id: "vatInvoice_01",
        label: "发票原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "vatInvoice_02",
        label: "发票类型",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_03",
        label: "发票名称",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_04",
        label: "发票代码",
        types: ["text", "textarea", "number"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_05",
        label: "发票校验码",
        types: ["text", "textarea", "number"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_06",
        label: "发票号码",
        types: ["text", "textarea", "number"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_07",
        label: "发票日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "vatInvoice_08",
        label: "密码区",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_09",
        label: "购买方名称",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_10",
        label: "购买方纳税人识别号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_11",
        label: "购买方地址/电话",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_12",
        label: "购买方开户行及账号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_13",
        label: "销售方名称",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_14",
        label: "销售方纳税人识别号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_15",
        label: "销售方地址/电话",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_16",
        label: "销售方开户行及账号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_17",
        label: "合计金额",
        types: ["text", "textarea", "number"],
        defaultType: "number",
      },
      {
        id: "vatInvoice_18",
        label: "合计税额",
        types: ["text", "textarea", "number"],
        defaultType: "number",
      },
      {
        id: "vatInvoice_19",
        label: "价税合计（大写）",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_20",
        label: "价税合计（小写）",
        types: ["text", "textarea", "number"],
        defaultType: "number",
      },
      {
        id: "vatInvoice_21",
        label: "货物或应税劳务/服务名称",
        types: ["text", "textarea"],
        defaultType: "text",
        detail: true,
      },
      {
        id: "vatInvoice_22",
        label: "规格型号",
        types: ["text", "textarea"],
        defaultType: "text",
        detail: true,
      },
      {
        id: "vatInvoice_23",
        label: "数量",
        types: ["text", "textarea", "number"],
        defaultType: "number",
        detail: true,
      },
      {
        id: "vatInvoice_24",
        label: "单位",
        types: ["text", "textarea"],
        defaultType: "text",
        detail: true,
      },
      {
        id: "vatInvoice_25",
        label: "金额",
        types: ["text", "textarea", "number"],
        defaultType: "number",
        detail: true,
      },
      {
        id: "vatInvoice_26",
        label: "税率",
        types: ["text", "textarea", "number"],
        defaultType: "number",
        detail: true,
      },
      {
        id: "vatInvoice_27",
        label: "税额",
        types: ["text", "textarea", "number"],
        defaultType: "number",
        detail: true,
      },
      {
        id: "vatInvoice_28",
        label: "备注",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_29",
        label: "收款人",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_30",
        label: "复核人",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vatInvoice_31",
        label: "开票人",
        types: ["text", "textarea"],
        defaultType: "text",
      },
    ],
  },
  {
    value: "businessLicense",
    label: "营业执照",
    contents: [
      {
        id: "businessLicense_01",
        label: "营业执照原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "businessLicense_02",
        label: "注册号/社会保障号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "businessLicense_03",
        label: "企业名称",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "businessLicense_04",
        label: "企业类型",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "businessLicense_05",
        label: "地址",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "businessLicense_06",
        label: "法定代表人",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "businessLicense_07",
        label: "注册资本",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "businessLicense_08",
        label: "营业期限",
        types: ["text", "textarea", "datetime"],
        defaultType: "text",
      },
      {
        id: "businessLicense_09",
        label: "经营范围",
        types: ["text", "textarea"],
        defaultType: "text",
      },
    ],
  },
  {
    value: "drivingLicense",
    label: "驾驶证",
    contents: [
      {
        id: "drivingLicense_01",
        label: "驾驶证原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "drivingLicense_02",
        label: "证号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "drivingLicense_03",
        label: "姓名",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "drivingLicense_04",
        label: "性别",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "drivingLicense_05",
        label: "国籍",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "drivingLicense_06",
        label: "住址",
        types: ["text", "textarea", "address"],
        defaultType: "address",
      },
      {
        id: "drivingLicense_07",
        label: "出生日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "drivingLicense_08",
        label: "初次领证日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "drivingLicense_09",
        label: "准驾车型",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "drivingLicense_10",
        label: "有效期限起始日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "drivingLicense_11",
        label: "有效期限结束日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
    ],
  },
  {
    value: "vehicleLicense",
    label: "行驶证",
    contents: [
      {
        id: "vehicleLicense_01",
        label: "行驶证原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "vehicleLicense_02",
        label: "号码号牌",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vehicleLicense_03",
        label: "车辆类型",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vehicleLicense_04",
        label: "所有人",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vehicleLicense_05",
        label: "住址",
        types: ["text", "textarea", "address"],
        defaultType: "address",
      },
      {
        id: "vehicleLicense_06",
        label: "使用性质",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vehicleLicense_07",
        label: "品牌型号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vehicleLicense_08",
        label: "车辆识别代号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "vehicleLicense_09",
        label: "发动机号码",
        types: ["text", "textarea", "number"],
        defaultType: "number",
      },
      {
        id: "vehicleLicense_10",
        label: "注册日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "vehicleLicense_11",
        label: "发证日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
    ],
  },
  {
    value: "bankCard",
    label: "银行卡",
    contents: [
      {
        id: "bankCard_01",
        label: "银行卡原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "bankCard_02",
        label: "银行卡卡号",
        types: ["text", "textarea", "number"],
        defaultType: "text",
      },
      {
        id: "bankCard_03",
        label: "银行卡有效期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "bankCard_04",
        label: "银行卡类型",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "bankCard_05",
        label: "银行名称",
        types: ["text", "textarea"],
        defaultType: "text",
      },
    ],
  },
  {
    value: "trainTicket",
    label: "火车票",
    contents: [
      {
        id: "trainTicket_01",
        label: "火车票原件",
        types: ["image"],
        defaultType: "image",
      },
      {
        id: "trainTicket_02",
        label: "车票号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_03",
        label: "始发站",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_04",
        label: "车次号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_05",
        label: "到达站",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_06",
        label: "出发日期",
        types: ["text", "textarea", "datetime"],
        defaultType: "datetime",
      },
      {
        id: "trainTicket_07",
        label: "车票金额",
        types: ["text", "textarea", "number"],
        defaultType: "number",
      },
      {
        id: "trainTicket_08",
        label: "席别",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_09",
        label: "乘客姓名",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_10",
        label: "身份证号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_11",
        label: "序列号",
        types: ["text", "textarea"],
        defaultType: "text",
      },
      {
        id: "trainTicket_12",
        label: "售站",
        types: ["text", "textarea"],
        defaultType: "text",
      },
    ],
  },
];
export const emptyOcrSettings = (): OcrSettings => ({ type: "", mappings: [] });
export const ocrTemplate = (type: string) =>
  ocrTemplates.find((item) => item.value === type);
export function parseOcrSettings(raw: unknown): OcrSettings {
  const value = raw as OcrSettings;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.type !== "" && !ocrTemplate(value.type)) ||
    !Array.isArray(value.mappings) ||
    value.mappings.length > 102 ||
    value.mappings.some(
      (m) =>
        !m ||
        typeof m.contentId !== "string" ||
        !m.contentId ||
        typeof m.fieldId !== "string" ||
        !m.fieldId ||
        ["__proto__", "constructor", "prototype"].includes(m.fieldId),
    ) ||
    new Set(value.mappings.map((m) => m.contentId)).size !==
      value.mappings.length ||
    new Set(value.mappings.map((m) => m.fieldId)).size !== value.mappings.length
  )
    throw Error("文字识别规则配置无效");
  return {
    type: value.type,
    mappings: value.mappings.map((m) => ({
      contentId: m.contentId,
      fieldId: m.fieldId,
    })),
  };
}
