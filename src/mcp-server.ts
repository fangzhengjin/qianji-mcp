import { randomUUID } from "node:crypto";

import {
  McpServer,
  UrlElicitationRequiredError,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  BindingTicketManager,
  requireAccountPrincipal,
  requireAdmin,
  requirePatPrincipal,
  type AuthenticatedPat,
} from "./auth.ts";
import type { DataStore, PatRecord } from "./data-store.ts";
import { AppError, safeError } from "./errors.ts";
import {
  isCurrencySymbol,
  MAX_JAVA_LONG_ID_LENGTH,
  OPTIONAL_POSITIVE_ID_PATTERN,
  PARENT_ID_PATTERN,
  POSITIVE_ID_PATTERN,
} from "./ids.ts";
import { MAX_BILL_CURSOR_LENGTH, MAX_MONEY, MAX_SEARCH_KEYWORD_LENGTH } from "./bill-rules.ts";
import { MoneyTrackService } from "./qianji-service.ts";
import serverInstructions from "./server-instructions.md" with { type: "text" };

const bindingExpiryFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "medium",
  hour12: false,
});
const positiveIdText = z.string().regex(POSITIVE_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH)
  .describe("ID");
const optionalAssetIdInputText = positiveIdText.nullable();
const parentIdText = z.string().regex(PARENT_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH)
  .describe("父分类 ID");
const bookIdText = z.string().regex(OPTIONAL_POSITIVE_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH)
  .describe("账本 ID，\"-1\" 表示默认账本");
const defaultBookIdText = bookIdText.optional().meta({
  description: "账本 ID，\"-1\" 表示默认账本",
  default: "-1",
});
const simpleBillTypeSchema = z.union([
  z.literal(0).describe("支出"),
  z.literal(1).describe("收入"),
]).describe("账单类型");
const knownBillTypeSchema = z.union([
  z.literal(0).describe("支出"),
  z.literal(1).describe("收入"),
  z.literal(2).describe("转账"),
  z.literal(3).describe("信用卡还款"),
  z.literal(4).describe("收回借出款"),
  z.literal(5).describe("待报销支出（报销源账单）"),
  z.literal(6).describe("新增借入"),
  z.literal(7).describe("新增借出"),
  z.literal(9).describe("偿还借入款"),
  z.literal(10).describe("借入利息支出"),
  z.literal(11).describe("借出利息收入"),
  z.literal(20).describe("退款子账单"),
  z.literal(21).describe("报销入账子账单"),
  z.literal(22).describe("报销批次汇总记录（由客户端构造用于合并展示，不是单笔报销入账）"),
]).describe("钱迹账单类型");
const billFlagOutputSchemas = {
  excludeFromIncomeExpense: z.boolean().describe("是否不计入收支统计，对应钱迹 APP 的“不计收支”选项"),
  excludeFromBudget: z.boolean().describe("是否不计入预算，对应钱迹 APP 的“不计预算”选项"),
};
const billFlagCreateSchemas = {
  excludeFromIncomeExpense: z.boolean().optional().default(false)
    .describe("是否不计入收支统计"),
  excludeFromBudget: z.boolean().optional().default(false)
    .describe("是否不计入预算"),
};
const billFlagPatchSchemas = {
  excludeFromIncomeExpense: z.boolean().optional()
    .describe("新的不计收支状态"),
  excludeFromBudget: z.boolean().optional()
    .describe("新的不计预算状态"),
};
const opaqueIdText = z.string().min(1);
const tagIdsSchema = z.array(opaqueIdText).max(100).describe("标签 ID 列表");
const writeTagIdsSchema = z.array(opaqueIdText).max(8)
  .refine((ids) => new Set(ids).size === ids.length, "标签 ID 不能重复")
  .meta({ uniqueItems: true });
// 部分 MCP 调用层会用 IEEE-754 直接判断 multipleOf: 0.01，导致 0.28 等合法金额被误拒
// 最多两位小数继续由 bill-rules.ts 的唯一金额校验入口保证
const positiveMoneySchema = z.number().finite().positive().max(MAX_MONEY);
const nonnegativeMoneySchema = z.number().finite().nonnegative().max(MAX_MONEY);
const currencySymbolSchema = z.string().min(1)
  .refine(isCurrencySymbol, "币种标识不能为空")
  .describe("币种标识");
const searchKeywordSchema = z.string().max(MAX_SEARCH_KEYWORD_LENGTH).trim().min(1);
const repaymentRuleTypeSchema = z.union([
  z.literal("dayOfMonth").describe("每月固定还款日"),
  z.literal("daysAfterStatement").describe("账单日后若干天"),
]).describe("还款规则类型");
const debtDirectionSchema = z.union([
  z.literal("borrowed").describe("借入"),
  z.literal("lent").describe("借出"),
]).describe("借贷方向");
const debtStatusSchema = z.union([
  z.literal("active").describe("进行中"),
  z.literal("ended").describe("已结束"),
]).describe("借贷状态");
const tagMatchSchema = z.union([
  z.literal("any").describe("匹配任一标签"),
  z.literal("all").describe("匹配全部标签"),
]).describe("标签匹配方式");
const billSortSchema = z.union([
  z.literal("timeDesc").describe("按账单时间倒序"),
  z.literal("timeAsc").describe("按账单时间正序"),
  z.literal("moneyDesc").describe("按账单金额倒序"),
  z.literal("moneyAsc").describe("按账单金额正序"),
]).describe("账单排序方式");
const statisticsUnitSchema = z.union([
  z.literal("day").describe("日"),
  z.literal("month").describe("月"),
  z.literal("year").describe("年"),
]).describe("统计期间单位");
const billSourceNameSchema = z.union([
  z.literal("manual").describe("手动记账"),
  z.literal("repeatTask").describe("周期任务"),
  z.literal("import").describe("导入记账"),
  z.literal("installment").describe("分期记账"),
  z.literal("automatic").describe("自动记账"),
  z.literal("unknown").describe("未知来源"),
]).describe("账单来源名称");
const patRoleSchema = z.union([
  z.literal("admin").describe("超级管理员"),
  z.literal("user").describe("普通用户"),
]).describe("PAT 角色");
const registrationMethodSchema = z.enum(["手机号", "微博", "QQ", "邮箱", "微信", "Apple ID", "华为账号"])
  .describe("注册方式");
const vipTypeSchema = z.union([
  z.literal("未开通").describe("没有会员权益"),
  z.literal("试用").describe("临时体验会员权益"),
  z.literal("单月VIP").describe("有效期为一个月的会员"),
  z.literal("6个月VIP").describe("有效期为六个月的会员"),
  z.literal("年VIP").describe("有效期为一年的会员"),
  z.literal("终身VIP").describe("永久有效的会员"),
  z.literal("VIP").describe("上游未细分的有效会员类型"),
]).describe("VIP 类型");
const bookVisibilitySchema = z.union([
  z.literal(1).describe("可见"),
  z.literal(0).describe("隐藏"),
]).describe("账本可见状态");
const bookExpiredSchema = z.union([
  z.literal(1).describe("成员账本已过期"),
  z.literal(0).describe("未标记过期"),
]).describe("账本过期状态");
const categoryTypeSchema = z.union([
  z.literal(0).describe("支出分类"),
  z.literal(1).describe("收入分类"),
]).describe("分类类型");
const categoryLevelSchema = z.union([
  z.literal(1).describe("一级分类"),
  z.literal(2).describe("二级分类"),
]).describe("分类层级");
const tagStatusSchema = z.union([
  z.literal(1).describe("正常"),
  z.literal(2).describe("归档"),
]).describe("标签状态");
const assetStatusSchema = z.union([
  z.literal(-1).describe("无状态"),
  z.literal(0).describe("正常"),
  z.literal(1).describe("债务或借贷已结束"),
  z.literal(2).describe("已隐藏"),
]).describe("资产状态");
const moneyUnitDescription = "使用币种主单位，不使用分、美分等最小货币单位，例如 CNY 8100 表示 8100 元，USD 63 表示 63 美元，JPY 500 表示 500 日元";
const billInputMoneyDescription = `默认使用所选资产币种，传 currencyConversion.sourceCurrency 时使用该来源币种，未选择资产且未指定来源币种时使用钱迹本位币，${moneyUnitDescription}`;
const adjustmentMoneyDescription = "对应钱迹 APP 主金额输入框：普通支出实际扣款为 money - discount，转账手续费场景转出 money、转入 money - fee，转账优惠场景转出 money - discount、转入 money";
const billAdjustmentMoneyDescription = `${adjustmentMoneyDescription}，${billInputMoneyDescription}`;
const sourceAssetMoneyDescription = `使用转出资产币种，${moneyUnitDescription}`;
const transferMoneyDescription = `${adjustmentMoneyDescription}，${sourceAssetMoneyDescription}`;
const sourceBillMoneyDescription = `使用源账单币种，${moneyUnitDescription}`;
const billAssetIdDescription = "主关联资产 ID，用于收支、退款、报销入账和借贷资金账户，没有主关联资产时为 null";
const billFromIdDescription = "来源关联资产 ID，用于转账、信用卡还款和部分借贷流水，上游未返回时省略";
const billTargetIdDescription = "目标关联资产 ID，用于转账、信用卡还款和部分借贷流水，上游未返回时省略";

const bookSchema = z.object({
  bookId: bookIdText.describe("账本 ID"),
  name: z.string().describe("账本名称"),
  visible: bookVisibilitySchema,
  type: z.number().int().describe("钱迹动态下发的账本模板类型代码"),
  memberCount: z.number().int().describe("账本成员数量，单位为人"),
  expired: bookExpiredSchema,
});
const bookMemberSchema = z.object({
  userId: z.string().min(1).describe("账本成员用户 ID，可直接用于账单和统计的 memberIds 筛选"),
  name: z.string().describe("账本成员名称"),
});
const assetSchema = z.object({
  id: positiveIdText.describe("资产 ID"),
  name: z.string().describe("资产名称"),
  money: z.number().optional().describe(`资产当前余额，仅当 list_assets.includeBalances=true 时返回，${moneyUnitDescription}`),
  currency: currencySymbolSchema.describe("资产币种标识，钱迹原始值为空时按 APK 规则返回当前本位币"),
  type: z.number().int().describe("钱迹资产一级类型代码：1 资金，2 信用卡，3 充值，4 投资，5 债务记录，6 债务汇总，7 社会保障，其他值由钱迹动态目录定义"),
  subtype: z.number().int().describe("钱迹资产子类型代码：51 借入，52 借出，61 借入汇总，62 借出汇总，其他值由钱迹动态目录定义"),
  status: assetStatusSchema,
  inCount: z.number().int().describe("是否计入总资产：1 为计入，其他值为不计入"),
  credit: z.object({
    statementDay: z.number().int().positive().optional().describe("信用账户账单日，按每月自然日表示"),
    repaymentRule: z.object({
      type: repaymentRuleTypeSchema,
      value: z.number().int().positive().describe("固定还款日或账单日后的天数"),
    }).optional().describe("信用账户还款规则"),
    nextRepaymentDate: z.number().int().nonnegative().optional().describe("按钱迹规则计算的下一还款日，UTC+08:00 当日零点 Unix 秒"),
    limit: z.number().nonnegative().optional().describe(`信用额度，仅当 list_assets.includeBalances=true 时返回，${moneyUnitDescription}`),
  }).optional().describe("仅信用账户返回的账单日、还款规则和下一还款日，额度仅在 includeBalances=true 时返回"),
});
const assetGroupSchema = z.object({
  name: z.string().describe("资产分组名称，分组标题不可用于账单资产 ID"),
  children: z.array(assetSchema).describe("组内资产列表"),
});
const categoryFields = {
  id: positiveIdText.describe("分类 ID"),
  name: z.string().describe("分类名称"),
  type: categoryTypeSchema,
  level: categoryLevelSchema,
  parentId: parentIdText.describe("父分类 ID，-1 或 0 表示无父分类"),
};
const categoryChildSchema = z.object(categoryFields);
const categorySchema = z.object({
  ...categoryFields,
  children: z.array(categoryChildSchema).describe("直属二级分类，没有二级分类时为空数组"),
});
const tagSchema = z.object({
  id: z.string().min(1).describe("标签 ID，不透明非空字符串"),
  name: z.string().describe("标签名称"),
  status: tagStatusSchema,
});
const tagGroupSchema = z.object({
  groupId: z.string().describe("标签组 ID，不透明字符串，空字符串表示默认组，不可作为账单标签 ID"),
  name: z.string().describe("标签组名称，默认组名称可能为空，分组标题不可选择"),
  children: z.array(tagSchema).describe("组内标签列表"),
});
const billRelationshipSchemas = {
  refundSourceBillId: positiveIdText.optional().describe("退款来源账单 ID，仅退款子账单返回"),
  refundBillIds: z.array(positiveIdText).optional().describe("源账单关联的退款账单 ID 列表"),
  refundProgress: z.object({
    totalAmount: z.number().nonnegative().describe("累计退款金额，使用源账单币种且保留超额退款事实"),
    remainingAmount: z.number().nonnegative().describe("按 APK 口径计算的剩余可退款金额，使用源账单币种且超额退款后为 0"),
  }).optional().describe("源账单存在退款关系时返回的退款进度"),
  reimbursementSourceBillId: positiveIdText.optional().describe("报销来源账单 ID，仅报销子账单返回"),
  reimbursementBillIds: z.array(positiveIdText).optional().describe("源账单关联的报销账单 ID 列表"),
  reimbursementProgress: z.object({
    totalAmount: z.number().nonnegative().describe("累计报销金额，使用源账单币种且保留超额报销事实"),
    remainingAmount: z.number().nonnegative().describe("按 APK 口径扣除退款和报销后的剩余可报销金额，使用源账单币种且超额报销后为 0"),
  }).optional().describe("源账单存在报销关系时返回的报销进度"),
};
const currencyConversionSchema = z.object({
  sourceCurrency: currencySymbolSchema.describe("用户原始记账或转出金额使用的币种标识"),
  sourceAmount: z.number().describe("用户输入的来源币种主金额，手续费或优惠由账单自身字段解释"),
  targetCurrency: currencySymbolSchema.optional().describe("入账资产或转入资产使用的目标币种标识，没有目标资产时省略"),
  targetAmount: z.number().optional().describe("写入目标资产的换算金额，仅在 targetCurrency 存在时返回"),
  baseCurrency: currencySymbolSchema.optional().describe("该账单写入时的钱迹账户本位币标识，APK 省略与来源币种重复的本位信息时省略"),
  baseAmount: z.number().optional().describe("该账单写入时保存的本位币金额，与 baseCurrency 同时出现，历史统计不按最新价格重算"),
}).describe("账单写入时保存的完整跨币种结果，同币种且钱迹未生成 extra.curr 时整体省略");
const billAttributionSchemas = {
  createdBy: z.object({
    userId: z.string().describe("记账人的钱迹用户 ID，上游缺失时为空字符串"),
    name: z.string().describe("记账人显示名，上游缺失时为空字符串"),
  }).describe("账单记账人"),
  source: z.object({
    code: z.number().int().describe("钱迹账单来源原始代码"),
    name: billSourceNameSchema,
  }).describe("账单创建来源"),
  currencyConversion: currencyConversionSchema.optional(),
};
const billFields = {
  id: positiveIdText.describe("账单 ID 的十进制字符串"),
  bookId: bookIdText.describe("账本 ID"),
  time: z.number().int().describe("账单发生时间，Unix 秒"),
  type: knownBillTypeSchema,
  money: z.number().describe(`普通支出、转账或信用卡还款对应 APP 主金额输入框，其他类型为钱迹业务金额，${moneyUnitDescription}`),
  fee: z.number().nonnegative().optional().describe(`转账或信用卡还款手续费，包含在 money 中，转入金额为 money - fee，其他类型省略，${moneyUnitDescription}`),
  discount: z.number().nonnegative().optional().describe(`普通支出、转账或信用卡还款优惠，实际支出或转出金额为 money - discount，其他类型省略，${moneyUnitDescription}`),
  categoryId: positiveIdText.nullable().describe("分类 ID，不需要分类的账单为 null"),
  assetId: positiveIdText.nullable().describe(billAssetIdDescription),
  fromId: positiveIdText.optional().describe(billFromIdDescription),
  targetId: positiveIdText.optional().describe(billTargetIdDescription),
  remark: z.string().describe("账单备注"),
  ...billAttributionSchemas,
  ...billFlagOutputSchemas,
  ...billRelationshipSchemas,
};
const billSummarySchema = z.object({
  ...billFields,
  tagIds: z.array(z.string()).describe("标签 ID 列表"),
});
const billSchema = z.object({
  ...billFields,
  createTime: z.number().int().describe("账单创建时间，Unix 秒"),
  updateTime: z.number().int().optional().describe("账单更新时间，Unix 秒"),
  tagIds: z.array(z.string()).optional().describe("标签 ID 列表"),
});
const patMetadataSchema = z.object({
  id: z.number().int().positive().describe("PAT 内部标识"),
  accountId: z.number().int().positive().nullable().describe("关联钱迹账号的内部标识，null 表示未绑定"),
  uid: z.string().nullable().describe("关联的钱迹用户 ID，null 表示未绑定"),
  role: patRoleSchema,
  remark: z.string().describe("用于识别 PAT 的备注"),
  expiresAt: z.number().int().positive().nullable().describe("PAT 过期时间，Unix 秒，null 表示永不过期"),
  createdAt: z.number().int().positive().describe("PAT 创建时间，Unix 秒"),
});
const createdPatSchema = patMetadataSchema.extend({
  token: z.string().describe("新创建且仅本次返回的完整明文 PAT"),
});
const userInfoFields = {
  id: z.string().min(1).describe("钱迹用户 ID，不透明非空字符串"),
  name: z.string().describe("钱迹用户名称"),
  avatar: z.string().describe("头像 URL，未设置时为空字符串"),
  registrationMethod: registrationMethodSchema.optional().describe("钱迹账号注册方式，上游代码无法识别时不返回"),
  registeredAt: z.number().int().nonnegative().describe("注册时间，Unix 秒"),
  vipType: vipTypeSchema.describe("钱迹会员类型名称，未知的有效会员类型统一显示为 VIP，不暴露上游代码"),
  vipStart: z.number().int().nonnegative().nullable().describe("VIP 生效时间，Unix 秒，未开通时为 null"),
  vipEnd: z.number().int().nonnegative().nullable().describe("VIP 失效时间，Unix 秒，该秒起视为过期，未开通时为 null"),
  baseCurrency: currencySymbolSchema.describe("当前钱迹账户本位币标识，跨币种记账和默认统计口径均以此为准"),
};

const billCurrencyInputSchema = z.strictObject({
  sourceCurrency: currencySymbolSchema.describe("普通账单的来源币种标识"),
  targetAmount: nonnegativeMoneySchema.optional().describe("目标资产币种金额"),
  baseAmount: nonnegativeMoneySchema.optional().describe("本位币金额"),
});
const derivedCurrencyInputSchema = z.strictObject({
  targetAmount: nonnegativeMoneySchema.optional().describe("目标资产币种金额"),
  baseAmount: nonnegativeMoneySchema.optional().describe("本位币金额"),
}).refine((value) => value.targetAmount !== undefined || value.baseAmount !== undefined, "currencyConversion 至少包含 targetAmount 或 baseAmount")
  .meta({ required: [] });
const userInfoSchema = z.discriminatedUnion("isVip", [
  z.strictObject({
    ...userInfoFields,
    isVip: z.literal(true).describe("有效 VIP，不适用每日写入额度，结果不包含额度字段"),
  }),
  z.strictObject({
    ...userInfoFields,
    isVip: z.literal(false).describe("非有效 VIP，结果包含当日共享写入额度"),
    dailyWriteLimit: z.number().int().nonnegative().describe("当日成功业务写入上限，单位为次"),
    dailyWriteUsed: z.number().int().nonnegative().describe("当日已用成功业务写入次数，单位为次"),
    dailyWriteRemaining: z.number().int().nonnegative().describe("当日剩余成功业务写入次数，单位为次"),
    dailyWriteResetsAt: z.number().int().nonnegative().describe("额度在 Asia/Shanghai 次日零点重置的 Unix 秒"),
  }),
]);

const createInput = z.strictObject({
  bookId: defaultBookIdText,
  time: z.number().int().nonnegative().optional().describe("账单发生时间，Unix 秒，省略时使用服务器当前时间"),
  type: simpleBillTypeSchema,
  money: positiveMoneySchema.describe(billAdjustmentMoneyDescription),
  discount: nonnegativeMoneySchema.optional()
    .describe(`支出优惠金额，实际扣款为 money - discount，${billInputMoneyDescription}`),
  categoryId: positiveIdText.describe("账单分类 ID"),
  assetId: optionalAssetIdInputText.optional()
    .describe("账单资产 ID，null 表示不选择资产"),
  remark: z.string().max(500).optional().describe("账单备注"),
  tagIds: writeTagIdsSchema.optional().describe("账单标签 ID 列表"),
  ...billFlagCreateSchemas,
  reimbursable: z.boolean().optional().default(false)
    .describe("是否将支出标记为待报销"),
  currencyConversion: billCurrencyInputSchema.optional()
    .describe("跨币种普通账单的换算信息"),
}).refine(({ money, discount = 0 }) => discount <= money, {
  message: "discount 不能大于 money",
});
const patchSchema = z
  .strictObject({
    bookId: bookIdText.optional()
      .describe("新的账本 ID"),
    time: z.number().int().nonnegative().optional().describe("新的账单发生时间，Unix 秒"),
    money: positiveMoneySchema.optional().describe(`新的${billAdjustmentMoneyDescription}`),
    discount: nonnegativeMoneySchema.optional()
      .describe(`新的支出优惠金额，传 0 表示清除优惠，${billInputMoneyDescription}`),
    categoryId: positiveIdText.optional().describe("新的账单分类 ID"),
    assetId: optionalAssetIdInputText.optional().describe("新的账单资产 ID，null 表示清除资产"),
    remark: z.string().max(500).optional().describe("新的账单备注"),
    tagIds: writeTagIdsSchema.optional().describe("完整替换后的标签 ID 列表，空数组表示清除全部标签"),
    ...billFlagPatchSchemas,
    reimbursable: z.boolean().optional()
      .describe("新的待报销状态"),
    currencyConversion: billCurrencyInputSchema.optional()
      .describe("新的跨币种换算信息"),
  })
  .refine((patch) => Object.keys(patch).length > 0, "patch 不能为空")
  .refine(({ money, discount }) => money === undefined || discount === undefined || discount <= money, "discount 不能大于 money")
  .meta({ required: [] });

const createTransferInput = z.strictObject({
  bookId: defaultBookIdText,
  time: z.number().int().nonnegative().optional().describe("转账或还款发生时间，Unix 秒，省略时使用服务器当前时间"),
  money: positiveMoneySchema.describe(transferMoneyDescription),
  fromAssetId: positiveIdText.describe("转出资产 ID"),
  targetAssetId: positiveIdText.describe("转入资产 ID"),
  creditRepayment: z.boolean().optional().default(false)
    .describe("是否将本次操作记为信用卡还款"),
  fee: nonnegativeMoneySchema.optional().default(0)
    .describe(`手续费金额，包含在 money 中，转入金额为 money - fee，${sourceAssetMoneyDescription}`),
  discount: nonnegativeMoneySchema.optional().default(0)
    .describe(`优惠金额，实际转出为 money - discount，转入为 money，${sourceAssetMoneyDescription}`),
  remark: z.string().max(500).optional().describe("转账或还款备注"),
  tagIds: writeTagIdsSchema.optional().describe("转账或还款标签 ID 列表"),
  ...billFlagCreateSchemas,
  currencyConversion: derivedCurrencyInputSchema.optional()
    .describe("跨币种转账的换算信息"),
}).refine(({ fee = 0, discount = 0 }) => fee === 0 || discount === 0, {
  message: "fee 与 discount 不能同时大于 0",
}).refine(({ money, fee = 0, discount = 0 }) => fee <= money && discount <= money, {
  message: "fee 和 discount 不能大于 money",
});
const transferPatchSchema = z.strictObject({
  bookId: bookIdText.optional().describe("新的账本 ID"),
  time: z.number().int().nonnegative().optional().describe("新的转账或还款时间，Unix 秒"),
  money: positiveMoneySchema.optional().describe(`新的${transferMoneyDescription}`),
  fromAssetId: positiveIdText.optional().describe("新的转出资产 ID"),
  targetAssetId: positiveIdText.optional().describe("新的转入资产 ID"),
  creditRepayment: z.boolean().optional()
    .describe("新的信用卡还款标记"),
  fee: nonnegativeMoneySchema.optional()
    .describe(`新的手续费金额，包含在调整后的 money 中，传 0 会清除手续费和优惠，传正值会清除原优惠，${sourceAssetMoneyDescription}`),
  discount: nonnegativeMoneySchema.optional()
    .describe(`新的优惠金额，实际转出为调整后的 money - discount，转入为调整后的 money，传 0 会清除手续费和优惠，传正值会清除原手续费，${sourceAssetMoneyDescription}`),
  remark: z.string().max(500).optional().describe("新的转账或还款备注"),
  tagIds: writeTagIdsSchema.optional().describe("完整替换后的转账或还款标签 ID 字符串列表，空数组表示清除"),
  ...billFlagPatchSchemas,
  currencyConversion: derivedCurrencyInputSchema.optional()
    .describe("新的跨币种换算信息"),
})
  .refine((patch) => Object.keys(patch).length > 0, "patch 不能为空")
  .refine(({ fee = 0, discount = 0 }) => fee === 0 || discount === 0, "fee 与 discount 不能同时大于 0")
  .refine(({ money, fee, discount }) => money === undefined || ((fee === undefined || fee <= money) && (discount === undefined || discount <= money)), "fee 和 discount 不能大于 money")
  .meta({ required: [] });
const refundFields = {
  money: positiveMoneySchema.describe(`退款金额，${sourceBillMoneyDescription}`),
  time: z.number().int().nonnegative().optional().describe("退款发生时间，Unix 秒，创建时省略则使用服务器当前时间与源账单时间加 1 秒的较大值"),
  assetId: optionalAssetIdInputText.optional().describe("退款入账资产 ID，省略时使用源账单资产，null 表示不指定资产"),
  remark: z.string().max(500).optional().describe("退款备注"),
  tagIds: writeTagIdsSchema.optional().describe("退款标签 ID 列表"),
  currencyConversion: derivedCurrencyInputSchema.optional()
    .describe("退款的跨币种换算信息"),
};
const refundPatchSchema = z.strictObject({
  money: refundFields.money.optional().describe(`新的退款金额，${sourceBillMoneyDescription}`),
  time: refundFields.time.describe("新的退款发生时间，Unix 秒"),
  assetId: refundFields.assetId.describe("新的退款入账资产 ID，null 表示清除资产"),
  remark: refundFields.remark.describe("新的退款备注"),
  tagIds: refundFields.tagIds.describe("完整替换后的退款标签 ID 列表，空数组表示清除"),
  currencyConversion: refundFields.currencyConversion
    .describe("新的退款跨币种换算信息"),
}).refine((patch) => Object.keys(patch).length > 0, "patch 不能为空").meta({ required: [] });
const debtAccountSchema = z.object({
  id: positiveIdText.describe("借入或借出记录对应的钱迹资产 ID"),
  name: z.string().describe("借入或借出记录名称"),
  direction: debtDirectionSchema,
  status: debtStatusSchema,
  currency: currencySymbolSchema.describe("本金、余额和已还或已收金额使用的币种标识"),
  principal: z.number().nonnegative().describe("原始本金的非负展示值，使用 currency 指定的币种主单位"),
  balance: z.number().nonnegative().describe("当前剩余余额的非负展示值，使用 currency 指定的币种主单位"),
  startDate: z.string().describe("开始日期，上游未设置时为空字符串"),
  endDate: z.string().describe("计划还款或收款日期，与 status 是否 ended 无直接关系，上游未设置时为空字符串"),
  finishedAt: z.number().int().positive().optional().describe("实际结束时间，Unix 秒，仅 status=ended 且钱迹记录了结束时间时返回"),
  totalPaid: z.number().nonnegative().describe("借入已还金额或借出已收金额的非负展示值，使用 currency 指定的币种主单位"),
});

const statisticsRangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("month").describe("按自然月统计"),
    year: z.number().int().min(1970).max(9999).describe("统计年份"),
    month: z.number().int().min(1).max(12).describe("统计月份"),
  }),
  z.strictObject({ kind: z.literal("year").describe("按自然年统计"), year: z.number().int().min(1970).max(9999).describe("统计年份") }),
  z.strictObject({
    kind: z.literal("custom").describe("按自定义 Unix 秒区间统计"),
    startTime: z.number().int().nonnegative().describe("自定义统计起点，Unix 秒，包含边界"),
    endTime: z.number().int().nonnegative().describe("自定义统计终点，Unix 秒，包含边界"),
  }).refine(({ startTime, endTime }) => startTime <= endTime, "startTime 不能晚于 endTime"),
  z.strictObject({ kind: z.literal("all").describe("统计所选账本的全部账单时间范围") }),
]);
const statisticsSummarySchema = z.object({
  totalIncome: z.number().describe("总收入：纯收入、报销收入和退款收入之和，债务利息收入已包含在纯收入内"),
  totalSpend: z.number().describe("总支出：纯支出、报销支出、手续费和退款支出之和，债务利息支出已包含在纯支出内"),
  balance: z.number().describe("结余，固定为 totalIncome - totalSpend"),
  pureIncome: z.number().describe("收入和借出利息收入扣除关联退款后的正数部分，不含报销收入和退款收入"),
  pureSpend: z.number().describe("支出和借入利息支出扣除关联退款后的正数部分，不含报销支出、退款支出和手续费"),
  transferAmount: z.number().describe("转账的 APK 统计金额总额：同币种使用扣除手续费或优惠后的保存金额，跨币种使用所选统计币种的历史换算金额，仅展示资金流转，不计入总收支"),
  creditRepaymentAmount: z.number().describe("信用卡还款的 APK 统计金额总额：同币种使用扣除手续费或优惠后的保存金额，跨币种使用所选统计币种的历史换算金额，仅展示还款，不重复计入总收支"),
  reimbursementAmount: z.number().describe("待报销源账单扣除关联退款后不低于 0 的报销基数，本身不直接计入总收支"),
  reimbursementIncome: z.number().describe("已报销金额超过报销基数的正差额，计入总收入"),
  reimbursementSpend: z.number().describe("已有报销关系的待报销源账单中，报销基数超过已报销金额的正差额，计入总支出"),
  refundAmount: z.number().describe("退款子账单金额总额，退款对收支的影响已作用于源账单"),
  refundIncome: z.number().describe("支出、待报销支出或借入利息支出的关联退款超过源金额形成的正差额，计入总收入"),
  refundSpend: z.number().describe("收入或借出利息收入的关联退款超过源金额形成的正差额，计入总支出"),
  feeAmount: z.number().describe("未标记不计收支账单的正 transfee 合计，计入总支出"),
  discountAmount: z.number().describe("未标记不计收支账单的负 transfee 绝对值合计，仅展示优惠规模，不再从总支出重复扣减"),
  excludedFromIncomeExpenseAmount: z.number().describe("标记为不计收支的主金额合计，其中普通收支和债务利息使用扣除关联退款后的正数部分，待报销支出使用报销差额或未报销主金额，不进入总收支，转账、还款和退款子账单不计入此字段"),
  excludedFromBudgetAmount: z.number().describe("标记为不计预算的主金额合计，其中普通收支和债务利息使用扣除关联退款后的正数部分，待报销支出使用报销差额或未报销主金额，这些金额仍可能计入收支，转账、还款和退款子账单不计入此字段"),
});
const categoryStatSchema: z.ZodType = z.lazy(() => z.object({
  categoryId: positiveIdText.optional().describe("真实分类 ID，特殊债务利息行省略"),
  billType: z.number().int().optional().describe("特殊类型行的钱迹账单类型，普通分类省略"),
  name: z.string().describe("分类名称或特殊账单类型名称"),
  amount: z.number().describe("分类总金额，一级分类包含 children"),
  directAmount: z.number().describe("直接记在该分类上的金额，一级分类不含子分类金额"),
  percentage: z.number().min(0).describe("占对应总收入或总支出的比例，分母为 0 时为 0"),
  children: z.array(categoryStatSchema).describe("直属二级分类，按金额降序，没有时为空数组"),
}));
const statisticsOutputSchema = z.object({
  range: z.object({
    startTime: z.number().int().describe("实际统计起点，Unix 秒，包含边界"),
    endTime: z.number().int().describe("实际统计终点，Unix 秒，包含边界"),
    timezoneOffsetSeconds: z.literal(28_800).describe("日期分桶固定使用 UTC+08:00"),
  }).describe("实际使用的统计时间范围"),
  currency: currencySymbolSchema.describe("响应中全部金额使用的币种标识，未指定时为当前本位币"),
  availableCurrencies: z.array(currencySymbolSchema).describe("应用其他筛选后可选的来源币种标识集合，并包含当前本位币"),
  summary: statisticsSummarySchema.describe("按 APK 口径计算的总额明细"),
  counts: z.object({
    matchedBillCount: z.number().int().nonnegative().describe("应用全部筛选后的原始账单条数，包括不贡献总收支的转账、还款和不计收支账单"),
    incomeItemCount: z.number().int().nonnegative().describe("实际产生正收入分量的条目数，不等同于账单总数"),
    spendItemCount: z.number().int().nonnegative().describe("实际产生正支出分量的条目数，不等同于账单总数"),
    reimbursementBillCount: z.number().int().nonnegative().describe("参与报销金额统计的待报销源账单条数"),
  }).describe("匹配账单及实际收入、支出、报销条目计数"),
  average: z.object({
    unit: statisticsUnitSchema.describe("APK 按范围选择的平均和时间序列期间单位"),
    periodCount: z.number().int().nonnegative().describe("平均值分母，其中 unit=day 时，自然月只计已经完整结束的日历日，跨度不超过 365 天的自定义范围以 startTime 为起点，以 endTime 后一秒与当前 UTC+08:00 自然日零点中的较早者为终点，每满 86400 秒计 1 个期间，范围内无账单的期间也计入，因此进行中的当天不计入，仅查询当天时即使有账单也可能为 0，而 unit=month/year 时只计有账单期间，跨度超过 365 天的自定义范围使用 year"),
    income: z.number().describe("totalIncome / periodCount，分母为 0 时为 0"),
    spend: z.number().describe("totalSpend / periodCount，分母为 0 时为 0"),
    balance: z.number().describe("平均收入减平均支出"),
  }).describe("APK 按范围选择的期间平均值"),
  categoryBreakdown: z.object({
    spend: z.array(categoryStatSchema).describe("支出分类构成，仅含支出、借入利息支出和待报销支出的报销差额，不含手续费和退款支出，按金额降序"),
    income: z.array(categoryStatSchema).describe("收入分类构成，仅含收入和借出利息收入，不含报销收入和退款收入，按金额降序"),
  }).describe("按支出和收入分开的分类构成，百分比分母分别为 totalSpend 和 totalIncome，未纳入分类的金额会使比例合计小于 100%"),
  memberBreakdown: z.array(z.object({
    userId: z.string().describe("记账人的钱迹用户 ID"),
    name: z.string().describe("记账人显示名，上游缺失时为空字符串"),
    income: z.number().describe("该成员账单按同一口径计算的总收入"),
    spend: z.number().describe("该成员账单按同一口径计算的总支出"),
    balance: z.number().describe("该成员收入减支出"),
  })).describe("按记账人汇总的收入、支出和结余"),
  timeSeries: z.object({
    unit: statisticsUnitSchema.describe("与 average.unit 相同的期间粒度"),
    items: z.array(z.object({
      period: z.string().describe("有匹配账单的期间键：YYYY-MM-DD、YYYY-MM 或 YYYY"),
      income: z.number().describe("该期间总收入"),
      spend: z.number().describe("该期间总支出"),
      balance: z.number().describe("该期间收入减支出"),
    })).describe("按 UTC+08:00 分桶且不补空期间的时间序列"),
  }).describe("按 APK 选择的日期粒度汇总趋势"),
});

const budgetPeriodInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("month").describe("月度预算"),
    year: z.number().int().min(1970).max(9999).describe("预算年份"),
    month: z.number().int().min(1).max(12).describe("预算月份"),
  }),
  z.strictObject({
    kind: z.literal("year").describe("年度预算"),
    year: z.number().int().min(1970).max(9999).describe("预算年份"),
  }),
]);
const budgetRangeFields = {
  startTime: z.number().int().describe("实际预算期间起点，Unix 秒，包含边界"),
  endTime: z.number().int().describe("实际预算期间终点，Unix 秒，包含边界"),
  timezoneOffsetSeconds: z.literal(28_800).describe("预算日期固定使用 UTC+08:00"),
};
const budgetPeriodOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("month").describe("月度预算"),
    year: z.number().int().min(1970).max(9999).describe("预算标签年份"),
    month: z.number().int().min(1).max(12).describe("预算标签月份"),
    ...budgetRangeFields,
  }),
  z.object({
    kind: z.literal("year").describe("年度预算"),
    year: z.number().int().min(1970).max(9999).describe("预算年份"),
    ...budgetRangeFields,
  }),
]);
const budgetSpendingScopeSchema = z.union([
  z.literal("allExpenses").describe("总预算严格高于分类预算总额时统计全部支出及转账或还款手续费"),
  z.literal("budgetedCategories").describe("未单独设置更高总预算时只统计已有预算分类下的支出"),
]).describe("预算消耗范围");
const budgetCategoryFields = {
  categoryId: positiveIdText.describe("预算分类 ID"),
  name: z.string().describe("预算分类名称"),
  limit: z.number().nonnegative().describe("分类有效限额，一级分类取自身限额与直属预算子分类限额之和的较大值，二级分类使用自身限额"),
  used: z.number().nonnegative().describe("该分类已消耗金额，一级分类包含直属子分类，普通支出和借入利息支出扣除退款，待报销源账单扣除退款与报销入账，同时排除不计预算金额"),
  remaining: z.number().describe("分类剩余额度，固定为 limit - used，负数表示超支"),
  billCount: z.number().int().nonnegative().describe("该分类范围内的支出、借入利息支出和待报销源账单笔数，单位为条，零消耗及不计预算账单仍计入"),
};
const budgetCategoryChildSchema = z.object({
  ...budgetCategoryFields,
  children: z.array(z.never()).max(0).describe("二级分类没有下级分类，固定为空数组"),
});
const budgetCategorySchema = z.object({
  ...budgetCategoryFields,
  children: z.array(budgetCategoryChildSchema).describe("已设置预算的直属二级分类，没有时为空数组"),
});
const budgetSummarySchema = z.object({
  spendingScope: budgetSpendingScopeSchema,
  limit: z.number().nonnegative().describe("有效预算总额，取总预算与按父子分类去重后的分类预算总额较大值"),
  used: z.number().nonnegative().describe("预算已消耗金额，按 spendingScope 使用全部预算支出及转账或还款手续费，或只使用已有预算分类支出"),
  remaining: z.number().describe("预算剩余额度，固定为 limit - used，负数表示超支"),
  excludedFromBudgetAmount: z.number().nonnegative().describe("标记为不计预算的普通支出、借入利息支出和待报销源账单金额，已扣除退款和报销入账且不计入 used，转账、还款及其手续费不计入此字段"),
  dailyAverageBudget: z.number().nonnegative().describe("期间日均预算，固定为 limit 除以实际预算期间包含未来日期在内的全部日历日数"),
  remainingDailyAverage: z.number().nonnegative().optional().describe("当前月尚未超支时的剩余日均预算，固定为 remaining 除以包含当天在内的剩余日历日数，其他期间省略"),
});
const budgetOutputSchema = z.object({
  period: budgetPeriodOutputSchema.describe("预算标签及按账本月份起始日换算后的实际时间范围"),
  currency: currencySymbolSchema.describe("响应中全部金额使用的当前钱迹账户本位币标识"),
  configured: z.boolean().describe("该期间是否存在正数总预算或分类预算，false 时 summary 为 null 且 categories 为空数组"),
  summary: budgetSummarySchema.nullable().describe("预算总览，没有配置预算时为 null"),
  categories: z.array(budgetCategorySchema).describe("按一级分类与直属二级分类组织的预算明细，未设置预算的分类不返回"),
  dailyStatistics: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("UTC+08:00 日历日期，格式为 YYYY-MM-DD"),
    spend: z.number().nonnegative().describe("当日预算支出，按 spendingScope 统计并排除不计预算金额"),
    cumulativeSpend: z.number().nonnegative().describe("从预算期间起点到当日的累计预算支出"),
    remaining: z.number().describe("当日结束后的预算剩余额度，固定为 summary.limit - cumulativeSpend，负数表示超支"),
  })).optional().describe("逐日预算统计，仅 includeDailyStatistics=true 时返回并补齐期间内每个日历日"),
});

/** 创建钱迹业务工具，并为管理员追加 PAT 管理工具。 */
export function createMoneyTrackMcp(
  service: MoneyTrackService,
  store: DataStore,
  principal: AuthenticatedPat,
  bindingTickets: BindingTicketManager,
): McpServer {
  const server = new McpServer(
    { name: "qianji-remote-mcp", version: "0.1.0" },
    { instructions: serverInstructions.trim() },
  );

  server.registerTool(
    "connect_qianji",
    {
      description: "获取钱迹账号登录或重新登录的一次性链接",
      inputSchema: z.strictObject({}).meta({ required: [] }),
      outputSchema: z.object({
        url: z.string().url().describe("一次性钱迹登录链接"),
        expiresAt: z.number().int().positive().describe("链接失效时间，Unix 秒"),
        message: z.string().describe("钱迹登录链接的用户提示语"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (_input, ctx) => toolResult(async () => {
      await requirePatPrincipal(principal, store);
      const link = issueConnectionLink(principal, bindingTickets);
      return {
        ...link,
        message: `请只向用户原样返回下方内容，不要省略、改写、重排或补充说明，不要输出本段提示\n\n${link.message}`,
      };
    }, ctx, principal, bindingTickets),
  );

  server.registerTool(
    "disconnect_qianji",
    {
      description: "解绑当前 PAT 的钱迹账号，并在账号不再被其他 PAT 使用时删除其本地数据",
      inputSchema: z.strictObject({}).meta({ required: [] }),
      outputSchema: z.object({
        disconnected: z.literal(true).describe("当前 PAT 已解绑"),
        accountDataDeleted: z.boolean().describe("是否因账号未被其他 PAT 使用而删除全部本地数据，false 表示账号仍被其他 PAT 使用或调用前已经解绑"),
      }),
      annotations: destructiveAnnotations,
    },
    async (_input, ctx) => toolResult(async () => {
      const current = await requirePatPrincipal(principal, store);
      if (current.accountId === null) {
        bindingTickets.revokePat(principal.patId);
        return { disconnected: true as const, accountDataDeleted: false };
      }
      if (bindingTickets.isPatActive(principal.patId)) {
        throw new AppError("QIANJI_CONNECTION_IN_PROGRESS", "钱迹账号正在登录，请等待本次登录完成后再解绑", 409);
      }
      bindingTickets.revokePat(principal.patId);
      const result = await service.unbindAccount(principal.patId, current.accountId);
      return { disconnected: true as const, accountDataDeleted: result.localDataDeleted };
    }, ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_books",
    {
      description: "查询当前钱迹账号的账本",
      inputSchema: z.strictObject({
        includeHidden: z.boolean().optional().default(false)
          .describe("是否包含隐藏账本"),
        nameKeyword: searchKeywordSchema.optional()
          .describe("用于匹配账本名称且不区分大小写的字面子串"),
      }).meta({ required: [] }),
      outputSchema: z.object({ results: z.array(bookSchema).describe("账本列表") }),
      annotations: readAnnotations,
    },
    async ({ includeHidden, nameKeyword }, ctx) =>
      toolResult(async () => ({
        results: await service.listBooks(await userId(principal, store), includeHidden, nameKeyword),
      }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_book_members",
    {
      description: "查询指定账本的成员候选",
      inputSchema: z.strictObject({
        bookId: defaultBookIdText,
      }).meta({ required: [] }),
      outputSchema: z.object({ results: z.array(bookMemberSchema).describe("账本成员列表") }),
      annotations: readAnnotations,
    },
    async ({ bookId }, ctx) => toolResult(async () => ({
      results: await service.listBookMembers(await userId(principal, store), bookId),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_assets",
    {
      description: "查询当前钱迹账号的资产",
      inputSchema: z.strictObject({
        includeHidden: z.boolean().optional().default(false)
          .describe("是否包含已隐藏资产"),
        includeBalances: z.boolean().optional().default(false)
          .describe("是否返回资产当前余额和信用额度"),
        nameKeyword: z.string().trim().min(1).optional()
          .describe("用于匹配资产名称且不区分大小写的字面子串，不匹配分组名、机构字段或别名"),
      }).meta({ required: [] }),
      outputSchema: z.object({ results: z.array(assetGroupSchema).describe("固定两级资产分组") }),
      annotations: readAnnotations,
    },
    async ({ includeHidden, includeBalances, nameKeyword }, ctx) =>
      toolResult(async () => ({
        results: await service.listAssets(await userId(principal, store), includeHidden, includeBalances, nameKeyword),
      }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_debt_accounts",
    {
      description: "独立查询当前钱迹账号的借入或借出详情",
      inputSchema: z.strictObject({
        direction: debtDirectionSchema,
        status: debtStatusSchema,
      }),
      outputSchema: z.object({ results: z.array(debtAccountSchema).describe("符合方向和状态的借入或借出记录列表") }),
      annotations: readAnnotations,
    },
    async ({ direction, status }, ctx) => toolResult(async () => ({
      results: await service.listDebtAccounts(await userId(principal, store), direction, status),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_categories",
    {
      description: "列出指定账本的支出或收入分类",
      inputSchema: z.strictObject({
        bookId: defaultBookIdText,
        type: z.union([
          z.literal(-1).describe("全部分类"),
          z.literal(0).describe("支出分类"),
          z.literal(1).describe("收入分类"),
        ]).optional().default(-1)
          .describe("分类范围"),
      }).meta({ required: [] }),
      outputSchema: z.object({ results: z.array(categorySchema).describe("固定两级分类树") }),
      annotations: readAnnotations,
    },
    async ({ bookId, type }, ctx) =>
      toolResult(async () => ({
        results: await service.listCategories(await userId(principal, store), bookId, type),
      }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_tags",
    {
      description: "列出当前钱迹账号的标签",
      inputSchema: z.strictObject({
        status: z.union([
          z.literal(-1).describe("全部标签"),
          z.literal(1).describe("正常标签"),
          z.literal(2).describe("归档标签"),
        ]).optional().default(1)
          .describe("标签状态范围"),
      }).meta({ required: [] }),
      outputSchema: z.object({ results: z.array(tagGroupSchema).describe("固定两级标签分组") }),
      annotations: readAnnotations,
    },
    async ({ status }, ctx) =>
      toolResult(async () => ({
        results: await service.listTags(await userId(principal, store), status),
      }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "get_user_info",
    {
      description: "返回当前钱迹用户、账户本位币、VIP 状态及适用时的当日写入额度信息",
      inputSchema: z.strictObject({}).meta({ required: [] }),
      outputSchema: z.object({ user: userInfoSchema.describe("当前钱迹用户信息") }),
      annotations: readAnnotations,
    },
    async (_input, ctx) => toolResult(async () => ({
      user: await service.getUserInfo(await userId(principal, store)),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "refresh_cache",
    {
      description: "立即刷新当前钱迹账号的用户、账单、账本、资产、分类、标签和币种目录缓存",
      inputSchema: z.strictObject({}).meta({ required: [] }),
      outputSchema: z.object({
        userRefreshed: z.literal(true).describe("用户信息已刷新"),
        bookCount: z.number().int().nonnegative().describe("刷新后的账本总数，包含隐藏账本，单位为个"),
        visibleBookCount: z.number().int().nonnegative().describe("刷新后的可见账本数量，单位为个"),
        hiddenBookCount: z.number().int().nonnegative().describe("刷新后的隐藏账本数量，单位为个"),
        assetCount: z.number().int().nonnegative().describe("刷新后的资产数量，单位为个"),
        categoryCount: z.number().int().nonnegative().describe("所有账本刷新后的分类总数，单位为个"),
        tagCount: z.number().int().nonnegative().describe("刷新后的标签数量，单位为个"),
        billCount: z.number().int().nonnegative().describe("刷新后的本地账单数量，单位为条"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_input, ctx) =>
      toolResult(async () => service.refreshCache(await userId(principal, store)), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "list_bills",
    {
      description: "分页查询当前钱迹账号的账单摘要",
      inputSchema: z
        .strictObject({
          bookId: defaultBookIdText,
          allBooks: z.boolean().optional().meta({
            description: "是否查询全部账本，启用时忽略 bookId",
            default: false,
          }),
          startTime: z.number().int().nonnegative().optional()
            .describe("账单发生时间下限，Unix 秒，包含边界"),
          endTime: z.number().int().nonnegative().optional()
            .describe("账单发生时间上限，Unix 秒，包含边界"),
          createStartTime: z.number().int().nonnegative().optional()
            .describe("账单创建时间下限，Unix 秒，包含边界，与账单发生时间不同"),
          createEndTime: z.number().int().nonnegative().optional()
            .describe("账单创建时间上限，Unix 秒，包含边界，与账单发生时间不同"),
          type: knownBillTypeSchema.optional().describe("账单类型筛选"),
          types: z.array(knownBillTypeSchema).min(1).max(100).optional()
            .describe("多个账单类型筛选"),
          minMoney: nonnegativeMoneySchema.optional().describe("账单金额下限，包含边界"),
          maxMoney: nonnegativeMoneySchema.optional().describe("账单金额上限，包含边界"),
          categoryIds: z.array(positiveIdText).min(1).max(100).optional()
            .describe("多个分类 ID 筛选"),
          includeSubcategories: z.boolean().optional().meta({
            description: "是否同时匹配所选一级分类的子分类",
            default: true,
          }),
          categoryId: positiveIdText.optional()
            .describe("单个分类 ID 筛选"),
          tagIds: tagIdsSchema.min(1).optional().describe("多个标签 ID 筛选"),
          tagMatch: tagMatchSchema.optional().meta({
            description: "标签匹配方式",
            default: "any",
          }),
          tagId: opaqueIdText.optional()
            .describe("单个标签 ID 筛选"),
          remarkKeyword: searchKeywordSchema.optional()
            .describe("用于匹配账单备注且不区分大小写的字面子串"),
          assetIds: z.array(positiveIdText).min(1).max(100).optional()
            .describe("匹配任一主资产、来源资产或目标资产 ID"),
          assetId: positiveIdText.optional()
            .describe("只返回 assetId 精确匹配的账单"),
          fromAssetId: positiveIdText.optional()
            .describe(`只返回 fromId 精确匹配的账单，${billFromIdDescription}`),
          targetAssetId: positiveIdText.optional()
            .describe(`只返回 targetId 精确匹配的账单，${billTargetIdDescription}`),
          source: z.union([
            z.literal(0).describe("手动记账"),
            z.literal(2).describe("导入记账"),
            z.literal(120).describe("周期任务"),
            z.literal(121).describe("分期记账"),
            z.literal(122).describe("自动记账"),
          ]).optional().describe("按钱迹账单来源筛选"),
          memberIds: z.array(opaqueIdText).min(1).max(100).optional()
            .describe("共享账本记账人用户 ID 列表，匹配任一成员"),
          currency: currencySymbolSchema.optional()
            .describe("按用户原始记账币种筛选，无跨币种信息的账单按当前本位币解释"),
          noAsset: z.boolean().optional().describe("是否只返回未关联任何资产的账单"),
          noTags: z.boolean().optional().describe("是否只返回没有标签的账单"),
          excludeFromIncomeExpense: z.boolean().optional().describe("按是否标记为不计收支筛选"),
          excludeFromBudget: z.boolean().optional().describe("按是否标记为不计预算筛选"),
          sort: billSortSchema.optional().meta({ description: "账单排序方式", default: "timeDesc" }),
          limit: z.number().int().min(1).max(100).optional()
            .meta({ description: "每页账单条数", default: 20 }),
          cursor: z.string().max(MAX_BILL_CURSOR_LENGTH).optional()
            .describe("账单分页游标"),
        })
        .refine(
          ({ startTime, endTime }) => startTime === undefined || endTime === undefined || startTime <= endTime,
          "startTime 不能晚于 endTime",
        )
        .refine(
          ({ createStartTime, createEndTime }) => createStartTime === undefined || createEndTime === undefined || createStartTime <= createEndTime,
          "createStartTime 不能晚于 createEndTime",
        )
        .refine(({ minMoney, maxMoney }) => minMoney === undefined || maxMoney === undefined || minMoney <= maxMoney, "minMoney 不能大于 maxMoney")
        .refine(({ type, types }) => type === undefined || types === undefined, "type 和 types 不能同时传入")
        .refine(({ categoryId, categoryIds }) => categoryId === undefined || categoryIds === undefined, "categoryId 和 categoryIds 不能同时传入")
        .refine(({ tagId, tagIds }) => tagId === undefined || tagIds === undefined, "tagId 和 tagIds 不能同时传入")
        .refine(({ assetId, assetIds }) => assetId === undefined || assetIds === undefined, "assetId 和 assetIds 不能同时传入")
        .refine(
          ({ noAsset, assetId, assetIds, fromAssetId, targetAssetId }) =>
            !noAsset || [assetId, assetIds, fromAssetId, targetAssetId].every((value) => value === undefined),
          "noAsset 不能与资产 ID 筛选同时使用",
        )
        .refine(({ noTags, tagId, tagIds }) => !noTags || (tagId === undefined && tagIds === undefined), "noTags 不能与标签 ID 筛选同时使用")
        .refine(
          ({ cursor, ...filters }) => !cursor || Object.values(filters).every((value) => value === undefined),
          "使用 cursor 时不能同时传入其他筛选或分页参数",
        )
        .meta({ required: [] }),
      outputSchema: z.object({
        results: z.array(billSummarySchema).describe("当前页账单摘要列表"),
        nextCursor: z.string().nullable().describe("下一页游标，null 表示没有下一页"),
      }),
      annotations: readAnnotations,
    },
    async (input, ctx) => toolResult(async () => {
      const { bills, nextCursor } = await service.listBills(await userId(principal, store), input);
      return { results: bills, nextCursor };
    }, ctx, principal, bindingTickets),
  );

  server.registerTool(
    "get_bill",
    {
      description: "按账单 ID 返回完整账单详情",
      inputSchema: z.strictObject({ billId: positiveIdText.describe("账单 ID") }),
      outputSchema: z.object({ bill: billSchema.describe("完整账单") }),
      annotations: readAnnotations,
    },
    async ({ billId }, ctx) =>
      toolResult(async () => ({
        bill: await service.getBill(await userId(principal, store), billId),
      }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "get_bill_statistics",
    {
      description: "聚合本地账单并返回固定统计结果，金额统计采用钱迹 APK 已确认的主报表规则，日均分母只计已经完整结束的日历日",
      inputSchema: z.strictObject({
        bookId: defaultBookIdText,
        allBooks: z.boolean().optional().meta({
          description: "是否统计全部账本，启用时忽略 bookId",
          default: false,
        }),
        range: statisticsRangeSchema.describe("统计范围，按 UTC+08:00 解释月份和年份"),
        memberIds: z.array(opaqueIdText).min(1).max(100).optional()
          .describe("共享账本记账人用户 ID 列表，匹配任一成员"),
        currency: currencySymbolSchema.optional().describe("来源币种标识筛选和统计结果币种，传入时只统计以该币种记账的账单并按该币种汇总，省略时不筛选来源币种并按当前本位币汇总"),
        tagIds: tagIdsSchema.min(1).optional().describe("标签筛选列表"),
        tagMatch: tagMatchSchema.optional().meta({
          description: "标签匹配方式",
          default: "any",
        }),
        categoryIds: z.array(positiveIdText).min(1).max(100).optional()
          .describe("分类筛选列表"),
        includeSubcategories: z.boolean().optional().meta({
          description: "是否同时统计所选一级分类的子分类",
          default: true,
        }),
      }),
      outputSchema: z.object({ statistics: statisticsOutputSchema.describe("钱迹主报表固定结构统计结果") }),
      annotations: readAnnotations,
    },
    async (input, ctx) => toolResult(async () => ({
      statistics: await service.getBillStatistics(await userId(principal, store), input),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "get_budget",
    {
      description: "查询账本指定月份或年份的预算使用情况",
      inputSchema: z.strictObject({
        bookId: defaultBookIdText,
        period: budgetPeriodInputSchema.optional()
          .describe("预算期间，省略时查询按账本月份起始日确定的当前月"),
        includeDailyStatistics: z.boolean().optional().meta({
          description: "是否返回逐日支出、累计支出和剩余额度",
          default: false,
        }),
      }).meta({ required: [] }),
      outputSchema: z.object({ budget: budgetOutputSchema.describe("钱迹预算页口径的预算使用情况") }),
      annotations: readAnnotations,
    },
    async (input, ctx) => toolResult(async () => ({
      budget: await service.getBudget(await userId(principal, store), input),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "create_bills",
    {
      description: "批量创建普通支出、收入或待报销支出账单",
      inputSchema: z.strictObject({
        bills: z.array(createInput).min(1).max(100).describe("待创建账单列表"),
      }),
      outputSchema: z.object({ bills: z.array(billSchema).describe("创建后同步确认的完整账单列表，顺序与输入一致") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ bills }, ctx) =>
      toolResult(async () => service.createBills(await userId(principal, store), bills), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "update_bills",
    {
      description: "批量修改普通支出、收入或待报销支出账单",
      inputSchema: z.strictObject({
        updates: z.array(z.strictObject({
          billId: positiveIdText.describe("要修改的账单 ID"),
          patch: patchSchema.describe("账单字段补丁"),
        })).min(1).max(100).describe("待修改账单列表"),
      }),
      outputSchema: z.object({ bills: z.array(billSchema).describe("修改后同步确认的完整账单列表，顺序与输入一致") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ updates }, ctx) =>
      toolResult(async () => service.updateBills(await userId(principal, store), updates), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "delete_bills",
    {
      description: "批量永久删除普通收支、待报销支出、转账或信用卡还款账单",
      inputSchema: z.strictObject({
        deletions: z.array(z.strictObject({
          billId: positiveIdText.describe("要永久删除的账单 ID"),
          cascadeRelatedBills: z.boolean().optional().default(false)
            .describe("是否同时删除该源账单的全部退款和报销关联账单"),
        })).min(1).max(100).describe("待删除账单列表"),
      }),
      outputSchema: z.object({
        deleted: z.array(z.object({
          billId: positiveIdText.describe("已删除的源账单 ID 十进制字符串"),
          relatedBillIds: z.array(positiveIdText).describe("同时删除的退款和报销子账单 ID，未级联时为空数组"),
        })).describe("已删除范围，顺序与输入一致"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ deletions }, ctx) =>
      toolResult(async () => service.deleteBills(await userId(principal, store), deletions), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "create_transfer",
    {
      description: "创建同币种或跨币种的资产转账或信用卡还款账单",
      inputSchema: createTransferInput,
      outputSchema: z.object({ bill: billSchema.describe("创建后同步确认的转账或信用卡还款账单") }),
      annotations: writeAnnotations,
    },
    async (input, ctx) => toolResult(async () => ({
      bill: await service.createTransfer(await userId(principal, store), input),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "update_transfer",
    {
      description: "修改资产转账或信用卡还款账单",
      inputSchema: z.strictObject({
        billId: positiveIdText.describe("要修改的转账或信用卡还款账单 ID"),
        patch: transferPatchSchema.describe("转账或信用卡还款字段补丁"),
      }),
      outputSchema: z.object({ bill: billSchema.describe("修改后同步确认的转账或信用卡还款账单") }),
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
    async ({ billId, patch }, ctx) => toolResult(async () => ({
      bill: await service.updateTransfer(await userId(principal, store), billId, patch),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "create_refund",
    {
      description: "为普通支出或待报销支出创建退款账单",
      inputSchema: z.strictObject({
        sourceBillId: positiveIdText.describe("退款源账单 ID"),
        ...refundFields,
      }),
      outputSchema: z.object({ bill: billSchema.describe("钱迹返回并同步确认的退款账单") }),
      annotations: writeAnnotations,
    },
    async (input, ctx) => toolResult(async () => ({
      bill: await service.createRefund(await userId(principal, store), input),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "update_refund",
    {
      description: "修改退款账单并保持原有源账单关系",
      inputSchema: z.strictObject({
        refundBillId: positiveIdText.describe("要修改的退款账单 ID"),
        patch: refundPatchSchema.describe("退款字段补丁"),
      }),
      outputSchema: z.object({ bill: billSchema.describe("修改后同步确认的退款账单") }),
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
    async ({ refundBillId, patch }, ctx) => toolResult(async () => ({
      bill: await service.updateRefund(await userId(principal, store), refundBillId, patch),
    }), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "delete_refund",
    {
      description: "永久删除退款账单并更新源账单关系",
      inputSchema: z.strictObject({
        refundBillId: positiveIdText.describe("要永久删除的退款账单 ID"),
      }),
      outputSchema: z.object({
        deleted: z.literal(true).describe("退款账单已删除"),
        refundBillId: positiveIdText.describe("已删除的退款账单 ID 十进制字符串"),
      }),
      annotations: destructiveAnnotations,
    },
    async ({ refundBillId }, ctx) =>
      toolResult(async () => service.deleteRefund(await userId(principal, store), refundBillId), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "reimburse_bills",
    {
      description: "按总金额报销所选待报销支出并返回钱迹生成的关联账单",
      inputSchema: z.strictObject({
        sourceBillIds: z.array(positiveIdText).min(1).max(100)
          .describe("待报销源账单 ID 列表，内部按 APK 规则分摊总金额"),
        money: positiveMoneySchema.describe(`本次报销总金额，${sourceBillMoneyDescription}`),
        assetId: optionalAssetIdInputText.optional()
          .describe("报销入账资产 ID，省略或传 null 表示不指定资产"),
        time: z.number().int().nonnegative().optional()
          .describe("报销发生时间，Unix 秒，省略时使用服务器当前时间"),
        remark: z.string().max(500).optional().describe("报销备注"),
        tagIds: writeTagIdsSchema.optional().describe("报销关联账单标签 ID 列表"),
        currencyConversion: derivedCurrencyInputSchema.optional()
          .describe("整批跨币种报销的目标和本位币总金额"),
        confirmReimbursementUpgrade: z.boolean().default(false).describe(
          "是否允许在钱迹要求时迁移到新版报销",
        ),
      }),
      outputSchema: z.object({ bills: z.array(billSchema).describe("钱迹返回并同步确认的源账单与报销关联账单") }),
      annotations: writeAnnotations,
    },
    async (input, ctx) =>
      toolResult(async () => service.reimburseBills(await userId(principal, store), input), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "delete_reimbursement",
    {
      description: "永久删除单条报销入账账单并更新源账单关系",
      inputSchema: z.strictObject({
        reimbursementBillId: positiveIdText.describe("要永久删除的报销入账账单 ID"),
      }),
      outputSchema: z.object({
        deleted: z.literal(true).describe("报销入账账单已删除"),
        reimbursementBillId: positiveIdText.describe("已删除的报销入账账单 ID 十进制字符串"),
      }),
      annotations: destructiveAnnotations,
    },
    async ({ reimbursementBillId }, ctx) =>
      toolResult(async () => service.deleteReimbursement(
        await userId(principal, store),
        reimbursementBillId,
      ), ctx, principal, bindingTickets),
  );

  server.registerTool(
    "cancel_reimbursements",
    {
      description: "批量取消源账单的报销关系并删除关联账单",
      inputSchema: z.strictObject({
        sourceBillIds: z.array(positiveIdText).min(1).max(100)
          .describe("待取消报销的源账单 ID 列表"),
      }),
      outputSchema: z.object({
        cancelled: z.literal(true).describe("全部指定报销关系已取消"),
        sourceBillIds: z.array(positiveIdText).describe("已取消报销的源账单 ID 字符串列表"),
      }),
      annotations: destructiveAnnotations,
    },
    async ({ sourceBillIds }, ctx) =>
      toolResult(async () => service.cancelReimbursements(await userId(principal, store), sourceBillIds), ctx, principal, bindingTickets),
  );

  if (principal.role === "admin") registerAdminTools(server, store, principal, bindingTickets);
  return server;
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** 重新验证请求身份并返回已绑定的账号 ID。 */
async function userId(principal: AuthenticatedPat, store: DataStore): Promise<number> {
  return (await requireAccountPrincipal(principal, store)).accountId;
}

/** 注册仅超级管理员可调用的 PAT 管理工具。 */
function registerAdminTools(
  server: McpServer,
  store: DataStore,
  principal: AuthenticatedPat,
  bindingTickets: BindingTicketManager,
): void {
  server.registerTool(
    "list_pats",
    {
      description: "列出全部超级管理员和普通用户 PAT",
      inputSchema: z.strictObject({}).meta({ required: [] }),
      outputSchema: z.object({ results: z.array(patMetadataSchema).describe("PAT 元数据列表，不包含 Token") }),
      annotations: readAnnotations,
    },
    async (_input, ctx) => toolResult(async () => {
      requireAdmin(principal);
      return { results: (await store.listPats()).map(publicPatMetadata) };
    }, ctx, principal, bindingTickets),
  );

  server.registerTool(
    "create_pat",
    {
      description: "创建可选关联已有钱迹账号的普通用户 PAT",
      inputSchema: z.strictObject({
        remark: z.string().min(1).max(100).describe("用于识别 PAT 用途或持有人的备注"),
        accountId: z.number().int().positive().nullable().optional()
          .describe("要关联的已有钱迹账号内部标识，null 表示暂不绑定"),
        expiresAt: z.number().int().positive().nullable().optional()
          .describe("过期时间，Unix 秒，省略时默认 90 天后，null 表示永不过期"),
      }),
      outputSchema: z.object({
        pat: createdPatSchema.describe("新创建的 PAT"),
        message: z.string().describe("新 PAT 的用户交付模板"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ remark, accountId, expiresAt: inputExpiresAt }, ctx) => toolResult(async () => {
      requireAdmin(principal);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = inputExpiresAt === undefined ? now + 90 * 24 * 60 * 60 : inputExpiresAt;
      if (expiresAt !== null && expiresAt <= now) {
        throw new AppError("INVALID_PAT_EXPIRY", "PAT 过期时间必须晚于当前时间");
      }
      const pat = await store.createPat(remark, expiresAt, accountId ?? null);
      const created = publicCreatedPat(pat);
      return {
        pat: created,
        message: "请将 pat.token 原样填入下方模板的代码块后，只向用户返回填入后的内容，不要省略、改写、重排或补充说明，不要输出本段提示\n\n钱迹 PAT 已生成，请立即保存，完整 PAT 仅显示一次\n\n```\n{pat.token}\n```",
      };
    }, ctx, principal, bindingTickets),
  );

  server.registerTool(
    "delete_pat",
    {
      description: "永久删除普通用户 PAT，并在关联账号不再被其他 PAT 使用时删除其本地数据",
      inputSchema: z.strictObject({ id: z.number().int().positive().describe("要永久删除的普通用户 PAT 内部标识") }),
      outputSchema: z.object({
        deleted: z.literal(true).describe("PAT 已删除"),
        id: z.number().int().positive().describe("已删除的 PAT 内部标识"),
        accountDataDeleted: z.boolean().describe("是否因关联账号不再被其他 PAT 使用而删除其全部本地数据"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }, ctx) => toolResult(async () => {
      requireAdmin(principal);
      const result = await store.deletePat(id);
      if (!result) throw new AppError("PAT_NOT_FOUND", "普通用户 PAT 不存在", 404);
      return { deleted: true as const, id, accountDataDeleted: result.localDataDeleted };
    }, ctx, principal, bindingTickets),
  );
}

/** 构造不包含明文令牌的公开 PAT 元数据。 */
function publicPatMetadata(pat: PatRecord): z.infer<typeof patMetadataSchema> {
  return {
    id: pat.id,
    accountId: pat.accountId,
    uid: pat.uid,
    role: pat.role,
    remark: pat.remark,
    expiresAt: pat.expiresAt,
    createdAt: pat.createdAt,
  };
}

/** 构造一次性包含明文令牌的 PAT 创建结果。 */
function publicCreatedPat(pat: PatRecord): z.infer<typeof createdPatSchema> {
  return { ...publicPatMetadata(pat), token: pat.token };
}

/** 执行业务工具并统一处理结构化结果、连接引导和安全错误。 */
async function toolResult<T extends object>(
  action: () => Promise<T>,
  ctx: ServerContext | undefined,
  principal: AuthenticatedPat,
  bindingTickets: BindingTicketManager,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const output = await action();
    const structured = output as Record<string, unknown>;
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: structured,
    };
  } catch (error) {
    if (
      ctx &&
      error instanceof AppError &&
      ["QIANJI_ACCOUNT_NOT_BOUND", "QIANJI_TOKEN_INVALID"].includes(error.code)
    ) {
      const tokenExpired = error.code === "QIANJI_TOKEN_INVALID";
      const response = ctx.mcpReq.inputResponses?.connect_qianji;
      const action = response && typeof response === "object" && "action" in response
        ? response.action
        : undefined;
      if (action === "decline" || action === "cancel") {
        return errorToolResult(new AppError("QIANJI_CONNECTION_CANCELLED", "钱迹账号连接未完成"));
      }
      if (action === "accept") {
        return errorToolResult(new AppError(
          error.code,
          `${tokenExpired ? "重新绑定" : "绑定"}尚未生效，请确认连接页面已显示成功后重试`,
          error.httpStatus,
        ));
      }
      const link = issueConnectionLink(principal, bindingTickets);
      const request = {
        message: tokenExpired
          ? `钱迹登录状态已失效，请重新连接后返回原操作\n\n${link.message}`
          : `请连接钱迹账号后返回原操作\n\n${link.message}`,
        url: link.url,
      };
      if (!ctx.mcpReq.envelope) {
        // 部分旧客户端只展示顶层 JSON-RPC 错误，因此同时在消息中携带连接地址。
        throw new UrlElicitationRequiredError(
          [{ ...request, mode: "url", elicitationId: randomUUID() }],
          request.message,
        );
      }
      return inputRequired({
        inputRequests: {
          connect_qianji: inputRequired.elicitUrl(request),
        },
      });
    }
    return errorToolResult(error);
  }
}

/** 复用同一 ticket 管理器签发用户可直接打开的一次性连接链接。 */
function issueConnectionLink(
  principal: AuthenticatedPat,
  bindingTickets: BindingTicketManager,
): { url: string; expiresAt: number; message: string } {
  const connectUrl = new URL("/connect", principal.resource);
  const bindingTicket = bindingTickets.issue(principal.patId);
  connectUrl.searchParams.set("ticket", bindingTicket.token);
  const expiryTime = bindingExpiryFormatter.format(bindingTicket.expiresAtMs);
  const url = connectUrl.href;
  return {
    url,
    expiresAt: Math.floor(bindingTicket.expiresAtMs / 1000),
    message: `钱迹绑定链接已生成：[点击绑定钱迹](${url})\n\n有效期至 **${expiryTime}（北京时间）**，只能使用一次！\n\n若链接被内置浏览器拦截，请复制以下完整地址到系统浏览器：\n\n\`\`\`\n${url}\n\`\`\``,
  };
}

/** 将未知异常转换为不泄露内部信息的 MCP 工具错误。 */
function errorToolResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code: safe.code, message: safe.message } }) }],
  };
}
