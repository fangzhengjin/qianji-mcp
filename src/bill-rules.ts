import { randomInt } from "node:crypto";

import { decimalAdd, decimalRound, decimalSubtract } from "./decimal.ts";
import { AppError } from "./errors.ts";
import { isCurrencySymbol, isOptionalPositiveLongId, isPositiveLongId } from "./ids.ts";
import { isRawJsonNumber, type SyncBillResult } from "./qianji-client.ts";

export type BillIdInput = string;
export type BookIdInput = string;
export type ReferenceIdInput = string;

export interface CurrencyConversionInput {
  sourceCurrency?: string;
  targetAmount?: number;
  baseAmount?: number;
}

export interface ListBillsInput {
  bookId?: BookIdInput;
  allBooks?: boolean;
  startTime?: number;
  endTime?: number;
  createStartTime?: number;
  createEndTime?: number;
  type?: number;
  types?: number[];
  minMoney?: number;
  maxMoney?: number;
  categoryId?: ReferenceIdInput;
  categoryIds?: ReferenceIdInput[];
  includeSubcategories?: boolean;
  tagId?: string;
  tagIds?: string[];
  tagMatch?: "any" | "all";
  remarkKeyword?: string;
  assetId?: ReferenceIdInput;
  assetIds?: ReferenceIdInput[];
  fromAssetId?: ReferenceIdInput;
  targetAssetId?: ReferenceIdInput;
  source?: 0 | 2 | 120 | 121 | 122;
  memberIds?: string[];
  currency?: string;
  noAsset?: boolean;
  noTags?: boolean;
  excludeFromIncomeExpense?: boolean;
  excludeFromBudget?: boolean;
  sort?: "timeDesc" | "timeAsc" | "moneyDesc" | "moneyAsc";
  limit?: number;
  cursor?: string;
}

export interface CreateBillInput {
  bookId?: BookIdInput;
  time?: number;
  type: 0 | 1;
  money: number;
  discount?: number;
  categoryId: ReferenceIdInput;
  assetId?: ReferenceIdInput | null;
  remark?: string;
  tagIds?: string[];
  excludeFromIncomeExpense?: boolean;
  excludeFromBudget?: boolean;
  reimbursable?: boolean;
  currencyConversion?: CurrencyConversionInput;
}

export interface UpdateBillPatch {
  bookId?: BookIdInput;
  time?: number;
  money?: number;
  discount?: number;
  categoryId?: ReferenceIdInput;
  assetId?: ReferenceIdInput | null;
  remark?: string;
  tagIds?: string[];
  excludeFromIncomeExpense?: boolean;
  excludeFromBudget?: boolean;
  reimbursable?: boolean;
  currencyConversion?: CurrencyConversionInput;
}

export interface CreateTransferInput {
  bookId?: BookIdInput;
  time?: number;
  money: number;
  fromAssetId: ReferenceIdInput;
  targetAssetId: ReferenceIdInput;
  creditRepayment?: boolean;
  fee?: number;
  discount?: number;
  remark?: string;
  tagIds?: string[];
  excludeFromIncomeExpense?: boolean;
  excludeFromBudget?: boolean;
  currencyConversion?: Omit<CurrencyConversionInput, "sourceCurrency">;
}

export interface UpdateTransferPatch {
  bookId?: BookIdInput;
  time?: number;
  money?: number;
  fromAssetId?: ReferenceIdInput;
  targetAssetId?: ReferenceIdInput;
  creditRepayment?: boolean;
  fee?: number;
  discount?: number;
  remark?: string;
  tagIds?: string[];
  excludeFromIncomeExpense?: boolean;
  excludeFromBudget?: boolean;
  currencyConversion?: Omit<CurrencyConversionInput, "sourceCurrency">;
}

export interface CreateRefundInput {
  sourceBillId: BillIdInput;
  money: number;
  time?: number;
  assetId?: ReferenceIdInput | null;
  remark?: string;
  tagIds?: string[];
  currencyConversion?: Omit<CurrencyConversionInput, "sourceCurrency">;
}

export interface UpdateRefundPatch {
  money?: number;
  time?: number;
  assetId?: ReferenceIdInput | null;
  remark?: string;
  tagIds?: string[];
  currencyConversion?: Omit<CurrencyConversionInput, "sourceCurrency">;
}

export interface ReimburseBillsInput {
  sourceBillIds: BillIdInput[];
  money: number;
  assetId?: ReferenceIdInput | null;
  time?: number;
  remark?: string;
  tagIds?: string[];
  confirmReimbursementUpgrade?: boolean;
  currencyConversion?: Omit<CurrencyConversionInput, "sourceCurrency">;
}

export interface DeleteBillInput {
  billId: BillIdInput;
  cascadeRelatedBills?: boolean;
}

export type StatisticsRangeInput =
  | { kind: "month"; year: number; month: number }
  | { kind: "year"; year: number }
  | { kind: "custom"; startTime: number; endTime: number }
  | { kind: "all" };

export interface BillStatisticsInput {
  bookId?: BookIdInput;
  allBooks?: boolean;
  range: StatisticsRangeInput;
  memberIds?: string[];
  currency?: string;
  tagIds?: string[];
  tagMatch?: "any" | "all";
  categoryIds?: ReferenceIdInput[];
  includeSubcategories?: boolean;
}

export interface ListBillsResult {
  bills: Record<string, unknown>[];
  nextCursor: string | null;
}

/** 读取账单保存的跨币种对象，字段不完整或无效时拒绝伪造金额语义。 */
export function currencyExtra(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = billExtra(raw).curr;
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单包含无效跨币种信息", 502);
  }
  return value as Record<string, unknown>;
}

/** 校验并公开账单保存的跨币种金额，禁止无效上游值进入缓存或统计。 */
export function validatedCurrencyConversion(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const curr = currencyExtra(raw);
  if (!curr) return undefined;
  const sourceCurrency = String(curr.ss ?? "").trim();
  const sourceAmount = numericAmount(curr.sv);
  if (
    !isCurrencySymbol(sourceCurrency) ||
    sourceAmount === undefined || sourceAmount < 0
  ) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单跨币种信息字段不完整", 502);
  const result: Record<string, unknown> = { sourceCurrency, sourceAmount };
  addOptionalCurrencyAmount(result, curr.bs, curr.bv, "baseCurrency", "baseAmount", "本位");
  addOptionalCurrencyAmount(result, curr.ts, curr.tv, "targetCurrency", "targetAmount", "目标");
  return result;
}

function addOptionalCurrencyAmount(
  result: Record<string, unknown>,
  symbolValue: unknown,
  amountValue: unknown,
  symbolField: string,
  amountField: string,
  label: string,
): void {
  const symbol = String(symbolValue ?? "").trim();
  const hasAmount = amountValue !== undefined && amountValue !== null;
  const amount = hasAmount ? numericAmount(amountValue) : undefined;
  if (!symbol) {
    if (hasAmount && (amount === undefined || amount !== 0)) {
      throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹账单跨币种${label}金额缺少币种`, 502);
    }
    return;
  }
  if (!isCurrencySymbol(symbol) || amount === undefined || amount < 0) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹账单跨币种${label}金额无效`, 502);
  }
  result[symbolField] = symbol;
  result[amountField] = amount;
}

export const MAX_MONEY = 9_999_999_999.99;
export const MAX_SEARCH_KEYWORD_LENGTH = 42;
export const MAX_BILL_CURSOR_LENGTH = 65_536;

/** 规范化账单 ID，并拒绝会丢失精度的 JavaScript 数字表示。 */
export function normalizeBillId(value: BillIdInput): string {
  if (!isPositiveLongId(value)) throw new AppError("INVALID_BILL_ID", "账单 ID 无效");
  return value;
}

/** 规范化账本 ID，并保留钱迹使用的 `-1` 默认账本哨兵值。 */
export function normalizeBookId(value: BookIdInput): string {
  if (!isOptionalPositiveLongId(value)) throw new AppError("INVALID_BOOK_ID", "账本 ID 无效");
  return value;
}

/** 规范化必选分类 ID。 */
export function normalizeCategoryId(value: ReferenceIdInput): string {
  return normalizeReferenceId(value, "分类", "INVALID_CATEGORY_ID", false);
}

/** 规范化可为空的资产 ID，其中 `-1` 表示未选择资产。 */
export function normalizeAssetId(value: ReferenceIdInput | null): string {
  if (value === null) return "-1";
  return normalizeReferenceId(value, "资产", "INVALID_ASSET_ID", true);
}

/** 规范化转账等场景要求的必选资产 ID。 */
export function normalizeRequiredAssetId(value: ReferenceIdInput): string {
  return normalizeReferenceId(value, "资产", "INVALID_ASSET_ID", false);
}

/** 按资源约束验证引用 ID，避免把不安全数字送入钱迹协议。 */
function normalizeReferenceId(
  value: ReferenceIdInput,
  resource: string,
  code: string,
  allowMinusOne: boolean,
): string {
  const valid = allowMinusOne ? isOptionalPositiveLongId(value) : isPositiveLongId(value);
  if (!valid) throw new AppError(code, `${resource} ID 无效`);
  return value;
}

/** 生成钱迹约定的 64 位客户端账单 ID，并以十进制字符串保持精度。 */
export function createBillId(epochMs = Date.now()): string {
  return (BigInt(epochMs) * 1_000_000n + BigInt(randomInt(100_000, 200_000))).toString();
}

/** 校验业务金额为有限正数、最多两位小数且不超过钱迹上限。 */
export function requirePositiveMoney(value: number, label: string): void {
  requireMoney(value, label, false);
}

/** 校验可为零的手续费、优惠或换算金额。 */
export function requireNonnegativeMoney(value: number, label: string): void {
  requireMoney(value, label, true);
}

function requireMoney(value: number, label: string, allowZero: boolean): void {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new AppError("INVALID_MONEY", `${label}${allowZero ? "不能为负数" : "必须大于 0"}`);
  }
  if (value > MAX_MONEY) throw new AppError("INVALID_MONEY", `${label}不能超过 ${MAX_MONEY}`);
  if (decimalRound(value, 2) !== value) {
    throw new AppError("INVALID_MONEY", `${label}最多保留两位小数`);
  }
}

/** 将账单的手续费或优惠折算为钱迹单一的 `transfee` 字段。 */
export function billAdjustment(money: number, fee: number, discount: number): number {
  requirePositiveMoney(money, "账单金额");
  requireNonnegativeMoney(fee, "手续费");
  requireNonnegativeMoney(discount, "优惠金额");
  if (fee > 0 && discount > 0) throw new AppError("INVALID_BILL_ADJUSTMENT", "手续费和优惠金额不能同时大于 0");
  if (fee > money) throw new AppError("INVALID_BILL_ADJUSTMENT", "手续费不能大于账单金额");
  if (discount > money) throw new AppError("INVALID_BILL_ADJUSTMENT", "优惠金额不能大于账单金额");
  return fee > 0 ? fee : -discount;
}

/** 将 APP 主金额输入值转换为钱迹持久化的原始账单金额。 */
export function storedBillMoney(inputMoney: number, adjustment: number): number {
  return decimalSubtract(inputMoney, Math.abs(adjustment));
}

/** 从钱迹原始账单金额还原 APP 主金额输入值。 */
export function inputBillMoney(rawMoney: unknown, adjustment: unknown): number {
  const money = numericAmount(rawMoney);
  const feeOrDiscount = adjustment === undefined || adjustment === null ? 0 : numericAmount(adjustment);
  if (money === undefined || money < 0 || feeOrDiscount === undefined) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单金额或手续费信息无效", 502);
  }
  return decimalAdd(money, Math.abs(feeOrDiscount));
}

/** 将两个账单标记开关合并为钱迹内部位值，省略的维度保留现值。 */
export function resolveBillFlag(
  currentFlag: unknown,
  input: { excludeFromIncomeExpense?: boolean; excludeFromBudget?: boolean },
): 0 | 1 | 2 | 3 {
  const current = [0, 1, 2, 3].includes(Number(currentFlag)) ? Number(currentFlag) : 0;
  const excludeFromIncomeExpense = input.excludeFromIncomeExpense ?? ((current & 1) !== 0);
  const excludeFromBudget = input.excludeFromBudget ?? ((current & 2) !== 0);
  return ((excludeFromIncomeExpense ? 1 : 0) | (excludeFromBudget ? 2 : 0)) as 0 | 1 | 2 | 3;
}

/** 判断同步回来的转账是否完整应用了请求补丁。 */
export function transferPatchApplied(
  raw: Record<string, unknown>,
  patch: UpdateTransferPatch,
  storedMoney: number,
  adjustment: number,
  fromAssetId: string,
  targetAssetId: string,
  type: 2 | 3,
  expectedFlag: number,
): boolean {
  if (
    Number(raw.type) !== type ||
    Number(raw.money) !== storedMoney ||
    String(raw.fromid) !== fromAssetId ||
    String(raw.targetid) !== targetAssetId ||
    Number(billExtra(raw).transfee ?? 0) !== adjustment
  ) return false;
  if (patch.bookId !== undefined && String(raw.bookid) !== normalizeBookId(patch.bookId)) return false;
  if (patch.time !== undefined && Number(raw.time) !== patch.time) return false;
  if (patch.remark !== undefined && String(raw.remark ?? "") !== patch.remark) return false;
  if (patch.tagIds !== undefined && tagIdsFrom(raw).join("\0") !== patch.tagIds.join("\0")) return false;
  if (
    (patch.excludeFromIncomeExpense !== undefined || patch.excludeFromBudget !== undefined) &&
    Number(billExtra(raw).flag ?? 0) !== expectedFlag
  ) return false;
  return true;
}

/** 安全读取账单的 `extra` 对象，缺失或类型异常时返回空对象。 */
export function billExtra(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)
    ? raw.extra as Record<string, unknown>
    : {};
}

/** 将钱迹的关系映射转换为账单 ID 与金额映射。 */
export function relationshipMap(value: unknown): Map<string, number> {
  if (value === undefined || value === null) return new Map();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单关联金额映射无效", 502);
  }
  return new Map(Object.entries(value).map(([id, value]) => {
    const money = numericAmount(value);
    if (money === undefined || money < 0) {
      throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单关联金额无效", 502);
    }
    return [publicBillId("id", id), money];
  }));
}

function numericAmount(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

/** 按官方兼容顺序读取新旧退款关系。 */
export function refundRelationshipMap(raw: Record<string, unknown>): Map<string, number> {
  const extra = billExtra(raw);
  const current = relationshipMap(extra.rfds);
  if (current.size > 0) return current;
  const legacyId = isRawJsonNumber(extra.refundid) ? JSON.stringify(extra.refundid) : String(extra.refundid ?? "");
  if (["", "-1", "0"].includes(legacyId)) return new Map();
  const refundId = publicBillId("id", legacyId);
  const money = numericAmount(extra.refundv);
  if (money === undefined || money < 0) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹旧版退款关联金额无效", 502);
  }
  return money === 0 ? new Map() : new Map([[refundId, money]]);
}

/** 读取新版报销关系，旧版只提供是否已报销标记，没有子账单 ID。 */
export function reimbursementRelationshipMap(raw: Record<string, unknown>): Map<string, number> {
  return relationshipMap(billExtra(raw).bxs);
}

export function hasRefund(raw: Record<string, unknown>): boolean {
  return refundRelationshipMap(raw).size > 0;
}

export function hasReimbursement(raw: Record<string, unknown>): boolean {
  const extra = billExtra(raw);
  return Number(raw.type) === 5 && (reimbursementRelationshipMap(raw).size > 0 || Number(extra.baoxiaoed) === 1);
}

/** 汇总关系映射中的金额。 */
export function relationshipTotal(value: Map<string, number>): number {
  return [...value.values()].reduce((total, money) => decimalAdd(total, money), 0);
}

/** 从关系字段读取源账单 ID，并将上游脏数据转换为稳定错误。 */
export function relationshipSourceId(value: unknown, relation: string): string {
  try {
    return publicBillId("id", value);
  } catch {
    throw new AppError("QIANJI_RESPONSE_INVALID", `${relation}账单缺少有效源账单关系`, 502);
  }
}

/** 判断关系值是否为有效的正整数 ID。 */
function positiveRelationshipValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const text = isRawJsonNumber(value) ? JSON.stringify(value) : String(value);
  return isPositiveLongId(text);
}

/** 校验退款场景、源分类和创建时的条数上限。 */
export function validateRefundSource(source: Record<string, unknown>, enforceCountLimit: boolean): void {
  if (![0, 5].includes(Number(source.type))) {
    throw new AppError("BILL_SCENARIO_MISMATCH", "退款源账单只允许普通支出 type 0 或待报销支出 type 5");
  }
  if (!positiveRelationshipValue(source.cateid)) {
    throw new AppError("REFUND_SOURCE_CATEGORY_MISSING", "退款源账单缺少有效分类");
  }
  const refunds = refundRelationshipMap(source);
  if (enforceCountLimit && refunds.size >= 25) {
    throw new AppError("REFUND_COUNT_LIMIT_REACHED", "同一源账单最多关联 25 条退款");
  }
}

/** 构造钱迹退款接口接受的最小字段集合。 */
export function refundPayload(
  input: CreateRefundInput,
  assetId: string,
  defaultTime: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    money: input.money,
    time: input.time ?? defaultTime,
  };
  if (assetId !== "-1") payload.assetid = assetId;
  if (input.remark) payload.remark = input.remark;
  if (input.tagIds && input.tagIds.length > 0) payload.tags = input.tagIds;
  return payload;
}

/** 判断同步回来的退款账单是否符合预期字段。 */
export function refundPatchApplied(raw: Record<string, unknown>, expected: CreateRefundInput): boolean {
  return relationshipSourceId(billExtra(raw).refundsid, "退款") === expected.sourceBillId &&
    Number(raw.type) === 20 &&
    Number(raw.money) === expected.money &&
    Number(raw.time) === expected.time &&
    String(raw.assetid ?? "-1") === (expected.assetId ?? "-1") &&
    String(raw.remark ?? "") === (expected.remark ?? "") &&
    tagIdsFrom(raw).join("\0") === (expected.tagIds ?? []).join("\0");
}

/** 将允许修改的普通账单字段写入完整上游对象。 */
export function applyPatch(
  raw: Record<string, unknown>,
  patch: UpdateBillPatch,
  adjustment?: number,
  storedMoney?: number,
): void {
  if (patch.bookId !== undefined) raw.bookid = normalizeBookId(patch.bookId);
  if (patch.time !== undefined) raw.time = patch.time;
  if (storedMoney !== undefined) raw.money = storedMoney;
  if (patch.categoryId !== undefined) raw.cateid = normalizeCategoryId(patch.categoryId);
  if (patch.assetId !== undefined) raw.assetid = normalizeAssetId(patch.assetId);
  if (patch.remark !== undefined) raw.remark = patch.remark;
  const changesFlag = patch.excludeFromIncomeExpense !== undefined || patch.excludeFromBudget !== undefined;
  if (patch.tagIds !== undefined || changesFlag || adjustment !== undefined) {
    const existing = raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)
      ? raw.extra as Record<string, unknown>
      : {};
    if (patch.tagIds !== undefined) existing.tags = patch.tagIds;
    if (changesFlag) existing.flag = resolveBillFlag(existing.flag, patch);
    if (adjustment !== undefined) existing.transfee = adjustment;
    raw.extra = existing;
  }
}

/** 读取账单标签并保持钱迹不透明 ID 的原始字符串。 */
export function tagIdsFrom(raw: Record<string, unknown>): string[] {
  const extra = raw.extra;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return [];
  const tags = (extra as Record<string, unknown>).tags;
  return Array.isArray(tags) ? tags.map(publicOpaqueId) : [];
}

/** 按 APK 同步结果逐项识别已成功、冲突和未确认账单。 */
export function inspectWriteResult(
  result: SyncBillResult,
  expectedIds: string[],
): { appliedIds: string[]; error?: AppError } {
  const requested = new Set(expectedIds);
  const successIds = [...result.new_ids, ...result.update_ids, ...result.del_ids];
  const returnedIds = [...successIds, ...result.conf_ids];
  const applied = new Set(successIds);
  const conflicts = new Set(result.conf_ids);
  const appliedIds = expectedIds.filter((id) => applied.has(id));
  if (
    new Set(returnedIds).size !== returnedIds.length ||
    returnedIds.some((id) => !requested.has(id))
  ) {
    return {
      appliedIds,
      error: new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单同步结果包含重复或未请求的 ID", 502),
    };
  }
  const failedIds = expectedIds.filter((id) => !applied.has(id) && !conflicts.has(id));
  if (conflicts.size === 0 && failedIds.length === 0 && !result.has_failed) return { appliedIds };
  if (conflicts.size === 0 && failedIds.length === 0) {
    return {
      appliedIds,
      error: new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单同步结果同时包含全部成功 ID 和失败标记", 502),
    };
  }

  const statuses = expectedIds.map((id, index) =>
    `第 ${index + 1} 项（${id}）=${applied.has(id) ? "成功" : conflicts.has(id) ? "冲突" : "失败（上游未确认）"}`
  ).join("，");
  if (appliedIds.length > 0) {
    return {
      appliedIds,
      error: new AppError(
        "WRITE_PARTIAL",
        `钱迹账单写入仅部分成功，逐项结果：${statuses}，成功项已经写入，请勿重试成功项`,
        409,
      ),
    };
  }
  if (conflicts.size > 0 && failedIds.length === 0 && !result.has_failed) {
    return { appliedIds, error: new AppError("WRITE_CONFLICT", `钱迹账单写入发生冲突，逐项结果：${statuses}`, 409) };
  }
  return { appliedIds, error: new AppError("WRITE_FAILED", `钱迹账单写入失败，逐项结果：${statuses}`, 502) };
}

/** 判断普通账单同步结果是否完整应用了请求补丁。 */
export function patchWasApplied(
  raw: Record<string, unknown>,
  patch: UpdateBillPatch,
  adjustment?: number,
  expectedFlag = 0,
  expectedStoredMoney?: number,
): boolean {
  if (patch.bookId !== undefined && String(raw.bookid) !== normalizeBookId(patch.bookId)) return false;
  if (patch.time !== undefined && Number(raw.time) !== patch.time) return false;
  // 钱迹用 type 5 表示待报销支出，取消待报销后应恢复为普通支出类型。
  if (patch.reimbursable !== undefined && (Number(raw.type) === 5) !== patch.reimbursable) return false;
  if (expectedStoredMoney !== undefined && Number(raw.money) !== expectedStoredMoney) return false;
  if (adjustment !== undefined && Number(billExtra(raw).transfee ?? 0) !== adjustment) return false;
  if (patch.categoryId !== undefined && String(raw.cateid) !== normalizeCategoryId(patch.categoryId)) return false;
  if (patch.assetId !== undefined && String(raw.assetid) !== normalizeAssetId(patch.assetId)) return false;
  if (patch.remark !== undefined && raw.remark !== patch.remark) return false;
  if (patch.tagIds !== undefined) {
    const actual = tagIdsFrom(raw);
    if (actual.length !== patch.tagIds.length || actual.some((id, index) => id !== patch.tagIds![index])) return false;
  }
  if (
    (patch.excludeFromIncomeExpense !== undefined || patch.excludeFromBudget !== undefined) &&
    Number(billExtra(raw).flag ?? 0) !== expectedFlag
  ) return false;
  return true;
}

/** 按公开字段语义校验并转换账单相关 ID。 */
export function publicBillId(field: string, value: unknown): string {
  const input = isRawJsonNumber(value) ? JSON.stringify(value) : value;
  if (typeof input !== "string" && typeof input !== "number") {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单包含无效 ID", 502);
  }
  try {
    const text = String(input);
    if (field === "id") return normalizeBillId(text);
    if (field === "bookId") return normalizeBookId(text);
    if (field === "categoryId") return normalizeCategoryId(text);
    return normalizeAssetId(text);
  } catch {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单包含无效 ID", 502);
  }
}

/** 将标签等不透明 ID 转换为非空字符串。 */
export function publicOpaqueId(value: unknown): string {
  const text = isRawJsonNumber(value)
    ? JSON.stringify(value)
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  if (!text) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单包含无效标签 ID", 502);
  return text;
}

/** 将记账人 ID 转换为精确文本，并保留旧账单的空所有者。 */
export function publicUserId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "超出安全范围的钱迹用户 ID 必须使用精确十进制值", 502);
  }
  const text = isRawJsonNumber(value)
    ? JSON.stringify(value)
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  if (!text) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单包含无效用户 ID", 502);
  return text;
}
