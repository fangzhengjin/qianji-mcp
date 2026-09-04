import { billExtra, publicUserId, refundRelationshipMap, reimbursementRelationshipMap, tagIdsFrom } from "./bill-rules.ts";
import type { BillRow } from "./data-store.ts";
import { decimalAdd, decimalDivide, decimalMultiply, decimalRound, decimalSubtract } from "./decimal.ts";
import { AppError } from "./errors.ts";
import { cachedBillObject, categoryChildren, publicCurrencyConversion } from "./qianji-mappers.ts";

export type StatisticsUnit = "day" | "month" | "year";

export interface StatisticsOptions {
  rows: BillRow[];
  allRows: BillRow[];
  categories: Record<string, unknown>[];
  startTime: number;
  endTime: number;
  unit: StatisticsUnit;
  baseCurrency: string;
  currency?: string;
  memberIds?: string[];
  tagIds?: string[];
  tagMatch?: "any" | "all";
  categoryIds?: string[];
  nowMs: number;
}

interface StatItem {
  income: number;
  spend: number;
  pureIncome: number;
  pureSpend: number;
  transfer: number;
  creditRepayment: number;
  reimbursement: number;
  reimbursementIncome: number;
  reimbursementSpend: number;
  refund: number;
  refundIncome: number;
  refundSpend: number;
  fee: number;
  discount: number;
  excludedIncomeExpense: number;
  excludedBudget: number;
}

interface CategoryValue {
  categoryId?: string;
  billType?: number;
  name: string;
  amount: number;
  directAmount: number;
  children: Map<string, CategoryValue>;
}

const EMPTY_ITEM: StatItem = {
  income: 0,
  spend: 0,
  pureIncome: 0,
  pureSpend: 0,
  transfer: 0,
  creditRepayment: 0,
  reimbursement: 0,
  reimbursementIncome: 0,
  reimbursementSpend: 0,
  refund: 0,
  refundIncome: 0,
  refundSpend: 0,
  fee: 0,
  discount: 0,
  excludedIncomeExpense: 0,
  excludedBudget: 0,
};

/** 按 APK `BillStatItem/processStat` 的固定主报表语义计算公开统计结构。 */
export function calculateBillStatistics(options: StatisticsOptions): Record<string, unknown> {
  const rawById = new Map(options.allRows.map((row) => [row.id, cachedBillObject(row)]));
  const candidates = options.rows.map((row) => ({ row, raw: rawById.get(row.id)! })).filter(({ row, raw }) =>
    (!options.memberIds || options.memberIds.includes(publicUserId(raw.userid))) &&
    matchesTags(raw, options.tagIds, options.tagMatch) &&
    (!options.categoryIds || (row.cateid !== null && options.categoryIds.includes(row.cateid)))
  );
  const availableCurrencies = new Set([options.baseCurrency]);
  for (const { raw } of candidates) {
    const source = publicCurrencyConversion(raw)?.sourceCurrency;
    if (typeof source === "string") availableCurrencies.add(source);
  }
  const currency = options.currency ?? options.baseCurrency;
  const matched = candidates.filter(({ raw }) =>
    options.currency === undefined || (publicCurrencyConversion(raw)?.sourceCurrency ?? options.baseCurrency) === currency
  );
  const summary = { ...EMPTY_ITEM };
  let incomeItemCount = 0;
  let spendItemCount = 0;
  let reimbursementBillCount = 0;
  const members = new Map<string, { userId: string; name: string; income: number; spend: number }>();
  const periods = new Map<string, { income: number; spend: number }>();
  const spendCategories = new Map<string, CategoryValue>();
  const incomeCategories = new Map<string, CategoryValue>();
  const categoryIndex = buildCategoryIndex(options.categories);

  for (const { row, raw } of matched) {
    const item = statItem(raw, currency, rawById, 1);
    addItem(summary, item);
    if (item.income > 0) incomeItemCount++;
    if (item.spend > 0) spendItemCount++;
    if (row.type === 5) reimbursementBillCount++;
    const userId = publicUserId(raw.userid);
    const member = members.get(userId) ?? { userId, name: String(raw.username ?? ""), income: 0, spend: 0 };
    member.income = decimalAdd(member.income, item.income);
    member.spend = decimalAdd(member.spend, item.spend);
    members.set(userId, member);
    const period = periodKey(row.time, options.unit);
    const time = periods.get(period) ?? { income: 0, spend: 0 };
    time.income = decimalAdd(time.income, item.income);
    time.spend = decimalAdd(time.spend, item.spend);
    periods.set(period, time);
    if ([0, 10].includes(row.type) && item.pureSpend > 0) {
      addCategory(spendCategories, categoryIndex, row, item.pureSpend, row.type === 10 ? "借入利息" : undefined);
    } else if ([1, 11].includes(row.type) && item.pureIncome > 0) {
      addCategory(incomeCategories, categoryIndex, row, item.pureIncome, row.type === 11 ? "借出利息" : undefined);
    } else if (row.type === 5 && item.reimbursementSpend > 0) {
      addCategory(spendCategories, categoryIndex, row, item.reimbursementSpend);
    }
  }

  const normalized = normalizeSummary(summary);
  const periodCount = averagePeriodCount(options, periods);
  const averageIncome = periodCount === 0 ? 0 : decimalAdd(
    decimalAdd(summary.pureIncome / periodCount, summary.reimbursementIncome / periodCount),
    summary.refundIncome / periodCount,
  );
  const averageSpend = periodCount === 0 ? 0 : decimalAdd(
    decimalAdd(decimalAdd(summary.pureSpend / periodCount, summary.reimbursementSpend / periodCount), summary.fee / periodCount),
    summary.refundSpend / periodCount,
  );
  return {
    range: {
      startTime: options.startTime,
      endTime: options.endTime,
      timezoneOffsetSeconds: 28_800,
    },
    currency,
    availableCurrencies: [...availableCurrencies].sort(),
    summary: normalized,
    counts: {
      matchedBillCount: matched.length,
      incomeItemCount,
      spendItemCount,
      reimbursementBillCount,
    },
    average: {
      unit: options.unit,
      periodCount,
      income: averageIncome,
      spend: averageSpend,
      balance: decimalSubtract(averageIncome, averageSpend),
    },
    categoryBreakdown: {
      spend: publicCategories(spendCategories, normalized.totalSpend),
      income: publicCategories(incomeCategories, normalized.totalIncome),
    },
    memberBreakdown: [...members.values()].map((member) => ({
      userId: member.userId,
      name: member.name,
      income: member.income,
      spend: member.spend,
      balance: decimalSubtract(member.income, member.spend),
    })),
    timeSeries: {
      unit: options.unit,
      items: [...periods.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([period, value]) => ({
        period,
        income: value.income,
        spend: value.spend,
        balance: decimalSubtract(value.income, value.spend),
      })),
    },
  };
}

/** 复用 APK `BillStatItem.fromBill(..., true, ...)` 的金额语义计算预算支出。 */
export function calculateBudgetBillAmounts(
  raw: Record<string, unknown>,
  currency: string,
  rawById: Map<string, Record<string, unknown>>,
): { spend: number; excludedFromBudget: number } {
  const item = statItem(raw, currency, rawById, 2);
  return { spend: item.spend, excludedFromBudget: item.excludedBudget };
}

function statItem(
  raw: Record<string, unknown>,
  currency: string,
  rawById: Map<string, Record<string, unknown>>,
  exclusionFlag: 1 | 2,
): StatItem {
  const item = { ...EMPTY_ITEM };
  const type = Number(raw.type);
  let main = moneyForStat(raw, currency);
  const refund = relatedTotal(refundRelationshipMap(raw), rawById, currency);
  const mainAfterRefund = decimalSubtract(main, refund);
  const adjustment = transFeeForStat(raw, currency);
  const excluded = (Number(billExtra(raw).flag ?? 0) & exclusionFlag) !== 0;
  if ([0, 10].includes(type)) {
    main = mainAfterRefund;
    if (main > 0) item.pureSpend = main;
    else if (main < 0) {
      if (!excluded) item.refundIncome = Math.abs(main);
      main = 0;
    }
    if (excluded) item.pureSpend = 0;
  } else if ([1, 11].includes(type)) {
    main = mainAfterRefund;
    if (main > 0 && !excluded) item.pureIncome = main;
    else if (main < 0) {
      if (!excluded) item.refundSpend = Math.abs(main);
      main = 0;
    }
  } else if (type === 5) {
    const reimbursementBase = Math.max(0, mainAfterRefund);
    item.reimbursement = reimbursementBase;
    const reimbursed = relatedTotal(reimbursementRelationshipMap(raw), rawById, currency);
    if (reimbursed > 0 || Number(billExtra(raw).baoxiaoed) === 1) {
      const difference = decimalSubtract(reimbursementBase, reimbursed);
      if (!excluded && difference > 0) item.reimbursementSpend = difference;
      else if (!excluded && difference < 0) item.reimbursementIncome = Math.abs(difference);
      main = Math.abs(difference);
    }
    if (mainAfterRefund < 0 && !excluded) item.refundIncome = Math.abs(mainAfterRefund);
  } else if (type === 2) {
    item.transfer = main;
    main = 0;
  } else if (type === 3) {
    item.creditRepayment = main;
    main = 0;
  } else if (type === 20) {
    item.refund = main;
    main = 0;
  } else {
    main = 0;
  }
  if (!excluded && adjustment > 0) item.fee = adjustment;
  if (!excluded && adjustment < 0) item.discount = Math.abs(adjustment);
  if (main !== 0) {
    const flag = Number(billExtra(raw).flag ?? 0);
    if ((flag & 1) !== 0) item.excludedIncomeExpense = main;
    if ((flag & 2) !== 0) item.excludedBudget = main;
  }
  item.income = decimalAdd(decimalAdd(item.pureIncome, item.reimbursementIncome), item.refundIncome);
  item.spend = decimalAdd(decimalAdd(decimalAdd(item.pureSpend, item.reimbursementSpend), item.fee), item.refundSpend);
  return item;
}

function moneyForStat(raw: Record<string, unknown>, currency: string): number {
  const conversion = publicCurrencyConversion(raw);
  if (!conversion) return Number(raw.money ?? 0);
  const extra = billExtra(raw);
  const adjustment = Number(extra.transfee ?? 0);
  if (conversion.sourceCurrency === currency) {
    return decimalSubtract(Number(conversion.sourceAmount), Math.abs(adjustment));
  }
  if (conversion.targetCurrency === currency) return Number(conversion.targetAmount);
  if (conversion.baseCurrency === currency) return Number(conversion.baseAmount);
  return Number(raw.money ?? 0);
}

function transFeeForStat(raw: Record<string, unknown>, currency: string): number {
  const fee = Number(billExtra(raw).transfee ?? 0);
  if (!Number.isFinite(fee)) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单手续费或优惠金额无效", 502);
  const conversion = publicCurrencyConversion(raw);
  if (
    !conversion || conversion.sourceCurrency === currency ||
    conversion.baseAmount === undefined ||
    Number(conversion.sourceAmount) <= 0 || Number(conversion.baseAmount) <= 0
  ) return fee;
  return decimalMultiply(decimalDivide(Number(conversion.baseAmount), Number(conversion.sourceAmount), 10), fee);
}

function relatedTotal(
  relationships: Map<string, number>,
  rawById: Map<string, Record<string, unknown>>,
  currency: string,
): number {
  let total = 0;
  for (const id of relationships.keys()) {
    const related = rawById.get(id);
    if (!related) {
      throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单关联的退款或报销子账单缺失", 502);
    }
    total = decimalAdd(total, moneyForStat(related, currency));
  }
  return total;
}

function matchesTags(raw: Record<string, unknown>, selected?: string[], match: "any" | "all" = "any"): boolean {
  if (!selected) return true;
  const tags = tagIdsFrom(raw);
  return match === "all" ? selected.every((tag) => tags.includes(tag)) : selected.some((tag) => tags.includes(tag));
}

function addItem(total: StatItem, item: StatItem): void {
  for (const key of Object.keys(total) as Array<keyof StatItem>) {
    total[key] = key === "excludedIncomeExpense" || key === "excludedBudget"
      ? total[key] + item[key]
      : decimalAdd(total[key], item[key]);
  }
}

function normalizeSummary(item: StatItem): Record<string, number> {
  return {
    totalIncome: item.income,
    totalSpend: item.spend,
    balance: decimalSubtract(item.income, item.spend),
    pureIncome: item.pureIncome,
    pureSpend: item.pureSpend,
    transferAmount: item.transfer,
    creditRepaymentAmount: item.creditRepayment,
    reimbursementAmount: item.reimbursement,
    reimbursementIncome: item.reimbursementIncome,
    reimbursementSpend: item.reimbursementSpend,
    refundAmount: item.refund,
    refundIncome: item.refundIncome,
    refundSpend: item.refundSpend,
    feeAmount: item.fee,
    discountAmount: item.discount,
    excludedFromIncomeExpenseAmount: item.excludedIncomeExpense,
    excludedFromBudgetAmount: item.excludedBudget,
  };
}

function buildCategoryIndex(categories: Record<string, unknown>[]): Map<string, { name: string; parentId?: string }> {
  const index = new Map<string, { name: string; parentId?: string }>();
  for (const category of categories) {
    const id = String(category.id ?? category.cateid);
    index.set(id, { name: String(category.name ?? "") });
    for (const child of categoryChildren(category)) {
      index.set(String(child.id ?? child.cateid), { name: String(child.name ?? ""), parentId: id });
    }
  }
  return index;
}

function addCategory(
  output: Map<string, CategoryValue>,
  index: Map<string, { name: string; parentId?: string }>,
  row: BillRow,
  value: number,
  specialName?: string,
): void {
  if (specialName) {
    const key = `type:${row.type}`;
    const current = output.get(key) ?? { billType: row.type, name: specialName, amount: 0, directAmount: 0, children: new Map() };
    current.amount = decimalAdd(current.amount, value);
    current.directAmount = decimalAdd(current.directAmount, value);
    output.set(key, current);
    return;
  }
  const categoryId = row.cateid;
  if (!categoryId) return;
  const category = index.get(categoryId);
  if (!category) return;
  if (!category.parentId) {
    const current = output.get(categoryId) ?? { categoryId, name: category.name, amount: 0, directAmount: 0, children: new Map() };
    current.amount = decimalAdd(current.amount, value);
    current.directAmount = decimalAdd(current.directAmount, value);
    output.set(categoryId, current);
    return;
  }
  const parent = index.get(category.parentId);
  const current = output.get(category.parentId) ?? {
    categoryId: category.parentId,
    name: parent?.name ?? category.parentId,
    amount: 0,
    directAmount: 0,
    children: new Map(),
  };
  const child = current.children.get(categoryId) ?? { categoryId, name: category.name, amount: 0, directAmount: 0, children: new Map() };
  child.amount = decimalAdd(child.amount, value);
  child.directAmount = decimalAdd(child.directAmount, value);
  current.amount = decimalAdd(current.amount, value);
  current.children.set(categoryId, child);
  output.set(category.parentId, current);
}

function publicCategories(values: Map<string, CategoryValue>, total: number): Record<string, unknown>[] {
  const convert = (value: CategoryValue): Record<string, unknown> => ({
    ...(value.categoryId ? { categoryId: value.categoryId } : {}),
    ...(value.billType !== undefined ? { billType: value.billType } : {}),
    name: value.name,
    amount: value.amount,
    directAmount: value.directAmount,
    percentage: total === 0 ? 0 : amount(value.amount / total),
    children: [...value.children.values()].sort((a, b) => b.amount - a.amount).map(convert),
  });
  return [...values.values()].sort((a, b) => b.amount - a.amount).map(convert);
}

function periodKey(epochSeconds: number, unit: StatisticsUnit): string {
  const date = new Date(epochSeconds * 1000 + 8 * 60 * 60 * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return unit === "year" ? String(year) : unit === "month" ? `${year}-${month}` : `${year}-${month}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function averagePeriodCount(options: StatisticsOptions, periods: Map<string, unknown>): number {
  if (options.unit !== "day") return periods.size;
  const todayStart = Math.floor((options.nowMs + 8 * 60 * 60 * 1000) / 86_400_000) * 86_400 - 28_800;
  const effectiveEnd = Math.min(options.endTime + 1, todayStart);
  return Math.max(0, Math.floor((effectiveEnd - options.startTime) / 86_400));
}

function amount(value: number): number {
  return decimalRound(value, 10);
}
