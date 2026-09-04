import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  hasReimbursement,
  inputBillMoney,
  inspectWriteResult,
  MAX_MONEY,
  refundPatchApplied,
  refundRelationshipMap,
  resolveBillFlag,
  storedBillMoney,
} from "../src/bill-rules.ts";
import { calculateBillStatistics } from "../src/bill-statistics.ts";
import { normalizeBillForStorage, Store, type BillRow, type QianjiAccount } from "../src/data-store.ts";
import { AppError } from "../src/errors.ts";
import { md5, parseQianjiJson, QianjiClient, type QianjiFetch } from "../src/qianji-client.ts";
import { publicAssetGroups, publicBill, publicCurrencyConversion, publicDebtAccount } from "../src/qianji-mappers.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";

async function createOneBill(
  service: MoneyTrackService,
  accountId: number,
  input: Parameters<MoneyTrackService["createBills"]>[1][number],
): Promise<Record<string, unknown>> {
  return (await service.createBills(accountId, [input])).bills[0]!;
}

async function updateOneBill(
  service: MoneyTrackService,
  accountId: number,
  billId: string,
  patch: Parameters<MoneyTrackService["updateBills"]>[1][number]["patch"],
): Promise<Record<string, unknown>> {
  return (await service.updateBills(accountId, [{ billId, patch }])).bills[0]!;
}

function deleteOneBill(service: MoneyTrackService, accountId: number, billId: string, cascadeRelatedBills = false) {
  return service.deleteBills(accountId, [{ billId, cascadeRelatedBills }]);
}

function bill(id: string, remark: string, time = 1_770_000_000): Record<string, unknown> {
  return {
    id,
    userid: "uid-1",
    bookid: 1,
    time,
    type: 0,
    money: 10,
    remark,
    status: 2,
    cateid: 2,
    assetid: -1,
    fromid: -1,
    targetid: -1,
    createtime: time,
    updatetime: time,
    platform: 0,
    images: [],
  };
}

function billRow(raw: Record<string, unknown>): BillRow {
  return {
    id: String(raw.id),
    bookid: String(raw.bookid),
    time: Number(raw.time),
    type: Number(raw.type),
    money: Number(raw.money),
    cateid: String(raw.cateid) === "-1" ? null : String(raw.cateid),
    assetid: String(raw.assetid ?? "-1"),
    remark: String(raw.remark ?? ""),
    rawJson: JSON.stringify(raw),
  };
}

test("账单统计开关按 APP 语义转换并保留未修改维度", () => {
  assert.deepEqual([
    resolveBillFlag(0, {}),
    resolveBillFlag(0, { excludeFromIncomeExpense: true }),
    resolveBillFlag(0, { excludeFromBudget: true }),
    resolveBillFlag(0, { excludeFromIncomeExpense: true, excludeFromBudget: true }),
  ], [0, 1, 2, 3]);
  assert.equal(resolveBillFlag(2, { excludeFromIncomeExpense: true }), 3);
  assert.equal(resolveBillFlag(3, { excludeFromBudget: false }), 1);
});

test("金额边界按 APP 主输入与钱迹原始金额双向换算", () => {
  assert.equal(storedBillMoney(100, -1), 99);
  assert.equal(storedBillMoney(1001, 1), 1000);
  assert.equal(inputBillMoney(99, -1), 100);
  assert.equal(inputBillMoney(1000, 1), 1001);
  assert.throws(
    () => inputBillMoney(Number.NaN, 0),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.throws(
    () => normalizeBillForStorage({ ...bill("1770000000000000088", "非法金额"), money: "NaN" }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.throws(
    () => normalizeBillForStorage({ ...bill("1770000000000000089", "非法优惠"), extra: { transfee: "NaN" } }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.throws(
    () => normalizeBillForStorage({ ...bill("9223372036854775808", "超出 long 的 ID") }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.throws(
    () => normalizeBillForStorage({
      ...bill("1770000000000000090", "非法换算"),
      extra: { curr: { ss: "USD", sv: 1, bs: "CNY", bv: "" } },
    }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.throws(
    () => normalizeBillForStorage({
      ...bill("1770000000000000096", "非法关系金额"),
      extra: { rfds: { "1770000000000000097": null } },
    }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("资产和债务映射只补公开查询所需字段", () => {
  const now = Date.UTC(2026, 7, 27, 4);
  const groups = publicAssetGroups([{
    id: "3",
    name: "信用卡",
    currency: "CNY",
    type: 2,
    stype: 21,
    status: 0,
    money: -100,
    credit: { statedate: 5, paydate2: "20", limit: 20_000 },
  }, {
    id: "4",
    name: "账单日后还款信用卡",
    currency: "",
    type: 2,
    stype: 21,
    status: 0,
    money: -50,
    credit: { statedate: 5, paydate2: "10d", limit: 10_000 },
  }], false, "CNY", now);
  const credit = groups[0]?.children as Record<string, unknown>[];
  assert.equal(credit[0]?.money, undefined);
  assert.equal(credit[1]?.currency, "CNY");
  assert.deepEqual(credit[0]?.credit, {
    statementDay: 5,
    repaymentRule: { type: "dayOfMonth", value: 20 },
    nextRepaymentDate: Math.floor(Date.UTC(2026, 8, 20, -8) / 1000),
  });
  assert.deepEqual(credit[1]?.credit, {
    statementDay: 5,
    repaymentRule: { type: "daysAfterStatement", value: 10 },
    nextRepaymentDate: Math.floor(Date.UTC(2026, 8, 15, -8) / 1000),
  });
  const withBalance = (publicAssetGroups([{
    id: "3", name: "信用卡", currency: "CNY", type: 2, money: -100,
    credit: { statedate: 5, paydate2: "20", limit: 20_000 },
  }], true, "CNY", now)[0]?.children as Record<string, unknown>[])[0];
  assert.equal(withBalance?.money, -100);
  assert.equal((withBalance?.credit as Record<string, unknown>)?.limit, 20_000);
  const customCurrency = (publicAssetGroups([
    { id: "5", name: "自定义币种资产", currency: "usdt" },
  ], false, "CNY", now)[0]?.children as Record<string, unknown>[])[0];
  assert.equal(customCurrency?.currency, "usdt");
  assert.throws(
    () => publicAssetGroups([{ id: "6", name: "缺少币种资产", currency: "" }], false, "", now),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.deepEqual(publicDebtAccount({
    id: "4",
    name: "借入",
    stype: 51,
    status: 1,
    money: -30,
    loan: { money: -100, totalpay: -70, enddate: "2026-12-31" },
    extra: { ftime: 1_770_000_000 },
  }, "CNY"), {
    id: "4",
    name: "借入",
    direction: "borrowed",
    status: "ended",
    currency: "CNY",
    principal: 100,
    balance: 30,
    startDate: "",
    endDate: "2026-12-31",
    finishedAt: 1_770_000_000,
    totalPaid: 70,
  });
  assert.equal("finishedAt" in publicDebtAccount({
    id: "4", name: "借入", stype: 51, status: 0, money: 30, loan: { money: 100, totalpay: 70 }, extra: { ftime: 1_770_000_000 },
  }, "CNY"), false);
  assert.throws(
    () => publicDebtAccount({ id: "4", name: "缺失详情", stype: 51, status: 0, money: 0 }, "CNY"),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("历史跨币种只读取保存值并拒绝无效响应", () => {
  const raw = {
    ...bill("1770000000000000091", "美元账单"),
    extra: { curr: { ss: "usdt", sv: 10, ts: "CNY", tv: 70, bs: "CNY", bv: 70 } },
  };
  assert.deepEqual(publicCurrencyConversion(raw), {
    sourceCurrency: "usdt",
    sourceAmount: 10,
    targetCurrency: "CNY",
    targetAmount: 70,
    baseCurrency: "CNY",
    baseAmount: 70,
  });
  assert.deepEqual(publicCurrencyConversion({
    ...raw,
    extra: { curr: { ss: "CNY", sv: 10, ts: "USD", tv: 1.43, bv: 0 } },
  }), {
    sourceCurrency: "CNY",
    sourceAmount: 10,
    targetCurrency: "USD",
    targetAmount: 1.43,
  });
  assert.equal(publicBill({ ...raw, type: 1, money: 70 }).money, 10);
  assert.equal(publicBill({ ...raw, type: 0, money: 56, extra: { ...raw.extra, transfee: -2 } }).money, 10);
  const related = publicBill({
    ...raw,
    type: 5,
    money: 70,
    extra: {
      ...raw.extra,
      rfds: { "1770000000000000092": 3 },
      bxs: { "1770000000000000093": 4 },
    },
  });
  assert.deepEqual(related.refundProgress, { totalAmount: 3, remainingAmount: 7 });
  assert.deepEqual(related.reimbursementProgress, { totalAmount: 4, remainingAmount: 3 });
  assert.throws(
    () => publicBill({ ...raw, extra: { curr: { ss: "usd", sv: -1, bs: "CNY", bv: 7 } } }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
  assert.throws(
    () => publicBill({ ...raw, extra: { curr: { ss: "USD", sv: 1, bv: "invalid" } } }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("主报表分类不混入手续费，并统计零剩余待报销账单", () => {
  const interest = billRow({ ...bill("1770000000000000092", "利息"), type: 10, money: 10, extra: { transfee: 2 } });
  const reimbursable = billRow({ ...bill("1770000000000000093", "待报销"), type: 5, money: 0, extra: { flag: 1 } });
  const refundId = "1770000000000000095";
  const excluded = billRow({
    ...bill("1770000000000000094", "不计收支"),
    money: 10,
    extra: { flag: 1, rfds: { [refundId]: 12 } },
  });
  const refund = billRow({ ...bill(refundId, "超额退款"), type: 20, money: 12, extra: { refundsid: excluded.id } });
  const statistics = calculateBillStatistics({
    rows: [interest, reimbursable, excluded],
    allRows: [interest, reimbursable, excluded, refund],
    categories: [],
    startTime: 1_770_000_000,
    endTime: 1_770_000_000,
    unit: "day",
    baseCurrency: "CNY",
    nowMs: 1_770_000_000_000,
  }) as {
    summary: Record<string, number>;
    counts: Record<string, number>;
    categoryBreakdown: { spend: Array<Record<string, unknown>> };
  };
  assert.equal(statistics.summary.totalSpend, 12);
  assert.equal(statistics.summary.totalIncome, 0);
  assert.equal(statistics.summary.refundIncome, 0);
  assert.equal(statistics.summary.feeAmount, 2);
  assert.equal(statistics.categoryBreakdown.spend[0]?.amount, 10);
  assert.equal(statistics.counts.reimbursementBillCount, 1);
  assert.equal(statistics.summary.excludedFromIncomeExpenseAmount, 0);
});

test("APK 金额矩阵保持优惠、跨币种手续费、部分与超额退款报销语义", () => {
  const statistics = (rows: BillRow[], allRows = rows) => calculateBillStatistics({
    rows,
    allRows,
    categories: [],
    startTime: 1_770_000_000,
    endTime: 1_770_000_000,
    unit: "day",
    baseCurrency: "CNY",
    nowMs: 1_770_000_000_000,
  }) as { summary: Record<string, number>; counts: Record<string, number> };

  const discounted = { ...bill("1770000000000000101", "优惠支出"), money: 90, extra: { transfee: -10 } };
  assert.deepEqual(
    (({ money, discount, fee }) => ({ money, discount, fee }))(publicBill(discounted)),
    { money: 100, discount: 10, fee: undefined },
  );
  assert.deepEqual(
    (({ totalSpend, discountAmount }) => ({ totalSpend, discountAmount }))(statistics([billRow(discounted)]).summary),
    { totalSpend: 90, discountAmount: 10 },
  );

  const crossCurrencyDiscountRaw = {
    ...bill("1770000000000000124", "跨币种普通优惠"),
    money: 56,
    extra: { transfee: -2, curr: { ss: "USD", sv: 10, ts: "CNY", tv: 56, bs: "CNY", bv: 56 } },
  };
  const crossCurrencyDiscount = billRow(crossCurrencyDiscountRaw);
  const crossCurrencyDiscountSummary = statistics([crossCurrencyDiscount]).summary;
  assert.equal(publicBill(crossCurrencyDiscountRaw).money, 10);
  assert.equal(crossCurrencyDiscountSummary.pureSpend, 56);
  assert.equal(crossCurrencyDiscountSummary.discountAmount, 11.2);

  const transfer = billRow({
    ...bill("1770000000000000102", "跨币种手续费"),
    type: 2,
    money: 90,
    extra: { transfee: 10, curr: { ss: "USD", sv: 100, ts: "CNY", tv: 630, bs: "CNY", bv: 630 } },
  });
  const transferSummary = statistics([transfer]).summary;
  assert.equal(transferSummary.transferAmount, 630);
  assert.equal(transferSummary.feeAmount, 63);
  assert.equal(transferSummary.totalSpend, 63);

  const transferDiscount = billRow({
    ...bill("1770000000000000121", "跨币种转账优惠"),
    type: 2,
    money: 90,
    extra: { transfee: -10, curr: { ss: "USD", sv: 100, ts: "CNY", tv: 700, bs: "CNY", bv: 700 } },
  });
  const transferDiscountSummary = statistics([transferDiscount]).summary;
  assert.equal(transferDiscountSummary.transferAmount, 700);
  assert.equal(transferDiscountSummary.discountAmount, 70);
  assert.equal(transferDiscountSummary.totalSpend, 0);

  const sameCurrencyTransferDiscount = billRow({
    ...bill("1770000000000000125", "同币种转账优惠"),
    type: 2,
    money: 9,
    extra: { transfee: -3 },
  });
  const sameCurrencyTransferDiscountSummary = statistics([sameCurrencyTransferDiscount]).summary;
  assert.equal(sameCurrencyTransferDiscountSummary.transferAmount, 9);
  assert.equal(sameCurrencyTransferDiscountSummary.discountAmount, 3);

  const repeatingFee = billRow({
    ...bill("1770000000000000120", "循环汇率手续费"),
    type: 2,
    money: 2,
    extra: { transfee: 1, curr: { ss: "USD", sv: 3, ts: "CNY", tv: 1, bs: "CNY", bv: 1 } },
  });
  assert.equal(statistics([repeatingFee]).summary.feeAmount, 0.3333333333);

  const partialRefundId = "1770000000000000114";
  const partialRefundSource = billRow({
    ...bill("1770000000000000115", "部分退款源账单"),
    money: 100,
    extra: { rfds: { [partialRefundId]: 40 } },
  });
  const partialRefund = billRow({
    ...bill(partialRefundId, "部分退款"),
    type: 20,
    money: 40,
    extra: { refundsid: partialRefundSource.id },
  });
  const partialRefundSummary = statistics([partialRefundSource], [partialRefundSource, partialRefund]).summary;
  assert.equal(partialRefundSummary.pureSpend, 60);
  assert.equal(partialRefundSummary.refundIncome, 0);

  const refundA = "1770000000000000104";
  const refundB = "1770000000000000105";
  const refundSource = billRow({
    ...bill("1770000000000000103", "超额退款"),
    money: 100,
    extra: { rfds: { [refundA]: 40, [refundB]: 70 } },
  });
  const refundRows = [
    billRow({ ...bill(refundA, "部分退款"), type: 20, money: 40, extra: { refundsid: refundSource.id } }),
    billRow({ ...bill(refundB, "超额部分"), type: 20, money: 70, extra: { refundsid: refundSource.id } }),
  ];
  const refundSummary = statistics([refundSource], [refundSource, ...refundRows]).summary;
  assert.equal(refundSummary.pureSpend, 0);
  assert.equal(refundSummary.refundIncome, 10);
  assert.equal(refundSummary.totalIncome, 10);

  const reimbursementRefundId = "1770000000000000108";
  const reimbursementA = "1770000000000000107";
  const reimbursementSource = billRow({
    ...bill("1770000000000000106", "退款后部分报销"),
    type: 5,
    money: 100,
    extra: { rfds: { [reimbursementRefundId]: 20 }, bxs: { [reimbursementA]: 50 } },
  });
  const reimbursementRefund = billRow({
    ...bill(reimbursementRefundId, "待报销账单退款"),
    type: 20,
    money: 20,
    extra: { refundsid: reimbursementSource.id },
  });
  const reimbursement = billRow({
    ...bill(reimbursementA, "报销入账"),
    type: 21,
    money: 50,
    extra: { bxsid: reimbursementSource.id },
  });
  const reimbursementSummary = statistics(
    [reimbursementSource],
    [reimbursementSource, reimbursementRefund, reimbursement],
  ).summary;
  assert.equal(reimbursementSummary.reimbursementAmount, 80);
  assert.equal(reimbursementSummary.reimbursementSpend, 30);
  assert.equal(reimbursementSummary.totalSpend, 30);

  const overReimbursementId = "1770000000000000118";
  const overReimbursementSource = billRow({
    ...bill("1770000000000000119", "超额报销"),
    type: 5,
    money: 100,
    extra: { bxs: { [overReimbursementId]: 110 } },
  });
  const overReimbursement = billRow({
    ...bill(overReimbursementId, "超额报销入账"),
    type: 21,
    money: 110,
    extra: { bxsid: overReimbursementSource.id },
  });
  const overReimbursementSummary = statistics(
    [overReimbursementSource],
    [overReimbursementSource, overReimbursement],
  ).summary;
  assert.equal(overReimbursementSummary.reimbursementIncome, 10);
  assert.equal(overReimbursementSummary.totalIncome, 10);

  const average = calculateBillStatistics({
    rows: [billRow({ ...bill("1770000000000000125", "平均值"), type: 1, money: 1, time: 1 })],
    allRows: [billRow({ ...bill("1770000000000000125", "平均值"), type: 1, money: 1, time: 1 })],
    categories: [],
    startTime: 0,
    endTime: 3 * 86_400 - 1,
    unit: "day",
    baseCurrency: "CNY",
    nowMs: 10 * 86_400_000,
  }) as { average: Record<string, number> };
  assert.equal(average.average.income, 1 / 3);

  const excludedA = billRow({ ...bill("1770000000000000126", "不计一"), money: 0.1, extra: { flag: 1 } });
  const excludedB = billRow({ ...bill("1770000000000000127", "不计二"), money: 0.2, extra: { flag: 1 } });
  assert.equal(statistics([excludedA, excludedB]).summary.excludedFromIncomeExpenseAmount, 0.1 + 0.2);
});

test("退款与报销统计使用子账单币种快照，缺失时不猜测关系金额", () => {
  const refundA = "1770000000000000111";
  const refundB = "1770000000000000112";
  const source = billRow({
    ...bill("1770000000000000110", "精确全额退款"),
    money: 0.3,
    extra: { rfds: { [refundA]: 0.1, [refundB]: 0.2 } },
  });
  const children = [
    billRow({ ...bill(refundA, "退款一"), type: 20, money: 0.1, extra: { refundsid: source.id } }),
    billRow({ ...bill(refundB, "退款二"), type: 20, money: 0.2, extra: { refundsid: source.id } }),
  ];
  const complete = calculateBillStatistics({
    rows: [source],
    allRows: [source, ...children],
    categories: [],
    startTime: 1_770_000_000,
    endTime: 1_770_000_000,
    unit: "day",
    baseCurrency: "CNY",
    nowMs: 1_770_000_000_000,
  }) as { summary: Record<string, number>; counts: Record<string, number> };
  assert.equal(complete.summary.totalSpend, 0);
  assert.equal(complete.summary.refundIncome, 0);
  assert.equal(complete.counts.incomeItemCount, 0);

  const reimbursementId = "1770000000000000123";
  const reimbursementSource = billRow({
    ...bill("1770000000000000122", "十二位报销尾差"),
    type: 5,
    money: 0.03,
    extra: {
      curr: { ss: "USD", sv: 0.03, bs: "CNY", bv: 0.01 },
      bxs: { [reimbursementId]: 0.01 },
    },
  });
  const reimbursement = billRow({
    ...bill(reimbursementId, "十二位报销入账"),
    type: 21,
    money: 0.01,
    extra: {
      bxsid: reimbursementSource.id,
      curr: { ss: "USD", sv: 0.01, bs: "CNY", bv: 0.003333333333 },
    },
  });
  const precise = calculateBillStatistics({
    rows: [reimbursementSource],
    allRows: [reimbursementSource, reimbursement],
    categories: [],
    startTime: 1_770_000_000,
    endTime: 1_770_000_000,
    unit: "day",
    baseCurrency: "CNY",
    nowMs: 1_770_000_000_000,
  }) as { summary: Record<string, number> };
  assert.equal(precise.summary.reimbursementSpend, 0.006666666667);
  assert.equal(precise.summary.totalSpend, 0.006666666667);

  assert.throws(
    () => calculateBillStatistics({
      rows: [source],
      allRows: [source, children[0]!],
      categories: [],
      startTime: 1_770_000_000,
      endTime: 1_770_000_000,
      unit: "day",
      baseCurrency: "CNY",
      nowMs: 1_770_000_000_000,
    }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("账单的 64 位记账人 ID 保持精确文本", () => {
  const ownerId = "1770000000000999999";
  const parsed = parseQianjiJson(`{"userid":${ownerId}}`) as Record<string, unknown>;
  const output = publicBill({ ...bill("1770000000000000113", "大整数记账人"), userid: parsed.userid });
  assert.equal((output.createdBy as Record<string, unknown>).userId, ownerId);
  assert.throws(
    () => publicBill({ ...bill("1770000000000000116", "已丢失精度的记账人"), userid: Number(ownerId) }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("同步结果不能同时声称全部成功和整体失败", () => {
  const id = "1770000000000000117";
  const result = inspectWriteResult({
    new_ids: [id],
    update_ids: [],
    del_ids: [],
    conf_ids: [],
    has_failed: true,
  }, [id]);
  assert.equal(result.appliedIds[0], id);
  assert.equal(result.error?.code, "QIANJI_RESPONSE_INVALID");
});

test("账单统计的 month 始终使用 UTC+08:00 自然月", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 2, 2, 4);
  const time = Math.floor(Date.UTC(2026, 1, 10, 4) / 1000);
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0, __baseCurrency: "CNY" }, now);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "账本", visible: 1, config: { range: "m15" } }], now);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "2", name: "支出", type: 0 }], now);
  store.applySyncBatch(account.id, {
    changes: [bill("1770000000000000096", "二月账单", time)],
    deletes: [],
    invalidatedCategoryScopes: [],
    lasttimes: [],
  });
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async () => { throw new Error("unexpected request"); } }), () => now);

  const statistics = await service.getBillStatistics(accountId, {
    bookId: "1",
    range: { kind: "month", year: 2026, month: 2 },
  }) as { range: { startTime: number; endTime: number; timezoneOffsetSeconds: number }; average: { unit: string; periodCount: number } };
  assert.deepEqual(statistics.range, {
    startTime: Math.floor(Date.UTC(2026, 1, 1, -8) / 1000),
    endTime: Math.floor(Date.UTC(2026, 2, 1, -8) / 1000) - 1,
    timezoneOffsetSeconds: 28_800,
  });
  assert.equal(statistics.average.unit, "day");
  assert.equal(statistics.average.periodCount, 28);
});

test("预算查询按自定义月和 APK 金额规则聚合总预算、分类预算及日统计", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0, __baseCurrency: "CNY" }, now);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "账本", visible: 1, config: { range: "m15" } }], now);
  store.setCatalogCache(account.id, "categories", "1", [{
    id: "2",
    name: "生活",
    parentid: "-1",
    sublist: [
      { id: "3", name: "餐饮", parentid: "2" },
      { id: "4", name: "购物", parentid: "2" },
    ],
  }], now);
  store.setSyncState(account.id, { cursor: 1 });
  const at = (day: number) => Math.floor(Date.UTC(2026, 6, day, -8) / 1000);
  const reimbursementId = "1770000000000000201";
  const refundId = "1770000000000000202";
  for (const raw of [
    { ...bill("1770000000000000195", "优惠支出", at(16)), cateid: 3, money: 90, extra: { transfee: -10 } },
    { ...bill("1770000000000000196", "不计预算", at(17)), cateid: 4, money: 20, extra: { flag: 2 } },
    { ...bill("1770000000000000197", "转账手续费", at(18)), type: 2, cateid: -1, money: 90, extra: { transfee: 10 } },
    { ...bill("1770000000000000198", "部分报销", at(19)), type: 5, cateid: 3, money: 100, extra: { bxs: { [reimbursementId]: 60 } } },
    { ...bill(reimbursementId, "报销入账", at(19)), type: 21, cateid: -1, money: 60 },
    { ...bill("1770000000000000199", "部分退款", at(20)), cateid: 3, money: 100, extra: { rfds: { [refundId]: 30 } } },
    { ...bill(refundId, "退款", at(20)), type: 20, cateid: -1, money: 30 },
  ]) store.upsertBill(account.id, raw);

  let fullLimit: number | undefined = 500;
  const forms: URLSearchParams[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/budget/list");
      forms.push(new URLSearchParams(String(init?.body)));
      const list = fullLimit === undefined ? [] : [
        { bookid: 1, flag: 1, cateid: -1, money: fullLimit },
        { bookid: 1, flag: 2, cateid: 2, money: 200 },
        { bookid: 1, flag: 2, cateid: 3, money: 150 },
        { bookid: 1, flag: 2, cateid: 4, money: 100 },
      ];
      return ok({ list });
    },
  }), () => now);

  const allExpenses = await service.getBudget(accountId, { bookId: "1", includeDailyStatistics: true }) as {
    period: Record<string, unknown>;
    configured: boolean;
    summary: Record<string, unknown>;
    categories: Array<Record<string, unknown>>;
    dailyStatistics: Array<Record<string, unknown>>;
  };
  assert.deepEqual(allExpenses.period, {
    kind: "month",
    year: 2026,
    month: 7,
    startTime: Math.floor(Date.UTC(2026, 6, 15, -8) / 1000),
    endTime: Math.floor(Date.UTC(2026, 7, 15, -8) / 1000) - 1,
    timezoneOffsetSeconds: 28_800,
  });
  assert.deepEqual(allExpenses.summary, {
    spendingScope: "allExpenses",
    limit: 500,
    used: 210,
    remaining: 290,
    excludedFromBudgetAmount: 20,
    dailyAverageBudget: 500 / 31,
    remainingDailyAverage: 58,
  });
  assert.deepEqual(allExpenses.categories, [{
    categoryId: "2",
    name: "生活",
    limit: 250,
    used: 200,
    remaining: 50,
    billCount: 4,
    children: [
      { categoryId: "3", name: "餐饮", limit: 150, used: 200, remaining: -50, billCount: 3, children: [] },
      { categoryId: "4", name: "购物", limit: 100, used: 0, remaining: 100, billCount: 1, children: [] },
    ],
  }]);
  assert.equal(allExpenses.dailyStatistics.length, 31);
  assert.deepEqual(allExpenses.dailyStatistics.slice(1, 6), [
    { date: "2026-07-16", spend: 90, cumulativeSpend: 90, remaining: 410 },
    { date: "2026-07-17", spend: 0, cumulativeSpend: 90, remaining: 410 },
    { date: "2026-07-18", spend: 10, cumulativeSpend: 100, remaining: 400 },
    { date: "2026-07-19", spend: 40, cumulativeSpend: 140, remaining: 360 },
    { date: "2026-07-20", spend: 70, cumulativeSpend: 210, remaining: 290 },
  ]);
  assert.equal(forms[0]?.get("flts"), '{"month":"2026,7"}');
  assert.equal(forms[0]?.get("range"), "m15");

  fullLimit = 200;
  const categoryOnly = await service.getBudget(accountId, {
    bookId: "1",
    period: { kind: "month", year: 2026, month: 7 },
  }) as { summary: Record<string, unknown>; dailyStatistics?: unknown };
  assert.deepEqual(categoryOnly.summary, {
    spendingScope: "budgetedCategories",
    limit: 250,
    used: 200,
    remaining: 50,
    excludedFromBudgetAmount: 20,
    dailyAverageBudget: 250 / 31,
    remainingDailyAverage: 10,
  });
  assert.equal(categoryOnly.dailyStatistics, undefined);

  fullLimit = undefined;
  const unconfigured = await service.getBudget(accountId, { bookId: "1", period: { kind: "year", year: 2026 } });
  assert.deepEqual(unconfigured, {
    period: {
      kind: "year",
      year: 2026,
      startTime: Math.floor(Date.UTC(2026, 0, 1, -8) / 1000),
      endTime: Math.floor(Date.UTC(2027, 0, 1, -8) / 1000) - 1,
      timezoneOffsetSeconds: 28_800,
    },
    currency: "CNY",
    configured: false,
    summary: null,
    categories: [],
  });
});

test("预算查询省略 bookId 时仍使用默认账本的自定义月配置", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  store.setUserCache(account.id, { id: account.uid, viptype: -1, __baseCurrency: "CNY" }, now);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "-1", name: "默认账本", config: { range: "m15" } }], now);
  store.setCatalogCache(account.id, "categories", "-1", [{ id: "2", name: "餐饮", parentid: "-1" }], now);
  store.setSyncState(account.id, { cursor: 1 });
  let form: URLSearchParams | undefined;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/budget/list");
      form = new URLSearchParams(String(init?.body));
      return ok({ list: [] });
    },
  }), () => now);

  const result = await service.getBudget(accountId, {}) as { period: Record<string, unknown> };

  assert.deepEqual(result.period, {
    kind: "month",
    year: 2026,
    month: 7,
    startTime: Math.floor(Date.UTC(2026, 6, 15, -8) / 1000),
    endTime: Math.floor(Date.UTC(2026, 7, 15, -8) / 1000) - 1,
    timezoneOffsetSeconds: 28_800,
  });
  assert.equal(form?.get("bookid"), "-1");
  assert.equal(form?.get("flts"), '{"month":"2026,7"}');
  assert.equal(form?.get("range"), "m15");
});

test("旧版退款与报销关系只补足官方已提供的信息", () => {
  const refundId = "1770000000000999991";
  assert.deepEqual([...refundRelationshipMap({ extra: { refundid: refundId, refundv: 3 } })], [[refundId, 3]]);
  assert.equal(hasReimbursement({ type: 5, extra: { baoxiaoed: 1 } }), true);
  assert.deepEqual([...refundRelationshipMap({ extra: { rfds: { [refundId]: 4 }, refundid: "1770000000000999992", refundv: 2 } })], [[refundId, 4]]);
  assert.throws(
    () => refundRelationshipMap({ extra: { refundid: "invalid", refundv: 2 } }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("PAT 同账号重登门禁与共享解绑在事务中保留或级联本地数据", () => {
  const store = new Store(":memory:");
  const first = store.createPat("first", null);
  const account = store.bindPat(first.id, "uid-1", "token-1", "device-1", "user@example.com");
  assert.equal(store.getPatConnection(first.id)?.loginIdentifier, "user@example.com");
  assert.throws(
    () => store.bindPat(first.id, "uid-2", "token-2", "device-2", "other@example.com"),
    (error) => error instanceof AppError && error.code === "QIANJI_ACCOUNT_MISMATCH",
  );
  assert.equal(store.verifyPat(first.token)?.accountId, account.id);

  const second = store.createPat("second", null);
  store.bindPat(second.id, "uid-1", "token-2", "device-2");
  store.setCatalogCache(account.id, "tags", "", [{ id: "tag-1" }]);
  store.saveConfirmedBills(account.id, [bill("1770000000000999993", "保留")]);
  assert.deepEqual(store.unbindPat(first.id, account.id), { localDataDeleted: false });
  assert.equal(store.verifyPat(first.token)?.accountId, null);
  assert.equal(store.countBills(account.id), 1);
  assert.throws(() => store.unbindPat(first.id, account.id), (error) => error instanceof AppError && error.code === "QIANJI_ACCOUNT_NOT_BOUND");
  assert.deepEqual(store.unbindPat(second.id, account.id), { localDataDeleted: true });
  assert.equal(store.verifyPat(second.token)?.accountId, null);
  assert.throws(() => store.requireAccount(account.id), (error) => error instanceof AppError && error.code === "QIANJI_ACCOUNT_NOT_BOUND");
  store.close();
});

test("SQLite 旧账号表启动时幂等增加登录标识列", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qianji-migrate-"));
  const path = join(root, "legacy.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = new Database(path);
  legacy.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, utoken TEXT NOT NULL, devid TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  legacy.close();
  const store = new Store(path);
  const columns = (store.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.equal(columns.includes("login_identifier"), true);
  store.close();
  const reopened = new Store(path);
  assert.equal((reopened.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).filter(({ name }) => name === "login_identifier").length, 1);
  reopened.close();
});

function setup(): { store: Store; accountId: number; account: QianjiAccount } {
  const store = new Store(":memory:");
  const pat = store.createPat("test", null);
  const account = store.bindPat(pat.id, "uid-1", "token-1", "device-1");
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0, __baseCurrency: "CNY" });
  return { store, accountId: account.id, account };
}

function pullData(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    changes: [],
    deletes: [],
    categories: [],
    bookid: 1,
    pageoffset: 0,
    hasmore: 0,
    count: 0,
    pagesign: "",
    lasttimes: { cursor: 1 },
    ...overrides,
  };
}

test("登录先初始化账号并在后台同步账单，同步期间账单操作立即失败", async (t) => {
  const store = new Store(":memory:");
  const pat = store.createPat("登录初始化", null);
  let releasePull = (): void => {};
  let markPullStarted!: () => void;
  const pullStarted = new Promise<void>((resolve) => { markPullStarted = resolve; });
  const pendingPull = new Promise<Response>((resolve) => {
    releasePull = () => resolve(ok(pullData()));
  });
  const paths: string[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/account/login") return ok({ user: { id: "uid-login" }, token: "token-login" });
      if (path === "/client/init") return ok({
        userinfo: { id: "uid-login", name: "初始化用户", viptype: -1 },
        books: [{ bookid: -1, name: "默认账本" }],
      });
      if (path === "/syncv2/pull") {
        markPullStarted();
        return pendingPull;
      }
      throw new Error(`unexpected upstream path: ${path}`);
    },
  }));
  t.after(async () => {
    releasePull();
    await service.close();
    store.close();
  });

  await service.bindAccount(pat.id, "user@example.com", md5("password"));
  await pullStarted;
  const accountId = store.verifyPat(pat.token)!.accountId!;
  assert.equal(store.getUserCache(accountId)?.data.name, "初始化用户");
  assert.equal(store.getCatalogCache(accountId, "books")?.data[0]?.name, "默认账本");
  for (const operation of [
    () => service.listBills(accountId, { allBooks: true }),
    () => createOneBill(service, accountId, { type: 0, money: 1, categoryId: "2" }),
    () => service.refreshCache(accountId),
  ]) {
    await assert.rejects(operation, (error) =>
      error instanceof AppError && error.code === "QIANJI_DATA_SYNCING" && error.message === "钱迹账单正在同步，请稍后再试",
    );
  }

  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  releasePull();
  await closing;
  assert.deepEqual(paths, ["/account/login", "/client/init", "/syncv2/pull"]);
  assert.deepEqual(store.getSyncState(accountId), { cursor: 1 });
  assert.equal((await service.listBills(accountId, { allBooks: true })).bills.length, 0);
});

test("登录后的后台同步失败可见，并可通过刷新或重登恢复", async (t) => {
  const store = new Store(":memory:");
  const pat = store.createPat("同步恢复", null);
  let pullFailure: "http" | "token" | undefined = "http";
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") return ok({ user: { id: "uid-retry" }, token: "token-retry" });
      if (path === "/client/init") {
        return ok({ userinfo: { id: "uid-retry", viptype: -1 }, userconfigs: { basecur: "CNY", mcurrency: 1 }, books: [] });
      }
      if (path === "/syncv2/pull") {
        if (pullFailure === "http") return new Response("upstream failure", { status: 500 });
        if (pullFailure === "token") return new Response("token expired", { status: 401 });
        return ok(pullData());
      }
      if (path === "/book/list" || path === "/tag/list") return ok({ list: [] });
      if (path === "/asset/list") return ok({ groups: [], list: [] });
      if (path === "/currency/listv2") return ok({ list: [], hasmore: 0 });
      throw new Error(`unexpected upstream path: ${path}`);
    },
  }));
  t.after(async () => {
    await service.close();
    store.close();
  });

  await service.bindAccount(pat.id, "user@example.com", md5("password"));
  await service.close();
  const accountId = store.verifyPat(pat.token)!.accountId!;
  await assert.rejects(service.listBills(accountId, { allBooks: true }), (error) =>
    error instanceof AppError &&
    error.code === "QIANJI_INITIAL_SYNC_FAILED" &&
    error.message.includes("refresh_cache"),
  );

  pullFailure = undefined;
  const refreshed = await service.refreshCache(accountId);
  assert.equal(refreshed.billCount, 0);
  assert.deepEqual(store.getSyncState(accountId), { cursor: 1 });
  assert.equal((await service.listBills(accountId, { allBooks: true })).bills.length, 0);

  pullFailure = "token";
  await service.bindAccount(pat.id, undefined, md5("password"));
  await service.close();
  await assert.rejects(service.listBills(accountId, { allBooks: true }), (error) =>
    error instanceof AppError && error.code === "QIANJI_TOKEN_INVALID",
  );
  pullFailure = undefined;
  await service.bindAccount(pat.id, undefined, md5("password"));
  await service.close();
  assert.equal((await service.listBills(accountId, { allBooks: true })).bills.length, 0);
});

function cacheWriteContext(
  store: Store,
  account: QianjiAccount,
  user: Record<string, unknown>,
  tagIds: string[],
  refreshedAtMs: number,
): void {
  store.setUserCache(account.id, { __baseCurrency: "CNY", ...user }, refreshedAtMs);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "账本", visible: 1 }], refreshedAtMs);
  store.setCatalogCache(account.id, "assets", "", [{ id: "3", name: "资产", status: 0 }], refreshedAtMs);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "2", name: "分类", type: 0 }], refreshedAtMs);
  store.setCatalogCache(
    account.id,
    "tags",
    "",
    tagIds.map((id) => ({ id, name: id, status: 1, groupId: "", groupName: "" })),
    refreshedAtMs,
  );
}

test("用户信息按 4 小时缓存并实时计算 VIP 起止边界", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const vipStart = 1_770_000_000;
  const vipEnd = vipStart + 60 * 60;
  let now = vipStart * 1000;
  let initCalls = 0;
  store.setUserCache(account.id, {
    id: account.uid,
    name: "缓存用户",
    avatar: "https://example.invalid/avatar.png",
    platform: 0,
    time: vipStart - 100,
    viptype: 4,
    vipstart: vipStart,
    vipend: vipEnd,
    __baseCurrency: "CNY",
    email: "private@example.invalid",
    phone: "13800000000",
  }, now);
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/client/init");
      initCalls += 1;
      return ok({
        userinfo: {
          id: account.uid,
          name: "刷新用户",
          platform: 7,
          time: vipStart - 100,
          viptype: -1,
          vipstart: 0,
          vipend: 0,
          email: "still-private@example.invalid",
          phone: "13900000000",
        },
        userconfigs: { basecur: "CNY", mcurrency: 1 },
        books: [{ bookid: -1, name: "默认账本" }],
      });
    },
  }), () => now);

  const active = await service.getUserInfo(accountId);
  assert.equal(active.isVip, true);
  assert.equal(active.vipType, "年VIP");
  assert.equal("registrationMethod" in active, false);
  assert.equal("platform" in active, false);
  assert.equal("dailyWriteLimit" in active, false);
  assert.equal("dailyWriteUsed" in active, false);
  assert.equal("dailyWriteRemaining" in active, false);
  assert.equal("dailyWriteResetsAt" in active, false);
  assert.equal("email" in active, false);
  assert.equal("phone" in active, false);
  assert.equal(initCalls, 0);

  store.db.prepare("UPDATE accounts SET write_quota_date = ?, write_quota_used = 4 WHERE id = ?")
    .run("2099-01-01", account.id);
  now = vipEnd * 1000;
  const expired = await service.getUserInfo(accountId);
  assert.equal(expired.isVip, false);
  assert.equal(expired.vipType, "年VIP");
  assert.equal(expired.dailyWriteLimit, 15);
  assert.equal(expired.dailyWriteUsed, 0);
  assert.equal(expired.dailyWriteRemaining, 15);
  assert.equal(typeof expired.dailyWriteResetsAt, "number");
  assert.equal(initCalls, 0);

  now = (vipStart + 4 * 60 * 60) * 1000;
  const refreshed = await service.getUserInfo(accountId);
  assert.equal(refreshed.name, "刷新用户");
  assert.equal(refreshed.isVip, false);
  assert.equal(refreshed.registrationMethod, "微信");
  assert.equal(initCalls, 1);
  assert.equal(store.getCatalogCache(account.id, "books")?.data[0]?.bookid, "-1");

  store.setUserCache(account.id, {
    id: account.uid, viptype: -1, vipstart: -2, vipend: 0, __baseCurrency: "CNY",
  }, now);
  await assert.rejects(
    service.getUserInfo(accountId),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});

test("旧用户缓存缺少币种配置时只强制初始化一次", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0 }, now);
  let initCalls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/client/init");
      initCalls += 1;
      return ok({
        userinfo: { id: account.uid, name: "旧缓存用户", viptype: -1 },
        userconfigs: { basecur: "USD", mcurrency: 1 },
        books: [],
      });
    },
  }), () => now);

  assert.equal((await service.getUserInfo(accountId)).baseCurrency, "USD");
  assert.equal((await service.getUserInfo(accountId)).baseCurrency, "USD");
  assert.equal(initCalls, 1);
});

test("VIP 与非 VIP 在共享写边界使用不同标签上限，VIP 不更新额度", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const tagIds = Array.from({ length: 9 }, (_, index) => `tag-${index + 1}`);
  const upstream = createStatefulUpstream();
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  cacheWriteContext(store, account, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0 }, tagIds, now);
  await assert.rejects(
    createOneBill(service, accountId, {
      bookId: "1",
      type: 0,
      money: 1,
      categoryId: "2",
      tagIds: tagIds.slice(0, 2),
    }),
    (error) => error instanceof AppError && error.code === "TAG_LIMIT_EXCEEDED",
  );

  store.setUserCache(account.id, {
    id: account.uid,
    viptype: 4,
    vipstart: Math.floor(now / 1000) - 1,
    vipend: Math.floor(now / 1000) + 3600,
  }, now);
  store.db.prepare("UPDATE accounts SET write_quota_date = '2026-02-02', write_quota_used = 5 WHERE id = ?")
    .run(account.id);
  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 1,
    categoryId: "2",
    tagIds: tagIds.slice(0, 8),
  });
  assert.deepEqual(created.tagIds, tagIds.slice(0, 8));
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-02-02", used: 5 });
  await assert.rejects(
    createOneBill(service, accountId, {
      bookId: "1",
      type: 0,
      money: 1,
      categoryId: "2",
      tagIds,
    }),
    (error) => error instanceof AppError && error.code === "TAG_LIMIT_EXCEEDED",
  );
});

test("非 VIP 额度按 UID 共享，未来日期重置且并发第 15/16 次结果确定", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const secondPat = store.createPat("同 UID 第二枚 PAT", null);
  const sharedAccount = store.bindPat(secondPat.id, account.uid, "token-2", "device-2");
  assert.equal(sharedAccount.id, account.id);
  const now = Date.UTC(2026, 7, 12, 4);
  const today = "2026-08-12";
  const upstream = createStatefulUpstream();
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);
  cacheWriteContext(store, account, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0 }, ["tag-1"], now);

  store.db.prepare("UPDATE accounts SET write_quota_date = '2099-01-01', write_quota_used = 5 WHERE id = ?")
    .run(account.id);
  await createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" });
  assert.deepEqual(store.getWriteQuota(account.id), { date: today, used: 1 });

  store.db.prepare("UPDATE accounts SET write_quota_date = ?, write_quota_used = 14 WHERE id = ?")
    .run(today, account.id);
  const results = await Promise.allSettled([
    createOneBill(service, accountId, { bookId: "1", type: 0, money: 2, categoryId: "2" }),
    createOneBill(service, sharedAccount.id, { bookId: "1", type: 0, money: 3, categoryId: "2" }),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason instanceof AppError && rejected.reason.code, "DAILY_WRITE_LIMIT_REACHED");
  assert.deepEqual(store.getWriteQuota(account.id), { date: today, used: 15 });
});

test("上游失败释放额度，远端成功但写后确认失败仍计一次", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 12, 4);
  const today = "2026-08-12";
  cacheWriteContext(store, account, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0 }, ["tag-1"], now);
  const failed = new MoneyTrackService(
    store,
    new QianjiClient({ fetch: createWriteErrorUpstream({ conf_ids: [], has_failed: true }) }),
    () => now,
  );
  await assert.rejects(
    createOneBill(failed, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" }),
    (error) => error instanceof AppError && error.code === "WRITE_FAILED",
  );
  assert.deepEqual(store.getWriteQuota(account.id), { date: today, used: 0 });

  const confirmationFailed = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/bill/syncall") {
        const form = new URLSearchParams(String(init?.body));
        const payload = parseQianjiJson(form.get("v") ?? "") as { bills: { changelist: Array<{ id: unknown }> } };
        return syncOk([JSON.stringify(payload.bills.changelist[0]!.id)], [], []);
      }
      throw new Error("pull unavailable");
    },
  }), () => now);
  await assert.rejects(
    createOneBill(confirmationFailed, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" }),
    (error) => error instanceof AppError &&
      error.code === "WRITE_CONFIRMATION_FAILED" &&
      error.message.includes("refresh_cache"),
  );
  assert.deepEqual(store.getWriteQuota(account.id), { date: today, used: 1 });
});

test("写入不会在用户缓存过期且刷新失败时沿用旧 VIP 权限", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 12, 4);
  cacheWriteContext(store, account, {
    id: account.uid,
    viptype: 4,
    vipstart: Math.floor(now / 1000) - 3600,
    vipend: Math.floor(now / 1000) + 3600,
  }, ["tag-1", "tag-2"], now);
  store.setUserCache(account.id, store.getUserCache(account.id)!.data, now - 4 * 60 * 60 * 1000);
  let initCalls = 0;
  const paths: string[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/client/init") initCalls += 1;
      throw new Error("offline");
    },
  }), () => now);

  await assert.rejects(
    createOneBill(service, accountId, {
      bookId: "1",
      type: 0,
      money: 1,
      categoryId: "2",
      tagIds: ["tag-1", "tag-2"],
    }),
    (error) => error instanceof AppError && error.code === "QIANJI_HTTP_ERROR",
  );
  assert.equal(initCalls, 1);
  assert.deepEqual(paths, ["/client/init"]);
  assert.deepEqual(store.getWriteQuota(account.id), { date: null, used: 0 });
});

test("同步分页固定初始 lasttimes，并原子 upsert changes/delete deletes", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  store.upsertBill(account.id, bill("1770000000000000001", "delete-me"));
  const requestBodies: URLSearchParams[] = [];
  const pages = [
    pullData({
      changes: [bill("1770000000000000002", "page-one")],
      bookid: 1,
      pageoffset: 10,
      pagesign: "next",
      hasmore: 1,
      lasttimes: { cursor: 8 },
    }),
    pullData({
      changes: [bill("1770000000000000003", "page-two"), { ...bill("1770000000000000004", "transfer"), type: 2 }],
      deletes: ["1770000000000000001"],
      pageoffset: 20,
      lasttimes: { cursor: 9 },
    }),
  ];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === "/book/list") {
        return Response.json({ ec: 200, data: { list: [{ bookid: 1, name: "B" }] } });
      }
      requestBodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ ec: 200, data: pages.shift() });
    },
  });
  const service = new MoneyTrackService(store, client);

  const result = await service.listBills(accountId, { bookId: "1" });
  assert.equal(result.bills.length, 3);
  assert.deepEqual(requestBodies.map((body) => body.get("lasttimes")), [
    null,
    null,
  ]);
  assert.equal(requestBodies[0]?.get("bookid"), "-1");
  assert.equal(requestBodies[1]?.get("pageoffset"), "10");
  assert.equal(requestBodies[1]?.get("pagesign"), "next");
  assert.equal(store.getBill(account.id, "1770000000000000001"), undefined);
  assert.equal(store.getBill(account.id, "1770000000000000003")?.remark, "page-two");
  assert.equal(store.getBill(account.id, "1770000000000000004")?.type, 2);
  assert.deepEqual(store.getSyncState(account.id), { cursor: 9 });
});

test("首次同步后查询只读本地，并完整缓存复杂类型与退款报销关系", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const types = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 20, 21, 22];
  const sourceId = "1770000000000100000";
  const refundId = "1770000000000100020";
  const reimbursementId = "1770000000000100021";
  const changes: Record<string, unknown>[] = types.map((type, index) => ({
    ...bill(String(1_770_000_000_000_100_000n + BigInt(index)), `type-${type}`),
    type,
    ...(type === 2 ? { cateid: undefined, opaque_field: "preserve-me" } : {}),
  }));
  changes[0] = {
    ...changes[0],
    id: sourceId,
    extra: { rfds: { [refundId]: 3 }, bxs: { [reimbursementId]: 4 } },
  };
  changes[11] = { ...changes[11], id: refundId, extra: { refundsid: sourceId } };
  changes[12] = { ...changes[12], id: reimbursementId, extra: { bxsid: sourceId } };
  store.setCatalogCache(account.id, "categories", "1", [{ id: "2", name: "旧分类" }], Date.now());
  store.setCatalogCache(account.id, "categories", "2", [{ id: "3", name: "保留分类" }], Date.now());
  let pullCalls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async () => {
      pullCalls += 1;
      return Response.json({ ec: 200, data: pullData({
        changes,
        categories: [{ id: 2, bookid: 1, name: "新分类" }],
        lasttimes: { cursor: 1 },
      }) });
    },
  }));

  const listed = await service.listBills(accountId, { allBooks: true, limit: 100 });
  assert.deepEqual(new Set(listed.bills.map(({ type }) => type)), new Set(types));
  assert.equal(pullCalls, 1);
  assert.equal(store.getCatalogCache(account.id, "categories", "1"), undefined);
  assert.equal(store.getCatalogCache(account.id, "categories", "2")?.data[0]?.name, "保留分类");
  const transfer = listed.bills.find(({ type }) => type === 2)!;
  assert.equal(transfer.categoryId, null);
  assert.equal(JSON.parse(store.getBill(account.id, String(transfer.id))!.rawJson).opaque_field, "preserve-me");

  const source = await service.getBill(accountId, sourceId);
  const refund = await service.getBill(accountId, refundId);
  const reimbursement = await service.getBill(accountId, reimbursementId);
  assert.deepEqual(source.refundBillIds, [refundId]);
  assert.deepEqual(source.reimbursementBillIds, [reimbursementId]);
  assert.deepEqual(source.refundProgress, { totalAmount: 3, remainingAmount: 7 });
  assert.deepEqual(source.reimbursementProgress, { totalAmount: 4, remainingAmount: 3 });
  assert.equal(refund.refundSourceBillId, sourceId);
  assert.equal(reimbursement.reimbursementSourceBillId, sourceId);
  assert.equal(pullCalls, 1);
});

test("同步超过 APK 的 200 页上限时保留旧缓存且不提交游标", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const oldId = "1770000000000200000";
  store.upsertBill(account.id, bill(oldId, "old-cache"));
  let calls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async () => {
      calls += 1;
      return Response.json({ ec: 200, data: pullData({
        changes: [bill(String(1_770_000_000_002_000_000n + BigInt(calls)), `page-${calls}`)],
        pageoffset: calls,
        pagesign: `page-${calls}`,
        hasmore: 1,
        lasttimes: { cursor: calls },
      }) });
    },
  }));

  await assert.rejects(
    service.listBills(accountId, { allBooks: true }),
    (error) => error instanceof AppError && error.code === "SYNC_PAGE_LIMIT_EXCEEDED",
  );
  assert.equal(calls, 200);
  assert.equal(store.getBill(account.id, oldId)?.remark, "old-cache");
  assert.equal(store.countBills(account.id), 1);
  assert.equal(store.getSyncState(account.id), undefined);
});

test("任一同步分页失败时账单和游标同时回滚", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const id = "1770000000000000010";
  store.upsertBill(account.id, bill(id, "before"));
  let call = 0;
  const client = new QianjiClient({
    fetch: async (input) => {
      if (new URL(String(input)).pathname === "/book/list") {
        return Response.json({ ec: 200, data: { list: [{ bookid: 1, name: "B" }] } });
      }
      call += 1;
      if (call === 1) {
        return Response.json({
          ec: 200,
          data: pullData({
            changes: [bill(id, "uncommitted"), bill("1770000000000000011", "new")],
            pageoffset: 1,
            pagesign: "next",
            hasmore: 1,
            lasttimes: { cursor: 2 },
          }),
        });
      }
      return new Response("upstream failure", { status: 500 });
    },
  });
  const service = new MoneyTrackService(store, client);

  await assert.rejects(service.listBills(accountId, { bookId: "1" }), (error) => {
    return error instanceof AppError && error.code === "SYNC_PAGE_FAILED";
  });
  assert.equal(store.getBill(account.id, id)?.remark, "before");
  assert.equal(store.getBill(account.id, "1770000000000000011"), undefined);
  assert.equal(store.getSyncState(account.id), undefined);
});

test("显式刷新分页失败时继续提供刷新前的账单与游标", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const id = "1770000000000000015";
  store.setSyncState(account.id, { cursor: 7 });
  store.upsertBill(account.id, bill(id, "stable-cache"));
  let pullCalls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/client/init") return Response.json({ ec: 200, data: {
        userinfo: { id: account.uid, viptype: -1 },
        books: [{ bookid: 1, name: "B" }],
      } });
      if (path === "/syncv2/pull") {
        pullCalls += 1;
        if (pullCalls === 1) return Response.json({ ec: 200, data: pullData({
          changes: [bill(id, "uncommitted")],
          pageoffset: 1,
          pagesign: "next",
          hasmore: 1,
          lasttimes: { cursor: 8 },
        }) });
        return new Response("upstream failure", { status: 500 });
      }
      throw new Error(`unexpected path: ${path}`);
    },
  }));

  await assert.rejects(
    service.refreshCache(accountId),
    (error) => error instanceof AppError && error.code === "SYNC_PAGE_FAILED",
  );
  assert.equal(store.getBill(account.id, id)?.remark, "stable-cache");
  assert.deepEqual(store.getSyncState(account.id), { cursor: 7 });
  assert.equal((await service.getBill(accountId, id)).remark, "stable-cache");
  assert.equal(pullCalls, 2);
});

test("钱迹业务错误保持明确分类并回滚同步事务", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const id = "1770000000000000012";
  store.upsertBill(account.id, bill(id, "before"));
  let call = 0;
  const client = new QianjiClient({
    fetch: async (input) => {
      if (new URL(String(input)).pathname === "/book/list") {
        return Response.json({ ec: 200, data: { list: [{ bookid: 1, name: "B" }] } });
      }
      call += 1;
      return call === 1
        ? Response.json({
            ec: 200,
            data: pullData({
              changes: [bill(id, "uncommitted")],
              pageoffset: 1,
              pagesign: "next",
              hasmore: 1,
              lasttimes: { cursor: 2 },
            }),
          })
        : Response.json({ ec: 403, em: "账本权限已变更" });
    },
  });
  const service = new MoneyTrackService(store, client);

  await assert.rejects(service.listBills(accountId, { bookId: "1" }), (error) =>
    error instanceof AppError && error.code === "QIANJI_BUSINESS_ERROR",
  );
  assert.equal(store.getBill(account.id, id)?.remark, "before");
  assert.equal(store.getSyncState(account.id), undefined);
});

test("非法同步游标保持明确分类并回滚", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const client = new QianjiClient({
    fetch: async (input) => new URL(String(input)).pathname === "/book/list"
      ? Response.json({ ec: 200, data: { list: [{ bookid: 1, name: "B" }] } })
      : Response.json({
        ec: 200,
        data: pullData({ pageoffset: -1, hasmore: 1, lasttimes: { cursor: 2 } }),
      }),
  });
  const service = new MoneyTrackService(store, client);

  await assert.rejects(service.listBills(accountId, { bookId: "1" }), (error) =>
    error instanceof AppError && error.code === "SYNC_CURSOR_INVALID",
  );
  assert.equal(store.getSyncState(account.id), undefined);
});

test("指定账本在同步前确认属于当前账号", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  let syncCalled = false;
  let bookCalls = 0;
  const client = new QianjiClient({
    fetch: async (input) => {
      if (new URL(String(input)).pathname === "/book/list") {
        bookCalls += 1;
        return Response.json({ ec: 200, data: { list: [{ bookid: 1, name: "B" }] } });
      }
      syncCalled = true;
      return Response.json({ ec: 200, data: pullData() });
    },
  });
  const service = new MoneyTrackService(store, client);

  await assert.rejects(service.listBills(accountId, { bookId: "2" }), (error) =>
    error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE" && error.message === "账本不属于当前钱迹账号",
  );
  assert.equal(bookCalls, 1);
  await assert.rejects(service.listBills(accountId, { bookId: "2" }), (error) =>
    error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE",
  );
  assert.equal(bookCalls, 2);
  assert.equal(syncCalled, false);
});

test("初始化完成后 list_bills 和 get_bill 只读本地缓存", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  store.setSyncState(account.id, { cursor: 7 });
  const localBill = bill("1770000000000000099", "local-cache");
  store.upsertBill(account.id, localBill);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "B", visible: 1 }], Date.now());
  const requests: URLSearchParams[] = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const body = new URLSearchParams(String(init?.body));
      requests.push(body);
      throw new Error(`unexpected upstream request: ${String(input)}`);
    },
  });
  const service = new MoneyTrackService(store, client);

  const result = await service.listBills(accountId, { bookId: "1" });
  const complete = await service.getBill(accountId, String(localBill.id));

  assert.equal(result.bills.length, 1);
  assert.equal(complete.remark, "local-cache");
  assert.equal(requests.length, 0);
  assert.deepEqual(store.getSyncState(account.id), { cursor: 7 });
});

test("list_bills 游标自包含筛选条件和默认页大小", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  const remarkKeyword = "账".repeat(42);
  const matching = Array.from({ length: 25 }, (_, index) =>
    bill(String(1_770_000_000_000_000_000n + BigInt(index)), `${remarkKeyword}-${index}`, 1_770_000_000 + index),
  );
  const changes = [
    ...matching,
    ...Array.from({ length: 3 }, (_, index) => ({
      ...bill(String(1_770_000_000_000_000_100n + BigInt(index)), `income-${index}`, 1_770_000_000 + index),
      type: 1,
    })),
  ];
  const client = new QianjiClient({
    fetch: async () => Response.json({ ec: 200, data: pullData({ changes }) }),
  });
  const service = new MoneyTrackService(store, client);

  const first = await service.listBills(accountId, {
    allBooks: true,
    type: 0,
    createStartTime: 1_770_000_000,
    remarkKeyword,
    assetId: "-1",
  });
  assert.equal(first.bills.length, 20);
  assert.equal(typeof first.nextCursor, "string");
  assert.match(first.nextCursor!, /^c_[a-f0-9]+$/);
  const legacyCursor = Buffer.from(first.nextCursor!.slice(2), "hex").toString("base64url");
  assert.deepEqual(
    (await service.listBills(accountId, { cursor: legacyCursor })).bills.map(({ id }) => id),
    (await service.listBills(accountId, { cursor: first.nextCursor! })).bills.map(({ id }) => id),
  );
  const second = await service.listBills(accountId, { cursor: first.nextCursor! });
  assert.equal(second.bills.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(second.bills.every(({ type }) => type === 0), true);
  assert.equal(second.bills.some(({ id }) => first.bills.some((bill) => bill.id === id)), false);
  await assert.rejects(
    service.listBills(accountId, { cursor: first.nextCursor!, type: 0 }),
    (error) => error instanceof AppError && error.code === "INVALID_CURSOR_ARGUMENTS",
  );
  const invalidCursor = Buffer.from(JSON.stringify({
    v: 2,
    accountId,
    time: matching[0]!.time,
    id: matching[0]!.id,
    assetId: 3,
    limit: 20,
  })).toString("base64url");
  await assert.rejects(
    service.listBills(accountId, { cursor: invalidCursor }),
    (error) => error instanceof AppError && error.code === "INVALID_CURSOR",
  );
  const invalidFilterCursor = `c_${Buffer.from(JSON.stringify({
    v: 2,
    accountId,
    time: matching[0]!.time,
    id: matching[0]!.id,
    remarkKeyword: "账".repeat(43),
    limit: 20,
  })).toString("hex")}`;
  await assert.rejects(
    service.listBills(accountId, { cursor: invalidFilterCursor }),
    (error) => error instanceof AppError && error.code === "INVALID_CURSOR",
  );
});

test("list_bills 区分创建与发生时间，并筛选资产方向和备注", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const directId = "1770000000000400001";
  const transferId = "1770000000000400002";
  store.setSyncState(account.id, { cursor: 1 });
  store.upsertBill(account.id, {
    ...bill(directId, "直接资产 Direct 100%_真实", 100),
    assetid: 3,
    createtime: 200,
  });
  store.upsertBill(account.id, {
    ...bill(transferId, "转账", 200),
    type: 2,
    fromid: 3,
    targetid: 4,
    createtime: 100,
  });
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async () => { throw new Error("unexpected upstream call"); },
  }));

  assert.deepEqual((await service.listBills(accountId, { allBooks: true, createStartTime: 200 })).bills.map(({ id }) => id), [directId]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, startTime: 200 })).bills.map(({ id }) => id), [transferId]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, assetId: "3" })).bills.map(({ id }) => id), [directId]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, fromAssetId: "3" })).bills.map(({ id }) => id), [transferId]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, targetAssetId: "4" })).bills.map(({ id }) => id), [transferId]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, type: 2 })).bills.map(({ fromId, targetId }) => ({ fromId, targetId })), [
    { fromId: "3", targetId: "4" },
  ]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, remarkKeyword: "%_" })).bills.map(({ id }) => id), [directId]);
  assert.deepEqual((await service.listBills(accountId, { allBooks: true, remarkKeyword: "direct" })).bills.map(({ id }) => id), [directId]);
});

test("list_bills 高级筛选按公开金额排序，且游标拒绝篡改", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createBusinessUpstream();
  upstream.seed({
    ...bill("1770000000000100101", "优惠后八元"),
    money: 56,
    platform: 3,
    extra: { tags: ["tag-1"], transfee: -2, curr: { ss: "USD", sv: 10, ts: "CNY", tv: 56, bs: "CNY", bv: 56 } },
  });
  upstream.seed({
    ...bill("1770000000000100102", "十一元"),
    money: 77,
    platform: 2,
    extra: { tags: ["tag-1"], curr: { ss: "USD", sv: 11, ts: "CNY", tv: 77, bs: "CNY", bv: 77 } },
  });
  upstream.seed({
    ...bill("1770000000000100103", "自动记账"),
    money: 63,
    platform: 122,
    extra: { tags: ["tag-1"], curr: { ss: "USD", sv: 9, ts: "CNY", tv: 63, bs: "CNY", bv: 63 } },
  });
  cacheBusinessContext(store, account, now, true);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const first = await service.listBills(accountId, {
    bookId: "1",
    types: [0],
    minMoney: 9,
    maxMoney: 11,
    tagIds: ["tag-1"],
    source: 2,
    currency: "USD",
    sort: "moneyAsc",
    limit: 1,
  });
  assert.equal(first.bills[0]?.id, "1770000000000100101");
  assert.equal(first.bills[0]?.money, 10);
  assert.equal(typeof first.nextCursor, "string");
  const second = await service.listBills(accountId, { cursor: first.nextCursor! });
  assert.deepEqual(second.bills.map(({ id }) => id), ["1770000000000100102"]);
  assert.equal(second.nextCursor, null);

  const decoded = JSON.parse(Buffer.from(first.nextCursor!.slice(3), "hex").toString("utf8")) as Record<string, unknown>;
  (decoded.filters as Record<string, unknown>).minMoney = "9";
  const tampered = `c3_${Buffer.from(JSON.stringify(decoded)).toString("hex")}`;
  await assert.rejects(
    service.listBills(accountId, { cursor: tampered }),
    (error) => error instanceof AppError && error.code === "INVALID_CURSOR",
  );
});

test("借入或借出详情使用独立接口并在上游缺币种时使用本位币", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  let requestBody = "";
  let response: Record<string, unknown> = {
    id: "1770000000000100199",
    name: "借出记录",
    stype: 52,
    status: 1,
    money: -30,
    loan: { money: -100, totalpay: -70, startdate: "2026-01-01", enddate: "2026-12-31" },
    extra: { ftime: 1_770_000_000 },
  };
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/asset/listloan");
      requestBody = String(init?.body);
      return ok({ list: [response] });
    },
  }));

  assert.deepEqual(await service.listDebtAccounts(accountId, "lent", "ended"), [{
    id: "1770000000000100199",
    name: "借出记录",
    direction: "lent",
    status: "ended",
    currency: "CNY",
    principal: 100,
    balance: 30,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    finishedAt: 1_770_000_000,
    totalPaid: 70,
  }]);
  const form = new URLSearchParams(requestBody);
  assert.equal(form.get("t"), "52");
  assert.equal(form.get("status"), "1");
  response = { id: "1770000000000100200", name: "缺失详情", stype: 51, status: 0, money: 0 };
  await assert.rejects(
    service.listDebtAccounts(accountId, "borrowed", "active"),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID" && error.httpStatus === 502,
  );
});

test("同一账号的并发首次查询只执行一次初始化同步", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  let calls = 0;
  let releaseFirst = (): void => {};
  let markEntered = (): void => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>((resolve) => { markEntered = resolve; });
  const client = new QianjiClient({
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        markEntered();
        await firstGate;
      }
      return Response.json({ ec: 200, data: pullData({ lasttimes: { cursor: calls } }) });
    },
  });
  const service = new MoneyTrackService(store, client);

  const first = service.listBills(accountId, { allBooks: true });
  await firstEntered;
  const second = service.listBills(accountId, { allBooks: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("不同账号的同步请求可以并发进入上游", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  const secondPat = store.createPat("second", null);
  const secondAccount = store.bindPat(secondPat.id, "uid-2", "token-2", "device-2");
  let releaseFirst = (): void => {};
  let firstEntered = (): void => {};
  let secondEntered = false;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const client = new QianjiClient({
    fetch: async (_input, init) => {
      const uid = new URLSearchParams(String(init?.body)).get("uid");
      if (uid === "uid-1") {
        firstEntered();
        await firstGate;
      } else if (uid === "uid-2") {
        secondEntered = true;
      }
      return Response.json({ ec: 200, data: pullData() });
    },
  });
  const service = new MoneyTrackService(store, client);

  const first = service.listBills(accountId, { allBooks: true });
  await entered;
  const second = service.listBills(secondAccount.id, { allBooks: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, true);
  releaseFirst();
  await Promise.all([first, second]);
});

test("目录快照沿用 APK 刷新周期并始终缓存完整列表", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const calls = new Map<string, number>();
  const forms = new Map<string, URLSearchParams[]>();
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const form = new URLSearchParams(String(init?.body));
    calls.set(path, (calls.get(path) ?? 0) + 1);
    forms.set(path, [...(forms.get(path) ?? []), form]);
    if (path === "/book/list") return ok({ list: [
      { bookid: 1, name: "刷新账本", visible: 1 },
      { bookid: 2, name: "隐藏账本", visible: 0 },
    ] });
    if (path === "/asset/list") return ok({ list: form.get("status") === "0"
      ? [{ id: 3, name: "刷新资产", status: 0, groupid: -1 }]
      : [{ id: 4, name: "隐藏资产", status: 2, groupid: -1 }] });
    if (path === "/category/listv2") return ok({ list: [
      { id: 5, name: "支出分类", type: 0, parentid: -1 },
      { id: 6, name: "收入分类", type: 1, parentid: -1 },
    ] });
    if (path === "/tag/list") return ok({ list: [
      { id: "", name: "默认组", tags: [{ id: "tag.alpha", name: "当前标签", status: 1 }] },
      { id: "group-2", name: "归档组", tags: [{ id: "tag-2", name: "归档标签", status: 2 }] },
    ] });
    throw new Error(`Unexpected cache fixture path: ${path}`);
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }));
  const now = Date.now();
  const minute = 60 * 1000;
  store.setCatalogCache(account.id, "books", "", [
    { bookid: "1", name: "本地账本", visible: 1 },
    { bookid: "2", name: "Hidden账本", visible: 0 },
  ], now - 12 * 60 * minute + minute);
  store.setCatalogCache(account.id, "assets", "", [
    { id: "2", name: "常用现金", type: 1, status: 0, groupid: "custom-1", groupName: "常用", groupOrder: 0 },
    { id: "3", name: "Local资产", type: 1, status: 0, groupid: "-1" },
    { id: "4", name: "本地隐藏资产", status: 2, groupid: "-1" },
  ], now - 60 * minute + minute);
  store.setCatalogCache(account.id, "categories", "1", [
    { id: "5", name: "本地支出分类", type: 0, parentid: "-1", sublist: [
      { id: 8, name: "本地二级分类", type: 0, level: 2, parentid: 5 },
    ] },
    { id: "6", name: "本地收入分类", type: 1, parentid: "-1" },
  ], now - 30 * minute + minute);
  store.setCatalogCache(account.id, "tags", "", [
    { id: "tag.alpha", name: "本地当前标签", status: 1, groupId: "", groupName: "默认组" },
    { id: "tag-2", name: "本地归档标签", status: 2, groupId: "group-2", groupName: "归档组" },
  ], now - 2 * 60 * minute + minute);

  assert.deepEqual((await service.listBooks(accountId, false)).map(({ name }) => name), ["本地账本"]);
  assert.deepEqual((await service.listBooks(accountId, true, "hidden")).map(({ name }) => name), ["Hidden账本"]);
  assert.deepEqual(await service.listAssets(accountId, false), [
    {
      name: "常用",
      children: [{ id: "2", name: "常用现金", currency: "CNY", type: 1, subtype: 0, status: 0, inCount: 0 }],
    },
    {
      name: "资金",
      children: [{ id: "3", name: "Local资产", currency: "CNY", type: 1, subtype: 0, status: 0, inCount: 0 }],
    },
  ]);
  assert.deepEqual(await service.listAssets(accountId, false, false, "local"), [
    {
      name: "资金",
      children: [{ id: "3", name: "Local资产", currency: "CNY", type: 1, subtype: 0, status: 0, inCount: 0 }],
    },
  ]);
  assert.equal(
    ((await service.listAssets(accountId, false, true))[0]!.children as Record<string, unknown>[])[0]!.money,
    0,
  );
  const localCategories = await service.listCategories(accountId, "1", 0);
  assert.deepEqual(localCategories.map(({ name }) => name), ["本地支出分类"]);
  assert.deepEqual(localCategories[0]?.children, [
    { id: "8", name: "本地二级分类", type: 0, level: 2, parentId: "5" },
  ]);
  assert.deepEqual(await service.listTags(accountId, 2), [{
    groupId: "group-2",
    name: "归档组",
    children: [{ id: "tag-2", name: "本地归档标签", status: 2 }],
  }]);
  assert.equal(calls.size, 0);

  store.setCatalogCache(account.id, "books", "", [{
    bookid: "1",
    name: "成员已过期账本",
    visible: 1,
    expired: 1,
    userid: "owner",
    memberid: account.uid,
  }], Date.now());
  await service.listBooks(accountId, false);
  assert.equal(calls.get("/book/list"), 1);

  const expired = {
    books: now - 12 * 60 * minute - minute,
    assets: now - 60 * minute - minute,
    categories: now - 30 * minute - minute,
    tags: now - 2 * 60 * minute - minute,
  };
  for (const [kind, refreshedAt] of Object.entries(expired)) {
    store.db.prepare("UPDATE catalog_cache SET refreshed_at_ms = ? WHERE account_id = ? AND kind = ?")
      .run(refreshedAt, account.id, kind);
  }

  assert.deepEqual((await service.listBooks(accountId, false)).map(({ name }) => name), ["刷新账本"]);
  assert.deepEqual(
    (await service.listAssets(accountId, false)).flatMap(({ children }) => children as Record<string, unknown>[]).map(({ name }) => name),
    ["刷新资产"],
  );
  assert.deepEqual((await service.listCategories(accountId, "1", 1)).map(({ name }) => name), ["收入分类"]);
  assert.deepEqual(
    (await service.listTags(accountId, 1)).flatMap(({ children }) => children as Record<string, unknown>[]).map(({ name }) => name),
    ["当前标签"],
  );
  assert.equal(calls.get("/book/list"), 2);
  assert.equal(calls.get("/asset/list"), 2);
  assert.equal(calls.get("/category/listv2"), 1);
  assert.equal(calls.get("/tag/list"), 1);
  assert.equal(forms.get("/book/list")?.[0]?.get("t"), "-1");
  assert.deepEqual(new Set(forms.get("/asset/list")?.map((form) => form.get("status"))), new Set(["0", "2"]));
  assert.equal(forms.get("/category/listv2")?.[0]?.get("t"), "-1");
  assert.equal(forms.get("/tag/list")?.[0]?.get("status"), "-1");
  assert.equal(forms.get("/tag/list")?.[0]?.get("lasttime"), "0");
  assert.deepEqual(await service.listTags(accountId, -1), [
    { groupId: "", name: "默认组", children: [{ id: "tag.alpha", name: "当前标签", status: 1 }] },
    { groupId: "group-2", name: "归档组", children: [{ id: "tag-2", name: "归档标签", status: 2 }] },
  ]);

  await service.listBooks(accountId, true);
  await service.listAssets(accountId, true);
  await service.listCategories(accountId, "1", -1);
  await service.listTags(accountId, -1);
  assert.deepEqual(Object.fromEntries(calls), {
    "/book/list": 2,
    "/asset/list": 2,
    "/category/listv2": 1,
    "/tag/list": 1,
  });
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM catalog_cache").get() as { count: bigint }).count, 4n);

  store.setCatalogCache(account.id, "tags", "", [], Date.now());
  await service.listTags(accountId, -1);
  assert.equal(calls.get("/tag/list"), 2);
  assert.equal(forms.get("/tag/list")?.[1]?.get("lasttime"), "0");
});

test("账本成员查询校验账本归属并只返回筛选字段", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "共享账本", visible: 1 }], Date.now());
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/book/members") {
        return new Response('{"ec":200,"data":{"list":[{"id":1770000000000000001,"name":"成员"}]}}');
      }
      if (path === "/book/list") return ok({ list: [{ bookid: 1, name: "共享账本", visible: 1 }] });
      throw new Error(`unexpected path: ${path}`);
    },
  }));

  assert.deepEqual(await service.listBookMembers(accountId, "1"), [
    { userId: "1770000000000000001", name: "成员" },
  ]);
  await assert.rejects(
    service.listBookMembers(accountId, "2"),
    (error) => error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE",
  );
});

test("目录读取失败保留旧缓存，写入校验拒绝无法刷新的过期缓存", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "离线账本", visible: 1 }], 0);
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async () => { throw new Error("offline"); },
  }));

  assert.equal((await service.listBooks(accountId, false))[0]?.name, "离线账本");
  await assert.rejects(
    createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" }),
    (error) => error instanceof AppError && error.code === "QIANJI_HTTP_ERROR",
  );
  assert.equal(store.getCatalogCache(account.id, "books")?.refreshedAtMs, 0);
});

test("写入引用未命中时强制刷新目录一次", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const upstream = createStatefulUpstream();
  const catalogCalls = new Map<string, number>();
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (["/book/list", "/asset/list", "/category/listv2", "/tag/list"].includes(path)) {
      catalogCalls.set(path, (catalogCalls.get(path) ?? 0) + 1);
    }
    return upstream.fetch(input, init);
  };
  const now = Date.now();
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "账本", visible: 1 }], now);
  store.setCatalogCache(account.id, "assets", "", [{ id: "3", name: "资产", status: 0 }], now);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "99", name: "旧分类", type: 0 }], now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "tag-1", name: "标签", status: 1 }], now);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }));

  const created = await createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" });

  assert.equal(created.categoryId, "2");
  assert.deepEqual(Object.fromEntries(catalogCalls), {
    "/asset/list": 2,
    "/category/listv2": 1,
    "/tag/list": 1,
  });
});

test("隐式默认账本不依赖账本列表即可按 -1 写入", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createStatefulUpstream();
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0 }, now);
  store.setCatalogCache(account.id, "books", "", [], now);
  store.setCatalogCache(account.id, "assets", "", [], now);
  store.setCatalogCache(account.id, "categories", "-1", [{ id: "2", name: "餐饮", type: 0 }], now);
  store.setCatalogCache(account.id, "tags", "", [], now);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const created = await createOneBill(service, accountId, { type: 0, money: 1, categoryId: "2" });
  assert.equal(created.bookId, "-1");
  const payload = upstream.payloads[0] as { bills: { changelist: Record<string, unknown>[] } };
  assert.equal(payload.bills.changelist[0]?.bookid, -1);
});

test("账本写入按官方成员到期与所有者 VIP 到期规则拒绝", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createStatefulUpstream();
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: Math.floor(now / 1000) - 1 }, now);
  store.setCatalogCache(account.id, "assets", "", [], now);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "2", name: "餐饮", type: 0 }], now);
  store.setCatalogCache(account.id, "tags", "", [], now);
  let remoteBook: Record<string, unknown> = { bookid: "1", expired: 1, userid: "owner", memberid: account.uid };
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/book/list") return ok({ list: [remoteBook] });
    if (path === "/client/init") {
      return ok({ userinfo: { id: account.uid, viptype: -1, vipstart: 0, vipend: Math.floor(now / 1000) - 1 } });
    }
    return upstream.fetch(input, init);
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => now);

  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", expired: 1, userid: "owner", memberid: account.uid }], now);
  await assert.rejects(
    createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" }),
    (error) => error instanceof AppError && error.code === "BOOK_EXPIRED",
  );
  remoteBook = { bookid: "1", expired: 0, userid: account.uid };
  store.setCatalogCache(account.id, "books", "", [remoteBook], now);
  await assert.rejects(
    createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" }),
    (error) => error instanceof AppError && error.code === "BOOK_EXPIRED",
  );
});

test("fixture 完成创建、完整对象更新和删除闭环", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  const upstream = createStatefulUpstream();
  let assetListCalls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: (input, init) => {
    if (new URL(String(input)).pathname === "/asset/list") assetListCalls += 1;
    return upstream.fetch(input, init);
  } }));

  await assert.rejects(
    () => createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2", assetId: "0" }),
    (error) => error instanceof AppError && error.code === "INVALID_ASSET_ID",
  );

  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 25.8,
    discount: 3,
    categoryId: "2",
    assetId: "3",
    remark: "午餐",
    tagIds: ["tag-1"],
  });
  const id = String(created.id);
  assert.equal(created.bookId, "1");
  assert.equal(created.categoryId, "2");
  assert.equal(created.money, 25.8);
  assert.equal("fee" in created, false);
  assert.equal(created.discount, 3);
  assert.equal("userid" in created, false);
  assert.equal("userId" in created, false);
  assert.equal("status" in created, false);
  const listed = await service.listBills(accountId, { bookId: "1" });
  assert.equal(listed.bills[0]?.excludeFromIncomeExpense, false);
  assert.equal(listed.bills[0]?.excludeFromBudget, false);
  assert.equal("flag" in (listed.bills[0] ?? {}), false);
  assert.equal(listed.bills[0]?.money, 25.8);
  assert.equal(listed.bills[0]?.discount, 3);
  const detailedAfterCreate = await service.getBill(accountId, id);
  assert.equal(detailedAfterCreate.money, 25.8);
  assert.equal(detailedAfterCreate.discount, 3);
  assert.equal("createtime" in created, false);
  const createPayload = upstream.payloads[0] as { bills: { changelist: Record<string, unknown>[] } };
  const { id: sentCreateId, ...sentCreate } = createPayload.bills.changelist[0] ?? {};
  assert.equal(JSON.stringify(sentCreateId), id);
  assert.deepEqual(sentCreate, {
    userid: "uid-1",
    bookid: 1,
    time: created.time,
    type: 0,
    money: 22.8,
    remark: "午餐",
    status: 2,
    cateid: 2,
    assetid: 3,
    fromid: -1,
    targetid: -1,
    createtime: created.createTime,
    updatetime: created.updateTime,
    platform: 0,
    images: [],
    extra: { flag: 0, tags: ["tag-1"], transfee: -3 },
  });
  const assetListCallsAfterCreate = assetListCalls;
  assert.equal(((await service.listAssets(accountId, false, true))[0]!.children as Record<string, unknown>[])[0]!.money, 77.2);
  assert.equal(assetListCalls, assetListCallsAfterCreate);

  upstream.addUnknownFields();
  const updated = await updateOneBill(service, accountId, id, { money: 25.7, remark: "晚餐", discount: 2 });
  const updatePayload = upstream.payloads[1] as { bills: { changelist: Record<string, unknown>[] } };
  const sent = updatePayload.bills.changelist[0] ?? {};
  assert.equal(updated.remark, "晚餐");
  assert.equal("serverOnly" in updated, false);
  assert.equal("server_only" in updated, false);
  assert.equal("serverNumber" in updated, false);
  assert.equal(updated.excludeFromIncomeExpense, false);
  assert.equal(updated.excludeFromBudget, false);
  assert.equal("flag" in updated, false);
  assert.equal(updated.money, 25.7);
  assert.equal("fee" in updated, false);
  assert.equal(updated.discount, 2);
  assert.deepEqual(updated.tagIds, ["tag-1"]);
  assert.equal(sent.server_only, "preserve-me");
  assert.equal(JSON.stringify(sent.server_number), "1770000000000999999");
  assert.equal(sent.money, 23.7);
  assert.deepEqual(sent.extra, { flag: 0, tags: ["tag-1"], transfee: -2, opaque: "preserve-me" });
  assert.equal("category" in sent, false);
  assert.equal(JSON.stringify(sent.id), id);
  assert.equal(sent.userid, "uid-1");
  assert.equal(sent.createtime, created.createTime);
  const listedAfterUpdate = await service.listBills(accountId, { bookId: "1" });
  const detailedAfterUpdate = await service.getBill(accountId, id);
  assert.equal(listedAfterUpdate.bills[0]?.money, 25.7);
  assert.equal(listedAfterUpdate.bills[0]?.discount, 2);
  assert.equal(detailedAfterUpdate.money, 25.7);
  assert.equal(detailedAfterUpdate.discount, 2);
  assert.equal(assetListCalls, assetListCallsAfterCreate);
  const assetListCallsAfterUpdate = assetListCalls;
  assert.equal(((await service.listAssets(accountId, false, true))[0]!.children as Record<string, unknown>[])[0]!.money, 76.3);
  assert.equal(assetListCalls, assetListCallsAfterUpdate);

  assert.deepEqual(await deleteOneBill(service, accountId, id), {
    deleted: [{ billId: id, relatedBillIds: [] }],
  });
  const deletePayload = upstream.payloads[2] as { bills: { dellist: string[] } };
  assert.equal(JSON.stringify(deletePayload.bills.dellist), `[${id}]`);
});

test("update_bills 支持更换账本并校验目标账本分类", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  const upstream = createStatefulUpstream();
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }));
  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 1,
    categoryId: "2",
  });
  const id = String(created.id);

  await assert.rejects(updateOneBill(service, accountId, id, { bookId: "2" }), (error) =>
    error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE",
  );
  await assert.rejects(updateOneBill(service, accountId, id, { bookId: "999", categoryId: "8" }), (error) =>
    error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE",
  );

  const moved = await updateOneBill(service, accountId, id, { bookId: "2", categoryId: "8" });
  assert.equal(moved.bookId, "2");
  assert.equal(moved.categoryId, "8");
  const movePayload = upstream.payloads.at(-1) as { bills: { changelist: Record<string, unknown>[] } };
  assert.equal(String(movePayload.bills.changelist[0]?.bookid), "2");
  assert.equal(String(movePayload.bills.changelist[0]?.cateid), "8");

  const unchanged = await updateOneBill(service, accountId, id, { remark: "仍在第二账本" });
  assert.equal(unchanged.bookId, "2");
  upstream.ignoreNextChange();
  await assert.rejects(updateOneBill(service, accountId, id, { bookId: "1", categoryId: "2" }), (error) =>
    error instanceof AppError && error.code === "WRITE_CONFIRMATION_FAILED",
  );
});

test("收入 type=1 通过 fixture 完成创建、修改和删除", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  const upstream = createStatefulUpstream(1);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }));

  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 1,
    money: 100,
    categoryId: "2",
    assetId: "3",
  });
  assert.equal(created.type, 1);
  assert.equal(((await service.listAssets(accountId, false, true))[0]!.children as Record<string, unknown>[])[0]!.money, 200);
  const updated = await updateOneBill(service, accountId, String(created.id), { money: 120 });
  assert.equal(updated.money, 120);
  assert.equal(((await service.listAssets(accountId, false, true))[0]!.children as Record<string, unknown>[])[0]!.money, 220);
  assert.deepEqual(await deleteOneBill(service, accountId, String(created.id)), {
    deleted: [{ billId: String(created.id), relatedBillIds: [] }],
  });
  assert.equal(store.getCatalogCache(accountId, "assets"), undefined);
});

test("update_bills 在最终同步未体现 patch 时明确失败", async (t) => {
  const { store, accountId } = setup();
  t.after(() => store.close());
  const upstream = createStatefulUpstream();
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }));
  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 1,
    categoryId: "2",
  });

  upstream.ignoreNextChange();
  await assert.rejects(updateOneBill(service, accountId, String(created.id), { remark: "未生效" }), (error) =>
    error instanceof AppError && error.code === "WRITE_CONFIRMATION_FAILED",
  );
});

for (const [name, result, expectedCode] of [
  ["conf_ids", { conf_ids: ["conflict"], has_failed: false }, "WRITE_CONFLICT"],
  ["has_failed", { conf_ids: [], has_failed: true }, "WRITE_FAILED"],
] as const) {
  test(`${name} 被识别为明确写入错误`, async (t) => {
    const { store, accountId } = setup();
    t.after(() => store.close());
    const fetch = createWriteErrorUpstream(result);
    const service = new MoneyTrackService(store, new QianjiClient({ fetch }));
    await assert.rejects(
      createOneBill(service, accountId, { bookId: "1", type: 0, money: 1, categoryId: "2" }),
      (error) => error instanceof AppError && error.code === expectedCode,
    );
  });
}

test("批量同步部分成功时保留成功项、配额和逐项结果", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 12, 4);
  const upstream = createBusinessUpstream();
  cacheBusinessContext(store, account, now, false);
  const fetch: QianjiFetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/bill/syncall") return upstream.fetch(input, init);
    const form = new URLSearchParams(String(init?.body));
    const payload = parseQianjiJson(form.get("v") ?? "") as {
      bills: { changelist: Array<Record<string, unknown>> };
    };
    const first = payload.bills.changelist[0]!;
    form.set("v", JSON.stringify({ bills: { changelist: [first] } }));
    await upstream.fetch(input, { ...init, body: form });
    return syncOk([JSON.stringify(first.id)], [], [], [], true);
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => now);

  await assert.rejects(
    service.createBills(accountId, [
      { bookId: "1", type: 0, money: 1, categoryId: "2", remark: "成功项" },
      { bookId: "1", type: 0, money: 2, categoryId: "2", remark: "失败项" },
    ]),
    (error) => error instanceof AppError &&
      error.code === "WRITE_PARTIAL" &&
      error.message.includes("第 1 项") &&
      error.message.includes("第 2 项") &&
      error.message.includes("=成功") &&
      error.message.includes("=失败（上游未确认）") &&
      error.message.includes("请勿重试成功项"),
  );
  const remaining = await service.listBills(accountId, { allBooks: true });
  assert.deepEqual(remaining.bills.map(({ remark }) => remark), ["成功项"]);
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-12", used: 1 });
});

test("普通支出可切换待报销状态且收入不能标记待报销", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createBusinessUpstream();
  cacheBusinessContext(store, account, now, true);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const pending = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 10,
    discount: 6,
    categoryId: "2",
    reimbursable: true,
  });
  assert.equal(pending.type, 5);
  const ordinary = await updateOneBill(service, accountId, String(pending.id), { reimbursable: false });
  assert.equal(ordinary.type, 0);

  const income = await createOneBill(service, accountId, {
    bookId: "1",
    type: 1,
    money: 10,
    categoryId: "7",
  });
  await assert.rejects(
    updateOneBill(service, accountId, String(income.id), { reimbursable: true }),
    (error) => error instanceof AppError && error.code === "INVALID_REIMBURSABLE",
  );
  await assert.rejects(
    createOneBill(service, accountId, { bookId: "1", type: 0, money: 10, discount: 11, categoryId: "2" }),
    (error) => error instanceof AppError && error.code === "INVALID_BILL_ADJUSTMENT",
  );
  await assert.rejects(
    createOneBill(service, accountId, { bookId: "1", type: 0, money: 1.001, categoryId: "2" }),
    (error) => error instanceof AppError && error.code === "INVALID_MONEY",
  );
  await assert.rejects(
    createOneBill(service, accountId, { bookId: "1", type: 1, money: 10, discount: 1, categoryId: "7" }),
    (error) => error instanceof AppError && error.code === "BILL_ADJUSTMENT_UNSUPPORTED",
  );
  await assert.rejects(
    updateOneBill(service, accountId, String(pending.id), { money: 5 }),
    (error) => error instanceof AppError && error.code === "INVALID_BILL_ADJUSTMENT",
  );
});

test("普通账单批量先全量校验，每个阶段只发一次同步请求", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createBusinessUpstream();
  cacheBusinessContext(store, account, now, true);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  await assert.rejects(
    service.createBills(accountId, [
      { bookId: "1", type: 0, money: 1, categoryId: "2" },
      { bookId: "1", type: 1, money: 2, categoryId: "2" },
    ]),
    (error) => error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE" && error.message.includes("账单类型不匹配"),
  );
  assert.equal(upstream.syncPayloads.length, 0);

  const created = await service.createBills(accountId, [
    { bookId: "1", type: 0, money: 1, categoryId: "2", remark: "一" },
    { bookId: "1", type: 0, money: 2, categoryId: "2", remark: "二" },
    { bookId: "1", type: 1, money: 0.28, categoryId: "7", remark: "一" },
    { bookId: "1", type: 1, money: 0.59, categoryId: "7", remark: "二" },
  ]);
  assert.equal(new Set(created.bills.map(({ id }) => id)).size, 4);
  const createdChanges = (upstream.syncPayloads[0]?.bills as { changelist: Record<string, unknown>[] }).changelist;
  assert.deepEqual(createdChanges.map(({ money }) => money), [1, 2, 0.28, 0.59]);
  assert.deepEqual(created.bills.map(({ money }) => money), [1, 2, 0.28, 0.59]);

  const updated = await service.updateBills(accountId, created.bills.map(({ id }, index) => ({
    billId: String(id),
    patch: { remark: `更新${index + 1}` },
  })));
  assert.deepEqual(updated.bills.map(({ remark }) => remark), ["更新1", "更新2", "更新3", "更新4"]);
  assert.equal(((upstream.syncPayloads[1]?.bills as { changelist: unknown[] }).changelist).length, 4);

  const deleted = await service.deleteBills(accountId, created.bills.map(({ id }) => ({ billId: String(id) })));
  assert.equal(deleted.deleted.length, 4);
  assert.equal(((upstream.syncPayloads[2]?.bills as { dellist: unknown[] }).dellist).length, 4);
});

test("跨币种普通账单按目标币种更新资产余额快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createBusinessUpstream();
  cacheBusinessContext(store, account, now, true);
  const assets = store.getCatalogCache(account.id, "assets")!;
  store.setCatalogCache(account.id, "assets", "", assets.data.map((asset) =>
    String(asset.id) === "3" ? { ...asset, money: 100.123456 } : asset
  ), now);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 10,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD" },
  });
  assert.equal(((upstream.syncPayloads[0]?.bills as { changelist: Record<string, unknown>[] }).changelist[0]?.money), 70);
  assert.equal(created.money, 10);
  assert.equal((created.currencyConversion as Record<string, unknown>).targetAmount, 70);
  assert.equal(((await service.listAssets(accountId, false, true))[0]?.children as Record<string, unknown>[])[0]?.money, 30.123456);

  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 8, pricetime: Math.floor(now / 1000) },
  ], now);
  const remarkOnly = await updateOneBill(service, accountId, String(created.id), { remark: "只改备注" });
  assert.equal((remarkOnly.currencyConversion as Record<string, unknown>).targetAmount, 70);
  assert.equal(((await service.listAssets(accountId, false, true))[0]?.children as Record<string, unknown>[])[0]?.money, 30.123456);

  const amountChanged = await updateOneBill(service, accountId, String(created.id), { money: 5 });
  assert.equal(((upstream.syncPayloads[2]?.bills as { changelist: Record<string, unknown>[] }).changelist[0]?.money), 35);
  assert.equal((amountChanged.currencyConversion as Record<string, unknown>).targetAmount, 35);
  assert.equal(((await service.listAssets(accountId, false, true))[0]?.children as Record<string, unknown>[])[0]?.money, 65.123456);

  const historicalDiscount = await updateOneBill(service, accountId, String(created.id), { money: 10, discount: 2 });
  assert.equal(((upstream.syncPayloads[3]?.bills as { changelist: Record<string, unknown>[] }).changelist[0]?.money), 56);
  assert.equal(historicalDiscount.money, 10);
  assert.equal(historicalDiscount.discount, 2);
  assert.equal((historicalDiscount.currencyConversion as Record<string, unknown>).targetAmount, 56);
  assert.equal((historicalDiscount.currencyConversion as Record<string, unknown>).baseAmount, 56);

  const discounted = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 10,
    discount: 2,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD" },
  });
  assert.equal(((upstream.syncPayloads[4]?.bills as { changelist: Record<string, unknown>[] }).changelist[0]?.money), 64);
  assert.equal(discounted.money, 10);
  assert.equal(discounted.discount, 2);
  assert.equal((discounted.currencyConversion as Record<string, unknown>).targetAmount, 64);
  assert.equal((discounted.currencyConversion as Record<string, unknown>).baseAmount, 64);

  const explicitTarget = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 10,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD", targetAmount: 65 },
  });
  assert.equal(explicitTarget.money, 10);
  assert.deepEqual(explicitTarget.currencyConversion, {
    sourceCurrency: "USD",
    sourceAmount: 10,
    targetCurrency: "CNY",
    targetAmount: 65,
    baseCurrency: "CNY",
    baseAmount: 65,
  });
  await assert.rejects(
    createOneBill(service, accountId, {
      bookId: "1",
      type: 0,
      money: 10,
      categoryId: "2",
      assetId: "3",
      currencyConversion: { sourceCurrency: "USD", targetAmount: 65, baseAmount: 66 },
    }),
    (error) => error instanceof AppError && error.code === "CURRENCY_CONVERSION_INCONSISTENT",
  );

  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 1 / 3, pricetime: Math.floor(now / 1000) },
  ], now);
  const rounded = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 1,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD" },
  });
  assert.deepEqual(rounded.currencyConversion, {
    sourceCurrency: "USD",
    sourceAmount: 1,
    targetCurrency: "CNY",
    targetAmount: 0.33,
    baseCurrency: "CNY",
    baseAmount: 0.33,
  });

  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 1.125, pricetime: Math.floor(now / 1000) },
  ], now);
  const halfEven = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 1,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD" },
  });
  assert.equal((halfEven.currencyConversion as Record<string, unknown>).targetAmount, 1.12);
  assert.equal((halfEven.currencyConversion as Record<string, unknown>).baseAmount, 1.12);

  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 1.015, pricetime: Math.floor(now / 1000) },
  ], now);
  const binaryTie = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 1,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD" },
  });
  assert.equal((binaryTie.currencyConversion as Record<string, unknown>).targetAmount, 1.01);
  assert.equal((binaryTie.currencyConversion as Record<string, unknown>).baseAmount, 1.01);

  const sequential = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 0.34,
    categoryId: "2",
    assetId: "3",
    currencyConversion: { sourceCurrency: "USD" },
  });
  assert.equal((sequential.currencyConversion as Record<string, unknown>).targetAmount, 0.35);
  const sequentialUpdated = await updateOneBill(service, accountId, String(sequential.id), { money: 0.58, discount: 0.07 });
  assert.equal((sequentialUpdated.currencyConversion as Record<string, unknown>).targetAmount, 0.53);
  assert.equal((sequentialUpdated.currencyConversion as Record<string, unknown>).baseAmount, 0.53);
});

test("外币资产普通消费默认使用资产币种并保存本位币换算", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createBusinessUpstream();
  cacheBusinessContext(store, account, now, true);
  const assets = store.getCatalogCache(account.id, "assets")!;
  store.setCatalogCache(account.id, "assets", "", assets.data.map((asset) =>
    String(asset.id) === "6" ? { ...asset, money: 100 } : asset
  ), now);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const created = await createOneBill(service, accountId, {
    bookId: "1",
    type: 0,
    money: 10,
    categoryId: "2",
    assetId: "6",
  });
  const createdRaw = (upstream.syncPayloads[0]?.bills as { changelist: Record<string, unknown>[] }).changelist[0]!;
  assert.equal(createdRaw.money, 10);
  assert.equal(created.money, 10);
  assert.deepEqual(created.currencyConversion, {
    sourceCurrency: "USD",
    sourceAmount: 10,
    targetCurrency: "USD",
    targetAmount: 10,
    baseCurrency: "CNY",
    baseAmount: 70,
  });
  const createdAssets = await service.listAssets(accountId, false, true);
  const createdUsdAsset = createdAssets.flatMap(({ children }) => children as Record<string, unknown>[])
    .find(({ id }) => id === "6");
  assert.equal(createdUsdAsset?.money, 90);

  const updated = await updateOneBill(service, accountId, String(created.id), { money: 6 });
  assert.equal(((upstream.syncPayloads[1]?.bills as { changelist: Record<string, unknown>[] }).changelist[0]?.money), 6);
  assert.equal((updated.currencyConversion as Record<string, unknown>).sourceAmount, 6);
  assert.equal((updated.currencyConversion as Record<string, unknown>).baseAmount, 42);
  const updatedAssets = await service.listAssets(accountId, false, true);
  const updatedUsdAsset = updatedAssets.flatMap(({ children }) => children as Record<string, unknown>[])
    .find(({ id }) => id === "6");
  assert.equal(updatedUsdAsset?.money, 94);
});

test("转账和信用卡还款支持二选一的优惠或手续费并校验资产规则", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const upstream = createBusinessUpstream();
  const incompleteBaseId = "1770000000000100201";
  upstream.seed({
    ...bill(incompleteBaseId, "官方省略冗余本位币"),
    type: 2,
    money: 7,
    cateid: -1,
    assetid: -1,
    fromid: 3,
    targetid: 6,
    extra: { transfee: 0, curr: { ss: "CNY", sv: 7, ts: "USD", tv: 1, bv: 0 } },
  });
  cacheBusinessContext(store, account, now, true);
  const assets = store.getCatalogCache(account.id, "assets")!;
  store.setCatalogCache(account.id, "assets", "", assets.data.map((asset) =>
    String(asset.id) === "3" ? { ...asset, currency: "" } : asset
  ), now);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const transfer = await service.createTransfer(accountId, {
    bookId: "1",
    money: 10,
    discount: 2,
    fromAssetId: "3",
    targetAssetId: "4",
    tagIds: ["tag-1"],
    excludeFromBudget: true,
  });
  assert.equal(transfer.type, 2);
  assert.equal(transfer.money, 10);
  assert.equal(transfer.fee, 0);
  assert.equal(transfer.discount, 2);
  assert.equal(transfer.fromId, "3");
  assert.equal(transfer.targetId, "4");
  assert.equal(transfer.excludeFromIncomeExpense, false);
  assert.equal(transfer.excludeFromBudget, true);
  const transferPayload = upstream.syncPayloads[0]?.bills as { changelist: Record<string, unknown>[] };
  assert.deepEqual(transferPayload.changelist[0]?.extra, { transfee: -2, tags: ["tag-1"], flag: 2 });
  assert.equal(transferPayload.changelist[0]?.fromact, "储蓄卡");
  assert.equal(transferPayload.changelist[0]?.targetact, "信用卡");
  assert.equal(transferPayload.changelist[0]?.descinfo, "储蓄卡->信用卡");
  assert.equal(transferPayload.changelist[0]?.money, 8);
  assert.equal(store.getCatalogCache(account.id, "assets"), undefined);
  const listedTransfer = (await service.listBills(accountId, { bookId: "1" })).bills
    .find(({ id }) => id === transfer.id);
  assert.equal(listedTransfer?.money, 10);
  assert.equal(listedTransfer?.fee, 0);
  assert.equal(listedTransfer?.discount, 2);

  store.setCatalogCache(account.id, "books", "", [
    { bookid: "1", name: "账本", visible: 1 },
    { bookid: "2", name: "目标账本", visible: 1 },
  ], now);
  const updated = await service.updateTransfer(accountId, String(transfer.id), {
    bookId: "2",
    fee: 1,
    remark: "调整",
    excludeFromIncomeExpense: true,
  });
  assert.equal(updated.type, 2);
  assert.equal(updated.bookId, "2");
  assert.equal(updated.money, 10);
  assert.equal(updated.fee, 1);
  assert.equal(updated.discount, 0);
  assert.equal(updated.excludeFromIncomeExpense, true);
  assert.equal(updated.excludeFromBudget, true);
  const updatedTransferPayload = upstream.syncPayloads[1]?.bills as { changelist: Record<string, unknown>[] };
  assert.equal(updatedTransferPayload.changelist[0]?.money, 9);
  assert.equal(updatedTransferPayload.changelist[0]?.bookid, 2);
  assert.equal((updatedTransferPayload.changelist[0]?.extra as Record<string, unknown>).transfee, 1);
  assert.equal((updatedTransferPayload.changelist[0]?.extra as Record<string, unknown>).flag, 3);
  assert.equal(store.getCatalogCache(account.id, "assets"), undefined);

  const repayment = await service.createTransfer(accountId, {
    bookId: "1",
    money: 20,
    fee: 3,
    fromAssetId: "3",
    targetAssetId: "4",
    creditRepayment: true,
  });
  assert.equal(repayment.type, 3);
  assert.equal(repayment.money, 20);
  assert.equal(repayment.fee, 3);
  const repaymentPayload = upstream.syncPayloads[2]?.bills as { changelist: Record<string, unknown>[] };
  assert.equal(repaymentPayload.changelist[0]?.money, 17);
  assert.equal(repayment.targetId, "4");
  const ordinaryFromRepayment = await service.updateTransfer(accountId, String(repayment.id), {
    creditRepayment: false,
    targetAssetId: "6",
    money: 21,
  });
  assert.equal(ordinaryFromRepayment.type, 2);
  assert.equal(ordinaryFromRepayment.targetId, "6");
  assert.equal(ordinaryFromRepayment.money, 21);
  const updatedRepayment = await service.updateTransfer(accountId, String(repayment.id), {
    creditRepayment: true,
    targetAssetId: "4",
    money: 20,
    discount: 2,
  });
  assert.equal(updatedRepayment.type, 3);
  assert.equal(updatedRepayment.money, 20);
  assert.equal(updatedRepayment.fee, 0);
  assert.equal(updatedRepayment.discount, 2);
  const updatedRepaymentPayload = upstream.syncPayloads[4]?.bills as { changelist: Record<string, unknown>[] };
  assert.equal(updatedRepaymentPayload.changelist[0]?.money, 18);
  assert.equal((updatedRepaymentPayload.changelist[0]?.extra as Record<string, unknown>).transfee, -2);
  const ordinaryTransfer = await service.updateTransfer(accountId, String(repayment.id), { creditRepayment: false });
  assert.equal(ordinaryTransfer.type, 2);

  for (const [input, code] of [
    [{ bookId: "1", money: 1, fromAssetId: "3", targetAssetId: "3" }, "TRANSFER_ASSET_SAME"],
    [{ bookId: "1", money: 1, fromAssetId: "3", targetAssetId: "5" }, "TRANSFER_DEBT_LOAN_UNSUPPORTED"],
    [{ bookId: "1", money: 1, fromAssetId: "3", targetAssetId: "7" }, "TRANSFER_DEBT_LOAN_UNSUPPORTED"],
  ] as const) {
    await assert.rejects(
      service.createTransfer(accountId, input),
      (error) => error instanceof AppError && error.code === code,
    );
  }
  const crossCurrency = await service.createTransfer(accountId, {
    bookId: "1",
    money: 7,
    fromAssetId: "3",
    targetAssetId: "6",
  });
  assert.deepEqual(crossCurrency.currencyConversion, {
    sourceCurrency: "CNY",
    sourceAmount: 7,
    targetCurrency: "USD",
    targetAmount: 1,
    baseCurrency: "CNY",
    baseAmount: 7,
  });
  const crossCurrencyDiscount = await service.createTransfer(accountId, {
    bookId: "1",
    money: 7,
    discount: 1,
    fromAssetId: "3",
    targetAssetId: "6",
  });
  assert.equal(crossCurrencyDiscount.money, 7);
  assert.equal(crossCurrencyDiscount.discount, 1);
  assert.deepEqual(crossCurrencyDiscount.currencyConversion, {
    sourceCurrency: "CNY",
    sourceAmount: 7,
    targetCurrency: "USD",
    targetAmount: 1,
    baseCurrency: "CNY",
    baseAmount: 7,
  });
  const zeroConverted = await service.createTransfer(accountId, {
    bookId: "1",
    money: 1,
    fee: 1,
    fromAssetId: "3",
    targetAssetId: "6",
    currencyConversion: { targetAmount: 0, baseAmount: 0 },
  });
  assert.equal(zeroConverted.money, 1);
  assert.equal(zeroConverted.fee, 1);
  assert.deepEqual(zeroConverted.currencyConversion, {
    sourceCurrency: "CNY",
    sourceAmount: 1,
    targetCurrency: "USD",
    targetAmount: 0,
    baseCurrency: "CNY",
    baseAmount: 0,
  });
  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 14, pricetime: Math.floor(now / 1000) },
  ], now);
  const remarkOnly = await service.updateTransfer(accountId, String(crossCurrency.id), { remark: "只改备注" });
  assert.deepEqual(remarkOnly.currencyConversion, crossCurrency.currencyConversion);
  const historicalRate = await service.updateTransfer(accountId, String(crossCurrency.id), { money: 14 });
  assert.deepEqual(historicalRate.currencyConversion, {
    sourceCurrency: "CNY",
    sourceAmount: 14,
    targetCurrency: "USD",
    targetAmount: 2,
    baseCurrency: "CNY",
    baseAmount: 14,
  });
  const historicalFee = await service.updateTransfer(accountId, String(crossCurrency.id), { fee: 1 });
  assert.equal(historicalFee.money, 14);
  assert.equal(historicalFee.fee, 1);
  assert.deepEqual(historicalFee.currencyConversion, {
    sourceCurrency: "CNY",
    sourceAmount: 14,
    targetCurrency: "USD",
    targetAmount: 1.86,
    baseCurrency: "CNY",
    baseAmount: 13,
  });
  const incompleteBaseUpdated = await service.updateTransfer(accountId, incompleteBaseId, { money: 14 });
  assert.deepEqual(incompleteBaseUpdated.currencyConversion, {
    sourceCurrency: "CNY",
    sourceAmount: 14,
    targetCurrency: "USD",
    targetAmount: 2,
  });
  const incompleteBasePayload = upstream.syncPayloads.at(-1)?.bills as { changelist: Record<string, unknown>[] };
  assert.deepEqual((incompleteBasePayload.changelist[0]?.extra as Record<string, unknown>).curr, {
    ss: "CNY",
    sv: 14,
    ts: "USD",
    tv: 2,
  });
  await assert.rejects(
    service.createTransfer(accountId, {
      bookId: "1",
      money: 1,
      fromAssetId: "4",
      targetAssetId: "3",
      creditRepayment: true,
    }),
    (error) => error instanceof AppError && error.code === "CREDIT_ASSET_REQUIRED",
  );
  await assert.rejects(
    service.createTransfer(accountId, {
      bookId: "1",
      money: 10,
      fee: 1,
      discount: 1,
      fromAssetId: "3",
      targetAssetId: "4",
    }),
    (error) => error instanceof AppError && error.code === "INVALID_BILL_ADJUSTMENT",
  );
});

test("账单所有者、旧关系和已报销字段锁在共享入口生效", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const otherId = "1770000000000199001";
  const legacyOwnerId = "1770000000000199002";
  const refundedId = "1770000000000199003";
  const refundChildId = "1770000000000199004";
  const reimbursedId = "1770000000000199005";
  const noCategoryId = "1770000000000199006";
  const emptyPendingId = "1770000000000199007";
  const upstream = createBusinessUpstream();
  upstream.seed({ ...bill(otherId, "其他用户"), userid: "uid-other" });
  upstream.seed({ ...bill(legacyOwnerId, "旧账单"), userid: "" });
  upstream.seed({ ...bill(refundedId, "旧退款源"), extra: { refundid: refundChildId, refundv: 2 } });
  upstream.seed({ ...bill(refundChildId, "旧退款"), type: 20, extra: { refundsid: refundedId } });
  upstream.seed({ ...bill(reimbursedId, "旧报销源"), type: 5, extra: { baoxiaoed: 1 } });
  upstream.seed({ ...bill(noCategoryId, "无分类"), cateid: -1 });
  upstream.seed({ ...bill(emptyPendingId, "无所有者待报销"), userid: "", type: 5 });
  cacheBusinessContext(store, account, now, true);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  await assert.rejects(
    updateOneBill(service, accountId, otherId, { remark: "越权" }),
    (error) => error instanceof AppError && error.code === "BILL_OWNERSHIP_MISMATCH",
  );
  const updatedLegacy = await updateOneBill(service, accountId, legacyOwnerId, { remark: "允许更新" });
  assert.equal(updatedLegacy.remark, "允许更新");
  const legacyPayload = upstream.syncPayloads[0]?.bills as { changelist: Record<string, unknown>[] };
  assert.equal(legacyPayload.changelist[0]?.userid, account.uid);
  await assert.rejects(
    service.reimburseBills(accountId, { sourceBillIds: [emptyPendingId], money: 1 }),
    (error) => error instanceof AppError && error.code === "BILL_OWNERSHIP_MISMATCH",
  );
  await assert.rejects(
    updateOneBill(service, accountId, refundedId, { reimbursable: true }),
    (error) => error instanceof AppError && error.code === "REFUNDED_BILL_TYPE_LOCKED",
  );
  await assert.rejects(
    updateOneBill(service, accountId, reimbursedId, { assetId: "3" }),
    (error) => error instanceof AppError && error.code === "REIMBURSED_BILL_FIELD_LOCKED",
  );
  await assert.rejects(
    service.createRefund(accountId, { sourceBillId: noCategoryId, money: 1 }),
    (error) => error instanceof AppError && error.code === "REFUND_SOURCE_CATEGORY_MISSING",
  );
  assert.deepEqual(await deleteOneBill(service, accountId, refundedId, true), {
    deleted: [{ billId: refundedId, relatedBillIds: [refundChildId] }],
  });
});

test("退款整组落库并支持修改、单独删除和显式关联删除", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const sourceId = "1770000000000200001";
  const refundLimitedId = "1770000000000200002";
  const debtId = "1770000000000200003";
  const upstream = createBusinessUpstream();
  upstream.seed({ ...bill(sourceId, "待退款"), assetid: 3 });
  upstream.seed({
    ...bill(refundLimitedId, "退款已满"),
    extra: {
      rfds: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
        (1_770_000_000_006_000_000n + BigInt(index)).toString(),
        0.1,
      ])),
    },
  });
  upstream.seed({ ...bill(debtId, "债务记录"), type: 4 });
  cacheBusinessContext(store, account, now, true);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  await assert.rejects(
    service.createRefund(accountId, { sourceBillId: refundLimitedId, money: 1 }),
    (error) => error instanceof AppError && error.code === "REFUND_COUNT_LIMIT_REACHED",
  );
  await assert.rejects(
    deleteOneBill(service, accountId, debtId),
    (error) => error instanceof AppError && error.code === "BILL_SCENARIO_UNSUPPORTED",
  );

  const refund = await service.createRefund(accountId, { sourceBillId: sourceId, money: 3, remark: "部分退款" });
  const refundId = String(refund.id);
  assert.equal(refund.type, 20);
  assert.equal(refund.time, Math.floor(now / 1000) + 1);
  assert.equal(refund.refundSourceBillId, sourceId);
  assert.equal(refund.assetId, "3");
  assert.deepEqual((await service.getBill(accountId, sourceId)).refundBillIds, [refundId]);
  assert.equal(store.getCatalogCache(account.id, "assets"), undefined);

  const updated = await service.updateRefund(accountId, refundId, { money: 4, remark: "改为四元" });
  assert.equal(updated.money, 4);
  const overage = await service.createRefund(accountId, { sourceBillId: sourceId, money: 7, assetId: null });
  assert.equal(overage.money, 7);
  assert.equal(overage.assetId, null);
  await assert.rejects(
    deleteOneBill(service, accountId, sourceId),
    (error) => error instanceof AppError && error.code === "RELATED_BILLS_EXIST",
  );

  assert.deepEqual(await service.deleteRefund(accountId, refundId), { deleted: true, refundBillId: refundId });
  assert.deepEqual(await service.deleteRefund(accountId, String(overage.id)), { deleted: true, refundBillId: String(overage.id) });
  assert.deepEqual((await service.getBill(accountId, sourceId)).refundBillIds, undefined);

  const related = await service.createRefund(accountId, { sourceBillId: sourceId, money: 2 });
  assert.deepEqual(await deleteOneBill(service, accountId, sourceId, true), {
    deleted: [{ billId: sourceId, relatedBillIds: [String(related.id)] }],
  });
  assert.equal(store.getCatalogCache(account.id, "assets"), undefined);
});

test("单条关系删除拒绝源账单消失或同源其他关系丢失", async (t) => {
  for (const [index, loss] of ["source", "sibling"].entries()) {
    const { store, accountId, account } = setup();
    t.after(() => store.close());
    const sourceId = String(1_770_000_000_000_210_001n + BigInt(index * 10));
    const refundId = String(BigInt(sourceId) + 1n);
    const siblingId = String(BigInt(sourceId) + 2n);
    const upstream = createBusinessUpstream();
    upstream.seed({
      ...bill(sourceId, "退款源账单"),
      extra: { rfds: { [refundId]: 2, [siblingId]: 3 } },
    });
    upstream.seed({ ...bill(refundId, "待删除退款"), type: 20, extra: { refundsid: sourceId } });
    upstream.seed({ ...bill(siblingId, "同源退款"), type: 20, extra: { refundsid: sourceId } });
    cacheBusinessContext(store, account, Date.UTC(2026, 7, 18, 4), true);
    let sabotaged = false;
    const fetch: QianjiFetch = async (input, init) => {
      const response = await upstream.fetch(input, init);
      if (new URL(String(input)).pathname === "/bill/syncall" && !sabotaged) {
        sabotaged = true;
        const form = new URLSearchParams();
        form.set("v", JSON.stringify({ bills: { dellist: [loss === "source" ? sourceId : siblingId] } }));
        await upstream.fetch(input, { ...init, body: form });
      }
      return response;
    };
    const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => Date.UTC(2026, 7, 18, 4));

    await assert.rejects(
      service.deleteRefund(accountId, refundId),
      (error) => error instanceof AppError &&
        error.code === "WRITE_CONFIRMATION_FAILED" &&
        error.message.includes("其他关联保持不变"),
    );
  }
});

test("退款的非金额修改保留历史换算，金额变化才按当前价格重算", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = 1_770_000_000_000;
  const sourceId = "1770000000000200011";
  const upstream = createBusinessUpstream();
  upstream.seed({
    ...bill(sourceId, "美元支出"),
    extra: { curr: { ss: "USD", sv: 10, bs: "CNY", bv: 70 } },
  });
  cacheBusinessContext(store, account, now, true);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  const created = await service.createRefund(accountId, { sourceBillId: sourceId, money: 3, remark: "原备注" });
  assert.equal((created.currencyConversion as Record<string, unknown>).baseAmount, 21);
  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 8, pricetime: Math.floor(now / 1000) },
  ], now);
  const remarkOnly = await service.updateRefund(accountId, String(created.id), { remark: "新备注" });
  assert.equal((remarkOnly.currencyConversion as Record<string, unknown>).baseAmount, 21);
  const moneyChanged = await service.updateRefund(accountId, String(created.id), { money: 4 });
  assert.equal((moneyChanged.currencyConversion as Record<string, unknown>).baseAmount, 32);
});

test("create_refund 拒绝返回与请求完整指纹不一致的新退款", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 15, 4);
  const sourceId = "1770000000000240002";
  const upstream = createBusinessUpstream();
  upstream.seed(bill(sourceId, "指纹不一致"));
  cacheBusinessContext(store, account, now, false);
  const fetch: QianjiFetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/bill/refund2") return upstream.fetch(input, init);
    const form = new URLSearchParams(String(init?.body));
    const payload = parseQianjiJson(form.get("v") ?? "") as Record<string, unknown>;
    payload.remark = "上一笔退款";
    form.set("v", JSON.stringify(payload));
    return upstream.fetch(input, { ...init, body: form });
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => now);

  await assert.rejects(
    service.createRefund(accountId, { sourceBillId: sourceId, money: 2, remark: "当前退款" }),
    (error) => error instanceof AppError &&
      error.code === "WRITE_CONFIRMATION_FAILED" &&
      error.message.includes("完整指纹"),
  );
  const refunds = (await service.listBills(accountId, { allBooks: true, type: 20 })).bills;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0]?.remark, "上一笔退款");
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-15", used: 1 });
});

test("退款完整指纹同时校验子账单的源账单关系", () => {
  assert.equal(refundPatchApplied({
    type: 20,
    money: 2,
    time: 1,
    assetid: -1,
    remark: "退款",
    extra: { refundsid: "1770000000000240099", tags: [] },
  }, {
    sourceBillId: "1770000000000240002",
    money: 2,
    time: 1,
    assetId: "-1",
    remark: "退款",
    tagIds: [],
  }), false);
});

test("退款远端成功但写后 pull 失败时保留响应且仍计写入额度", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 12, 4);
  const sourceId = "1770000000000250001";
  const upstream = createBusinessUpstream();
  upstream.seed(bill(sourceId, "确认失败"));
  cacheBusinessContext(store, account, now, false);
  let refundSucceeded = false;
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/syncv2/pull" && refundSucceeded) throw new Error("pull unavailable");
    const response = await upstream.fetch(input, init);
    if (path === "/bill/refund2") refundSucceeded = true;
    return response;
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => now);

  await assert.rejects(
    service.createRefund(accountId, { sourceBillId: sourceId, money: 2 }),
    (error) => error instanceof AppError &&
      error.code === "WRITE_CONFIRMATION_FAILED" &&
      error.message.includes("refresh_cache"),
  );
  assert.equal(store.countBills(account.id), 2);
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-12", used: 1 });
});

test("批量报销一次计额、保存全部账单、失效资产缓存并用源账单取消", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 12, 4);
  const sourceA = "1770000000000300001";
  const sourceB = "1770000000000300002";
  const upstream = createBusinessUpstream();
  upstream.seed({
    ...bill(sourceA, "出差一"),
    type: 5,
    money: 10,
    extra: { curr: { ss: "USD", sv: 10, bs: "CNY", bv: 70 } },
  });
  upstream.seed({
    ...bill(sourceB, "出差二"),
    type: 5,
    money: 20,
    extra: { curr: { ss: "USD", sv: 20, bs: "CNY", bv: 140 } },
  });
  cacheBusinessContext(store, account, now, false);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: upstream.fetch }), () => now);

  await assert.rejects(
    service.reimburseBills(accountId, {
      sourceBillIds: [sourceA, sourceB],
      money: MAX_MONEY + 0.01,
    }),
    (error) => error instanceof AppError && error.code === "INVALID_MONEY" && error.message.includes("报销总金额"),
  );

  const result = await service.reimburseBills(accountId, {
    sourceBillIds: [sourceB, sourceA],
    money: 12,
    assetId: "3",
    remark: "差旅报销",
    currencyConversion: { targetAmount: 84, baseAmount: 84 },
  });
  assert.equal(result.bills.length, 4);
  const reimbursementChildren = result.bills.filter(({ type }) => type === 21);
  const reimbursementCurrencies = Object.fromEntries(reimbursementChildren.map((child) => [
    child.reimbursementSourceBillId,
    child.currencyConversion,
  ]));
  assert.deepEqual(reimbursementCurrencies, {
    [sourceA]: { sourceCurrency: "USD", sourceAmount: 10, targetCurrency: "CNY", targetAmount: 70, baseCurrency: "CNY", baseAmount: 70 },
    [sourceB]: { sourceCurrency: "USD", sourceAmount: 2, targetCurrency: "CNY", targetAmount: 14, baseCurrency: "CNY", baseAmount: 14 },
  });
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-12", used: 1 });
  assert.equal(store.getCatalogCache(account.id, "assets"), undefined);
  assert.equal((await service.getBill(accountId, sourceA)).reimbursementBillIds instanceof Array, true);
  const overage = await service.reimburseBills(accountId, {
    sourceBillIds: [sourceA],
    money: 10,
    confirmReimbursementUpgrade: true,
  });
  assert.equal(overage.bills.length, 2);
  const overageChild = overage.bills.find(({ type }) => type === 21)!;
  assert.deepEqual(overageChild.currencyConversion, {
    sourceCurrency: "USD",
    sourceAmount: 10,
    baseCurrency: "CNY",
    baseAmount: 70,
  });
  assert.deepEqual(await service.deleteReimbursement(accountId, String(overageChild.id)), {
    deleted: true,
    reimbursementBillId: String(overageChild.id),
  });
  assert.equal(((await service.getBill(accountId, sourceA)).reimbursementBillIds as string[]).length, 1);

  assert.deepEqual(await service.cancelReimbursements(accountId, [sourceA, sourceB]), {
    cancelled: true,
    sourceBillIds: [sourceA, sourceB],
  });
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-12", used: 4 });
  assert.equal((await service.getBill(accountId, sourceA)).reimbursementBillIds, undefined);
  assert.deepEqual(upstream.cancelledSourceIds, [sourceA, sourceB]);
});

test("新版报销迁移必须明确同意，并在迁移后重新校验且只重试一次", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 17, 4);
  const sourceId = "1770000000000310001";
  const upstream = createBusinessUpstream();
  upstream.seed({ ...bill(sourceId, "待迁移报销"), type: 5, money: 10 });
  cacheBusinessContext(store, account, now, false);
  let reimbursementAttempts = 0;
  let upgradeCalls = 0;
  let upgraded = false;
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/baoxiao/baoxiao") {
      reimbursementAttempts += 1;
      if (!upgraded) {
        return Response.json({ ec: 8888, em: '{"msg":"请升级到最新的公测版本"}', data: {} });
      }
    }
    if (path === "/baoxiao/upgradev2") {
      upgradeCalls += 1;
      upgraded = true;
      return ok({ v: 1 });
    }
    return upstream.fetch(input, init);
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => now);
  const input = { sourceBillIds: [sourceId], money: 4 };

  await assert.rejects(
    service.reimburseBills(accountId, input),
    (error) => error instanceof AppError &&
      error.code === "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED" &&
      error.message.includes("旧版本将不能继续使用报销") &&
      error.message.includes("confirmReimbursementUpgrade") &&
      error.message.includes("明确同意"),
  );
  assert.equal(reimbursementAttempts, 1);
  assert.equal(upgradeCalls, 0);
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-17", used: 0 });

  const result = await service.reimburseBills(accountId, { ...input, confirmReimbursementUpgrade: true });
  assert.equal(result.bills.length, 2);
  assert.equal(reimbursementAttempts, 3);
  assert.equal(upgradeCalls, 1);
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-17", used: 1 });
});

test("迁移成功但报销失败时明确报告部分成功且不重复迁移", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 17, 4);
  const sourceId = "1770000000000310002";
  const upstream = createBusinessUpstream();
  upstream.seed({ ...bill(sourceId, "迁移后失败"), type: 5, money: 10 });
  cacheBusinessContext(store, account, now, false);
  const getBill = store.getBill.bind(store);
  let failReload = false;
  store.getBill = ((targetAccountId, billId) => {
    if (failReload) throw new Error("internal_table_name");
    return getBill(targetAccountId, billId);
  }) as typeof store.getBill;
  let reimbursementAttempts = 0;
  let upgradeCalls = 0;
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/baoxiao/baoxiao") {
      reimbursementAttempts += 1;
      return reimbursementAttempts === 1
        ? Response.json({ ec: 8888, em: '{"msg":"请升级到最新的公测版本"}', data: {} })
        : Response.json({ ec: 8888, em: '{"msg":"报销失败"}', data: {} });
    }
    if (path === "/baoxiao/upgradev2") {
      upgradeCalls += 1;
      failReload = true;
      return ok(1);
    }
    return upstream.fetch(input, init);
  };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch }), () => now);

  await assert.rejects(
    service.reimburseBills(accountId, {
      sourceBillIds: [sourceId],
      money: 4,
      confirmReimbursementUpgrade: true,
    }),
    (error) => error instanceof AppError &&
      error.code === "REIMBURSEMENT_UPGRADED_BUT_FAILED" &&
      error.message.includes("迁移已完成") &&
      error.message.includes("本次报销未完成") &&
      error.message.includes("请勿再次迁移") &&
      error.message.includes("服务暂时不可用") &&
      !error.message.includes("internal_table_name"),
  );
  assert.equal(reimbursementAttempts, 1);
  assert.equal(upgradeCalls, 1);
  assert.deepEqual(store.getWriteQuota(account.id), { date: "2026-08-17", used: 0 });
});

function cacheBusinessContext(store: Store, account: QianjiAccount, now: number, vip: boolean): void {
  store.setUserCache(account.id, {
    id: account.uid,
    viptype: vip ? 4 : -1,
    vipstart: vip ? Math.floor(now / 1000) - 1 : 0,
    vipend: vip ? Math.floor(now / 1000) + 3600 : 0,
    __baseCurrency: "CNY",
    __multiCurrencyEnabled: true,
  }, now);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "账本", visible: 1 }], now);
  store.setCatalogCache(account.id, "assets", "", [
    { id: "3", name: "储蓄卡", currency: "CNY", type: 1, stype: 12, status: 0 },
    { id: "4", name: "信用卡", currency: "CNY", type: 2, stype: 21, status: 0 },
    { id: "5", name: "借入", currency: "CNY", type: 5, stype: 51, status: 0 },
    { id: "6", name: "美元账户", currency: "USD", type: 1, stype: 12, status: 0 },
    { id: "7", name: "债务汇总", currency: "CNY", type: 6, stype: 61, status: 0 },
  ], now);
  store.setCatalogCache(account.id, "categories", "1", [
    { id: "20", name: "支出", type: 0, sublist: [{ id: "2", name: "餐饮", type: 0, parentid: "20" }] },
    { id: "7", name: "收入", type: 1 },
  ], now);
  store.setCatalogCache(account.id, "tags", "", [
    { id: "tag-1", name: "标签", status: 1, groupId: "", groupName: "" },
  ], now);
  store.setCatalogCache(account.id, "currencies", "", [
    { symbol: "CNY", baseprice: 1, pricetime: Math.floor(now / 1000) },
    { symbol: "USD", baseprice: 7, pricetime: Math.floor(now / 1000) },
  ], now);
}

function createBusinessUpstream(): {
  fetch: QianjiFetch;
  syncPayloads: Array<Record<string, unknown>>;
  cancelledSourceIds: string[];
  seed(value: Record<string, unknown>): void;
} {
  const bills = new Map<string, Record<string, unknown>>();
  const pendingChanges = new Map<string, Record<string, unknown>>();
  const pendingDeletes = new Set<string>();
  const syncPayloads: Array<Record<string, unknown>> = [];
  const cancelledSourceIds: string[] = [];
  let nextRelatedId = 1_770_000_000_005_000_000n;
  let cursor = 0;
  const exactId = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);
  const clone = (value: Record<string, unknown>): Record<string, unknown> =>
    parseQianjiJson(JSON.stringify(value)) as Record<string, unknown>;
  const save = (value: Record<string, unknown>): void => {
    const copy = clone(value);
    const id = exactId(copy.id);
    bills.set(id, copy);
    pendingChanges.set(id, copy);
    pendingDeletes.delete(id);
  };
  const remove = (id: string): void => {
    bills.delete(id);
    pendingChanges.delete(id);
    pendingDeletes.add(id);
  };
  const relationIds = (value: unknown): string[] =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const removeRefundRelation = (refundId: string): void => {
    const refund = bills.get(refundId);
    const extra = refund?.extra as Record<string, unknown> | undefined;
    const sourceId = extra?.refundsid === undefined ? undefined : exactId(extra.refundsid);
    if (!sourceId) return;
    const source = bills.get(sourceId);
    if (!source) return;
    const sourceExtra = { ...((source.extra as Record<string, unknown> | undefined) ?? {}) };
    const rfds = { ...((sourceExtra.rfds as Record<string, unknown> | undefined) ?? {}) };
    delete rfds[refundId];
    if (Object.keys(rfds).length > 0) sourceExtra.rfds = rfds;
    else delete sourceExtra.rfds;
    save({ ...source, extra: sourceExtra });
  };
  const removeReimbursementRelation = (reimbursementId: string): void => {
    const reimbursement = bills.get(reimbursementId);
    const extra = reimbursement?.extra as Record<string, unknown> | undefined;
    const sourceId = extra?.bxsid === undefined ? undefined : exactId(extra.bxsid);
    if (!sourceId) return;
    const source = bills.get(sourceId);
    if (!source) return;
    const sourceExtra = { ...((source.extra as Record<string, unknown> | undefined) ?? {}) };
    const bxs = { ...((sourceExtra.bxs as Record<string, unknown> | undefined) ?? {}) };
    delete bxs[reimbursementId];
    if (Object.keys(bxs).length > 0) sourceExtra.bxs = bxs;
    else delete sourceExtra.bxs;
    save({ ...source, extra: sourceExtra });
  };

  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const form = new URLSearchParams(String(init?.body));
    if (path === "/book/list") return ok({ list: [{ bookid: 1, name: "账本", visible: 1 }] });
    if (path === "/asset/list") return ok({ list: form.get("status") === "0" ? [
      { id: 3, name: "储蓄卡", currency: "CNY", type: 1, stype: 12, status: 0 },
      { id: 4, name: "信用卡", currency: "CNY", type: 2, stype: 21, status: 0 },
      { id: 5, name: "借入", currency: "CNY", type: 5, stype: 51, status: 0 },
      { id: 6, name: "美元账户", currency: "USD", type: 1, stype: 12, status: 0 },
      { id: 7, name: "债务汇总", currency: "CNY", type: 6, stype: 61, status: 0 },
    ] : [] });
    if (path === "/category/listv2") return ok({ list: [
      { id: 20, name: "支出", type: 0, level: 1, parentid: -1, sublist: [
        { id: 2, name: "餐饮", type: 0, level: 2, parentid: 20 },
      ] },
      { id: 7, name: "收入", type: 1, level: 1, parentid: -1 },
    ] });
    if (path === "/tag/list") return ok({ list: [{ id: "", name: "", tags: [{ id: "tag-1", name: "标签", status: 1 }] }] });
    if (path === "/syncv2/pull") {
      cursor += 1;
      const changes = [...pendingChanges.values()];
      const deletes = [...pendingDeletes];
      pendingChanges.clear();
      pendingDeletes.clear();
      return ok(pullData({ changes, deletes, lasttimes: { cursor } }));
    }
    if (path === "/bill/syncall") {
      const payload = parseQianjiJson(form.get("v") ?? "") as Record<string, unknown>;
      syncPayloads.push(payload);
      const group = payload.bills as Record<string, unknown>;
      const newIds: string[] = [];
      const updateIds: string[] = [];
      const deleteIds: string[] = [];
      for (const change of (group.changelist as Record<string, unknown>[] | undefined) ?? []) {
        const id = exactId(change.id);
        (bills.has(id) ? updateIds : newIds).push(id);
        save(change);
      }
      for (const value of (group.dellist as unknown[] | undefined) ?? []) {
        const id = exactId(value);
        deleteIds.push(id);
        const current = bills.get(id);
        const extra = current?.extra as Record<string, unknown> | undefined;
        if (Number(current?.type) === 20) removeRefundRelation(id);
        if (Number(current?.type) === 21) removeReimbursementRelation(id);
        for (const relatedId of [...relationIds(extra?.rfds), ...relationIds(extra?.bxs)]) remove(relatedId);
        remove(id);
      }
      return syncOk(newIds, updateIds, deleteIds);
    }
    if (path === "/bill/refund2") {
      const sourceId = form.get("did")!;
      const source = bills.get(sourceId);
      if (!source) throw new Error("refund source missing");
      const payload = parseQianjiJson(form.get("v") ?? "") as Record<string, unknown>;
      const refundId = payload.billid === undefined ? (nextRelatedId++).toString() : exactId(payload.billid);
      const sourceExtra = { ...((source.extra as Record<string, unknown> | undefined) ?? {}) };
      const rfds = { ...((sourceExtra.rfds as Record<string, unknown> | undefined) ?? {}), [refundId]: payload.money };
      sourceExtra.rfds = rfds;
      const updatedSource = { ...source, extra: sourceExtra };
      const refund = {
        id: refundId,
        userid: source.userid,
        bookid: source.bookid,
        time: payload.time,
        type: 20,
        money: payload.money,
        remark: payload.remark ?? "",
        status: 2,
        cateid: source.cateid,
        assetid: payload.assetid ?? -1,
        fromid: -1,
        targetid: -1,
        createtime: (bills.get(refundId)?.createtime ?? payload.time),
        updatetime: payload.time,
        platform: 0,
        images: [],
        extra: {
          refundsid: sourceId,
          tags: payload.tags ?? [],
          ...(typeof payload.currency === "string" ? { curr: parseQianjiJson(payload.currency) } : {}),
        },
      };
      save(updatedSource);
      save(refund);
      return ok({ list: [updatedSource, refund] });
    }
    if (path === "/baoxiao/baoxiao") {
      const allocations = parseQianjiJson(form.get("v") ?? "") as Record<string, { money?: number; curr?: Record<string, unknown> }>;
      const changed: Record<string, unknown>[] = [];
      for (const [sourceId, allocation] of Object.entries(allocations)) {
        const source = bills.get(sourceId);
        if (!source) throw new Error("reimbursement source missing");
        const money = allocation.curr ? Number(allocation.curr.sv) : Number(allocation.money);
        const childId = (nextRelatedId++).toString();
        const sourceExtra = { ...((source.extra as Record<string, unknown> | undefined) ?? {}) };
        sourceExtra.bxs = { ...((sourceExtra.bxs as Record<string, unknown> | undefined) ?? {}), [childId]: money };
        const updatedSource = { ...source, extra: sourceExtra };
        const child = {
          ...bill(childId, "报销", Number(source.time)),
          type: 21,
          money,
          cateid: source.cateid,
          assetid: form.get("did") ?? -1,
          extra: {
            bxsid: sourceId,
            tags: JSON.parse(form.get("tags") ?? "[]"),
            ...(allocation.curr ? { curr: allocation.curr } : {}),
          },
        };
        save(updatedSource);
        save(child);
        changed.push(updatedSource, child);
      }
      return ok({ asset: form.has("did") ? { id: form.get("did") } : undefined, bills: changed });
    }
    if (path === "/baoxiao/cancelbaoxiao") {
      const ids = parseQianjiJson(form.get("v") ?? "") as unknown[];
      for (const value of ids) {
        const sourceId = exactId(value);
        cancelledSourceIds.push(sourceId);
        const source = bills.get(sourceId);
        const sourceExtra = { ...((source?.extra as Record<string, unknown> | undefined) ?? {}) };
        for (const childId of relationIds(sourceExtra.bxs)) remove(childId);
        delete sourceExtra.bxs;
        if (source) save({ ...source, extra: sourceExtra });
      }
      return ok({});
    }
    throw new Error(`Unexpected business fixture path: ${path}`);
  };

  return {
    fetch,
    syncPayloads,
    cancelledSourceIds,
    seed: save,
  };
}

function createStatefulUpstream(transactionType: 0 | 1 = 0): {
  fetch: QianjiFetch;
  payloads: Record<string, unknown>[];
  addUnknownFields(): void;
  ignoreNextChange(): void;
} {
  let upstreamBill: Record<string, unknown> | undefined;
  let pendingDelete: string | undefined;
  let ignoreNextChange = false;
  let cursor = 0;
  const payloads: Record<string, unknown>[] = [];
  const fetch: QianjiFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const form = new URLSearchParams(String(init?.body));
    if (path === "/book/list") return ok({ list: [
      { bookid: 1, name: "Default", visible: 1, type: 0, membercount: 1, expired: 0 },
      { bookid: 2, name: "Second", visible: 1, type: 0, membercount: 1, expired: 0 },
    ] });
    if (path === "/asset/list") return ok({ list: form.get("status") === "0" ? [{ id: 3, name: "Cash", money: 100, currency: "CNY", type: 0, stype: 0, status: 0, incount: 1, groupid: -1 }] : [] });
    if (path === "/category/listv2") return ok({ list: form.get("bookid") === "2"
      ? [{ id: 8, name: "Second Category", type: transactionType, level: 1, parentid: -1 }]
      : [{ id: 2, name: "Category", type: transactionType, level: 1, parentid: -1 }] });
    if (path === "/tag/list") return ok({ list: [
      { id: "", name: "默认组", tags: [{ id: "tag-1", name: "Daily", status: 1 }] },
    ] });
    if (path === "/syncv2/pull") {
      cursor += 1;
      const deletes = pendingDelete ? [pendingDelete] : [];
      pendingDelete = undefined;
      return ok(pullData({ changes: upstreamBill ? [upstreamBill] : [], deletes, lasttimes: { cursor } }));
    }
    if (path === "/bill/syncall") {
      const payload = parseQianjiJson(form.get("v") ?? "") as Record<string, unknown>;
      payloads.push(payload);
      const bills = payload.bills as Record<string, unknown>;
      const changes = bills.changelist as Record<string, unknown>[] | undefined;
      const deletes = bills.dellist as string[] | undefined;
      if (changes) {
        const id = JSON.stringify(changes[0]!.id);
        const update = upstreamBill !== undefined && JSON.stringify(upstreamBill.id) === id;
        if (!ignoreNextChange) {
          upstreamBill = parseQianjiJson(JSON.stringify(changes[0])) as Record<string, unknown>;
        }
        ignoreNextChange = false;
        return syncOk(update ? [] : [id], update ? [id] : [], []);
      }
      const id = JSON.stringify(deletes?.[0]);
      if (!id) throw new Error("delete id missing");
      upstreamBill = undefined;
      pendingDelete = id;
      return syncOk([], [], [id]);
    }
    throw new Error(`Unexpected fixture path: ${path}`);
  };
  return {
    fetch,
    payloads,
    addUnknownFields() {
      if (!upstreamBill) throw new Error("bill missing");
      upstreamBill.server_only = "preserve-me";
      upstreamBill.server_number = parseQianjiJson("1770000000000999999");
      upstreamBill.category = { name: "display-only" };
      upstreamBill.extra = {
        ...(upstreamBill.extra as Record<string, unknown> | undefined),
        opaque: "preserve-me",
      };
    },
    ignoreNextChange() {
      ignoreNextChange = true;
    },
  };
}

function createWriteErrorUpstream(result: { conf_ids: readonly string[]; has_failed: boolean }): QianjiFetch {
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    const status = new URLSearchParams(String(init?.body)).get("status");
    if (path === "/book/list") return ok({ list: [{ bookid: 1, name: "B", visible: 1, type: 0, membercount: 1, expired: 0 }] });
    if (path === "/asset/list") return ok({ list: status === "0" ? [] : [] });
    if (path === "/category/listv2") return ok({ list: [{ id: 2, name: "C", type: 0, level: 1, parentid: -1 }] });
    if (path === "/tag/list") return ok({ list: [] });
    if (path === "/bill/syncall") {
      const form = new URLSearchParams(String(init?.body));
      const payload = parseQianjiJson(form.get("v") ?? "") as { bills: { changelist: Array<{ id: unknown }> } };
      const requestedId = JSON.stringify(payload.bills.changelist[0]!.id);
      return syncOk([], [], [], result.conf_ids.length > 0 ? [requestedId] : [], result.has_failed);
    }
    throw new Error(`Unexpected fixture path: ${path}`);
  };
}

function ok(data: unknown): Response {
  return Response.json({ ec: 200, data });
}

function syncOk(
  newIds: string[],
  updateIds: string[],
  deleteIds: string[],
  conflictIds: string[] = [],
  failed = false,
): Response {
  return ok({
    sync_result: {
      bill: {
        new_ids: newIds,
        update_ids: updateIds,
        del_ids: deleteIds,
        conf_ids: conflictIds,
        has_failed: failed,
      },
    },
  });
}
