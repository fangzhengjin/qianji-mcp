import {
  billExtra,
  inputBillMoney,
  publicBillId,
  publicOpaqueId,
  publicUserId,
  refundRelationshipMap,
  reimbursementRelationshipMap,
  relationshipTotal,
  tagIdsFrom,
  validatedCurrencyConversion,
} from "./bill-rules.ts";
import type { BillRow } from "./data-store.ts";
import { decimalSubtract } from "./decimal.ts";
import { AppError } from "./errors.ts";
import { isCurrencySymbol, isParentLongId, isPositiveLongId } from "./ids.ts";
import { isRawJsonNumber, parseQianjiJson } from "./qianji-client.ts";

/** 将数据库账单投影为列表接口使用的精简结构。 */
export function billSummary(row: BillRow): Record<string, unknown> {
  const raw = parseQianjiJson(row.rawJson) as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    id: row.id,
    bookId: row.bookid,
    time: row.time,
    type: row.type,
    money: publicMoney(raw),
    categoryId: row.cateid,
    assetId: publicOptionalAssetId(row.assetid),
    remark: row.remark,
    tagIds: tagIdsFrom(raw),
  };
  addSharedBillFields(summary, raw);
  return summary;
}

/** 将钱迹账本转换为稳定的公开字段。 */
export function publicBook(book: Record<string, unknown>): Record<string, unknown> {
  return {
    bookId: book.bookid,
    name: String(book.name ?? ""),
    visible: Number(book.visible ?? 1),
    type: Number(book.type ?? 0),
    memberCount: Number(book.membercount ?? 0),
    expired: Number(book.expired ?? 0),
  };
}

/** 按 APK 规则读取资产币种，原始值为空时使用账号本位币。 */
export function publicAssetCurrency(asset: Record<string, unknown>, baseCurrency: string): string {
  const currency = String(asset.currency ?? "").trim() || baseCurrency;
  if (!isCurrencySymbol(currency)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹资产包含无效币种", 502);
  }
  return currency;
}

/** 将钱迹资产转换为稳定的公开字段。 */
function publicAsset(asset: Record<string, unknown>, includeBalances: boolean, baseCurrency: string, nowMs: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: asset.id,
    name: String(asset.name ?? ""),
    currency: publicAssetCurrency(asset, baseCurrency),
    type: Number(asset.type ?? 0),
    subtype: Number(asset.stype ?? 0),
    status: Number(asset.status ?? 0),
    inCount: Number(asset.incount ?? 0),
  };
  if (includeBalances) result.money = Number(asset.money ?? 0);
  const credit = asset.credit;
  if (Number(asset.type) === 2 && credit && typeof credit === "object" && !Array.isArray(credit)) {
    const value = credit as Record<string, unknown>;
    const statementDay = Number(value.statedate);
    const legacyPayDay = Number(value.paydate);
    const repaymentValue = typeof value.paydate2 === "string" && value.paydate2.trim()
      ? value.paydate2.trim()
      : Number.isInteger(legacyPayDay) && legacyPayDay > 0
        ? String(legacyPayDay)
        : "";
    const daysAfterStatement = repaymentValue.endsWith("d");
    const repaymentDay = Number(daysAfterStatement ? repaymentValue.slice(0, -1) : repaymentValue);
    const creditResult: Record<string, unknown> = {};
    if (Number.isInteger(statementDay) && statementDay > 0) creditResult.statementDay = statementDay;
    if (Number.isInteger(repaymentDay) && repaymentDay > 0) {
      creditResult.repaymentRule = {
        type: daysAfterStatement ? "daysAfterStatement" : "dayOfMonth",
        value: repaymentDay,
      };
      const next = nextCreditRepaymentDate(nowMs, statementDay, repaymentDay, daysAfterStatement);
      if (next !== undefined) creditResult.nextRepaymentDate = next;
    }
    const limit = Number(value.limit);
    if (includeBalances && Number.isFinite(limit) && limit >= 0) creditResult.limit = limit;
    if (Object.keys(creditResult).length > 0) result.credit = creditResult;
  }
  return result;
}

/** 按自定义分组或资产类型组织公开资产列表。 */
export function publicAssetGroups(
  assets: Record<string, unknown>[],
  includeBalances: boolean,
  baseCurrency: string,
  nowMs = Date.now(),
): Record<string, unknown>[] {
  const custom = new Map<string, { name: string; order: number; children: Record<string, unknown>[] }>();
  const defaults = new Map<number, { name: string; children: Record<string, unknown>[] }>();
  for (const asset of assets) {
    const groupId = String(asset.groupid ?? -1);
    if (groupId !== "" && groupId !== "-1") {
      const group = custom.get(groupId) ?? {
        name: String(asset.groupName ?? groupId),
        order: Number(asset.groupOrder ?? Number.MAX_SAFE_INTEGER),
        children: [],
      };
      group.children.push(publicAsset(asset, includeBalances, baseCurrency, nowMs));
      custom.set(groupId, group);
      continue;
    }
    const type = Number(asset.type ?? 0);
    const group = defaults.get(type) ?? { name: assetTypeName(type), children: [] };
    group.children.push(publicAsset(asset, includeBalances, baseCurrency, nowMs));
    defaults.set(type, group);
  }
  return [
    ...[...custom.values()].sort((a, b) => a.order - b.order),
    ...[...defaults.entries()].sort(([a], [b]) => a - b).map(([, group]) => group),
  ].map(({ name, children }) => ({ name, children }));
}

/** 将钱迹独立借入或借出详情转换为查询所需的稳定字段。 */
export function publicDebtAccount(asset: Record<string, unknown>, baseCurrency: string): Record<string, unknown> {
  if (!asset.loan || typeof asset.loan !== "object" || Array.isArray(asset.loan)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹借入或借出详情缺少必要信息", 502);
  }
  const loan = asset.loan as Record<string, unknown>;
  const currency = publicAssetCurrency(asset, baseCurrency);
  const subtype = Number(asset.stype);
  const state = Number(asset.status);
  const principal = Number(loan.money ?? 0);
  const balance = Number(asset.money ?? 0);
  const totalPaid = Number(loan.totalpay ?? 0);
  const extra = asset.extra && typeof asset.extra === "object" && !Array.isArray(asset.extra)
    ? asset.extra as Record<string, unknown>
    : {};
  const finishedAt = Number(extra.ftime ?? -1);
  if (
    ![51, 52].includes(subtype) || ![0, 1].includes(state) ||
    [principal, balance, totalPaid].some((value) => !Number.isFinite(value)) || !Number.isInteger(finishedAt)
  ) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹借入或借出详情字段无效", 502);
  }
  const result: Record<string, unknown> = {
    id: publicBillId("assetId", asset.id),
    name: String(asset.name ?? ""),
    direction: subtype === 52 ? "lent" : "borrowed",
    status: state === 1 ? "ended" : "active",
    currency,
    principal: Math.abs(principal),
    balance: Math.abs(balance),
    startDate: String(loan.startdate ?? ""),
    endDate: String(loan.enddate ?? ""),
    totalPaid: Math.abs(totalPaid),
  };
  if (state === 1 && finishedAt > 0) result.finishedAt = finishedAt;
  return result;
}

/** 将钱迹资产类型代码映射为默认分组名称。 */
function assetTypeName(type: number): string {
  return ({ 1: "资金", 2: "信用卡", 3: "充值", 4: "投资", 5: "债务记录", 6: "债务", 7: "社会保障" } as Record<number, string>)[type] ?? "其它";
}

/** 将单个分类转换为公开字段。 */
function publicCategoryItem(category: Record<string, unknown>): Record<string, unknown> {
  return {
    id: publicCategoryId(category.id ?? category.cateid),
    name: String(category.name ?? ""),
    type: Number(category.type ?? category.t ?? -1),
    level: Number(category.level ?? 1),
    parentId: publicCategoryParentId(category.parentid ?? -1),
  };
}

/** 将一级分类及其直属子分类转换为公开结构。 */
export function publicCategory(category: Record<string, unknown>): Record<string, unknown> {
  return { ...publicCategoryItem(category), children: categoryChildren(category).map(publicCategoryItem) };
}

/** 安全读取分类的直属子分类列表。 */
export function categoryChildren(category: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(category.sublist)
    ? category.sublist.filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === "object" && !Array.isArray(child))
    : [];
}

/** 校验并输出钱迹分类 ID。 */
function publicCategoryId(value: unknown): string {
  const text = isRawJsonNumber(value) ? JSON.stringify(value) : String(value);
  if (!isPositiveLongId(text)) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹分类包含无效 ID", 502);
  return text;
}

/** 校验并输出允许哨兵值的父分类 ID。 */
function publicCategoryParentId(value: unknown): string {
  const text = isRawJsonNumber(value) ? JSON.stringify(value) : String(value);
  if (!isParentLongId(text)) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹分类包含无效父分类 ID", 502);
  return text;
}

/** 将钱迹标签转换为稳定的公开字段。 */
function publicTag(tag: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(tag.id),
    name: String(tag.name ?? ""),
    status: Number(tag.status ?? 1),
  };
}

/** 按钱迹标签组组织公开标签列表。 */
export function publicTagGroups(tags: Record<string, unknown>[]): Record<string, unknown>[] {
  const groups = new Map<string, { groupId: string; name: string; children: Record<string, unknown>[] }>();
  for (const tag of tags) {
    const groupId = String(tag.groupId ?? "");
    const group = groups.get(groupId) ?? { groupId, name: String(tag.groupName ?? ""), children: [] };
    group.children.push(publicTag(tag));
    groups.set(groupId, group);
  }
  return [...groups.values()];
}

/** 从数据库行恢复用于完整读取和更新的钱迹账单对象。 */
export function cachedBillObject(row: BillRow): Record<string, unknown> {
  const raw = parseQianjiJson(row.rawJson) as Record<string, unknown>;
  raw.remark ??= row.remark;
  raw.assetid ??= row.assetid;
  return raw;
}

/** 将完整钱迹账单转换为受控的公开字段。 */
export function publicBill(raw: Record<string, unknown>): Record<string, unknown> {
  const bill: Record<string, unknown> = {
    id: publicBillId("id", raw.id),
    bookId: publicBillId("bookId", raw.bookid),
    time: raw.time,
    type: raw.type,
    money: publicMoney(raw),
    remark: raw.remark ?? "",
    categoryId: raw.cateid === undefined || raw.cateid === null || String(raw.cateid) === "-1"
      ? null
      : publicBillId("categoryId", raw.cateid),
    assetId: publicOptionalAssetId(raw.assetid),
    createTime: raw.createtime,
  };

  if (raw.updatetime !== undefined && raw.updatetime !== null) bill.updateTime = raw.updatetime;

  if (raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)) {
    const rawExtra = raw.extra as Record<string, unknown>;
    if (Array.isArray(rawExtra.tags)) bill.tagIds = rawExtra.tags.map(publicOpaqueId);
  }
  addSharedBillFields(bill, raw);
  return bill;
}

/** 补齐账单摘要和详情共用的公开字段。 */
function addSharedBillFields(output: Record<string, unknown>, raw: Record<string, unknown>): void {
  addOptionalAssetReference(output, "fromId", raw.fromid);
  addOptionalAssetReference(output, "targetId", raw.targetid);
  addBillFlag(output, raw);
  addBillAdjustment(output, raw);
  addBillAttribution(output, raw);
  const conversion = publicCurrencyConversion(raw);
  if (conversion) output.currencyConversion = conversion;
  addBillRelationships(output, raw);
}

/** 返回账单保存时的跨币种金额，不使用当前价格重算历史记录。 */
export function publicCurrencyConversion(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  return validatedCurrencyConversion(raw);
}

/** 按账单类型公开手续费和优惠，避免错误解释其他业务类型的 `transfee`。 */
function addBillAdjustment(output: Record<string, unknown>, raw: Record<string, unknown>): void {
  const type = Number(raw.type);
  if (![0, 2, 3, 5].includes(type)) return;
  const adjustment = Number(billExtra(raw).transfee ?? 0);
  output.discount = adjustment < 0 ? Math.abs(adjustment) : 0;
  if ([2, 3].includes(type)) output.fee = adjustment > 0 ? adjustment : 0;
}

/** 公开记账人和账单来源，避免调用方读取上游内部字段。 */
function addBillAttribution(output: Record<string, unknown>, raw: Record<string, unknown>): void {
  output.createdBy = {
    userId: publicUserId(raw.userid),
    name: String(raw.username ?? ""),
  };
  const code = Number(raw.platform ?? 0);
  output.source = { code, name: billSourceName(code, raw) };
}

function billSourceName(code: number, raw: Record<string, unknown>): string {
  if (code === 120 || (code === 1 && Number(raw.importpackid ?? 0) > 1_610_208_000)) return "repeatTask";
  if (code === 121) return "installment";
  if (code === 122) return "automatic";
  if (code >= 2) return "import";
  if (code === 0) return "manual";
  return "unknown";
}

/** 将退款和报销关系转换为公开账单 ID 字段。 */
function addBillRelationships(output: Record<string, unknown>, raw: Record<string, unknown>): void {
  const extra = billExtra(raw);
  const refunds = refundRelationshipMap(raw);
  const reimbursements = reimbursementRelationshipMap(raw);
  const refundBillIds = [...refunds.keys()];
  const reimbursementBillIds = [...reimbursements.keys()];
  if (refundBillIds.length > 0) output.refundBillIds = refundBillIds;
  if (reimbursementBillIds.length > 0) output.reimbursementBillIds = reimbursementBillIds;
  if (refunds.size > 0) {
    const totalAmount = relationshipTotal(refunds);
    output.refundProgress = {
      totalAmount,
      remainingAmount: Math.max(0, decimalSubtract(publicMoney(raw), totalAmount)),
    };
  }
  if (reimbursements.size > 0) {
    const totalAmount = relationshipTotal(reimbursements);
    output.reimbursementProgress = {
      totalAmount,
      remainingAmount: Math.max(0, decimalSubtract(
        decimalSubtract(publicMoney(raw), relationshipTotal(refunds)),
        totalAmount,
      )),
    };
  }
  if (extra.refundsid !== undefined && extra.refundsid !== null) {
    output.refundSourceBillId = publicBillId("id", extra.refundsid);
  }
  if (extra.bxsid !== undefined && extra.bxsid !== null) {
    output.reimbursementSourceBillId = publicBillId("id", extra.bxsid);
  }
}

/** 将 APK 内部空资产哨兵收口为公开 null。 */
function publicOptionalAssetId(value: unknown): string | null {
  if (value === undefined || value === null || String(value) === "-1") return null;
  return publicBillId("assetId", value);
}

/** 只在存在真实资产引用时公开来源或目标资产。 */
function addOptionalAssetReference(output: Record<string, unknown>, field: "fromId" | "targetId", value: unknown): void {
  if (value === undefined || value === null || String(value) === "-1") return;
  output[field] = publicBillId(field, value);
}

function nextCreditRepaymentDate(
  nowMs: number,
  statementDay: number,
  repaymentDay: number,
  daysAfterStatement: boolean,
): number | undefined {
  if (daysAfterStatement && (!Number.isInteger(statementDay) || statementDay <= 0)) return undefined;
  const offsetMs = 8 * 60 * 60 * 1000;
  const localNow = new Date(nowMs + offsetMs);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  let candidate: number;
  if (!daysAfterStatement) {
    candidate = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), repaymentDay);
    if (candidate < today) candidate = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth() + 1, repaymentDay);
  } else {
    let cycleMonth = localNow.getUTCMonth() - 1;
    candidate = Date.UTC(localNow.getUTCFullYear(), cycleMonth, statementDay + repaymentDay);
    while (candidate < today) {
      cycleMonth += 1;
      candidate = Date.UTC(localNow.getUTCFullYear(), cycleMonth, statementDay + repaymentDay);
    }
  }
  return Math.floor((candidate - offsetMs) / 1000);
}

/** 将官方原始金额还原为 APP 主金额输入框语义。 */
function publicMoney(raw: Record<string, unknown>): number {
  const conversion = publicCurrencyConversion(raw);
  if (conversion) return Number(conversion.sourceAmount);
  return [0, 2, 3, 5].includes(Number(raw.type))
    ? inputBillMoney(raw.money, billExtra(raw).transfee)
    : Number(raw.money);
}

/** 将钱迹内部统计位值转换为与 APP 一致的两个开关。 */
function addBillFlag(output: Record<string, unknown>, raw: Record<string, unknown>): void {
  const rawFlag = billExtra(raw).flag;
  const flag = rawFlag === undefined || rawFlag === null || rawFlag === "" ? 0 : Number(rawFlag);
  if (![0, 1, 2, 3].includes(flag)) return;
  output.excludeFromIncomeExpense = (flag & 1) !== 0;
  output.excludeFromBudget = (flag & 2) !== 0;
}
