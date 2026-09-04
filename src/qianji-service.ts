import { randomUUID } from "node:crypto";

import {
  applyPatch,
  billAdjustment,
  billExtra,
  createBillId,
  currencyExtra,
  hasRefund,
  hasReimbursement,
  inputBillMoney,
  inspectWriteResult,
  normalizeAssetId,
  normalizeBillId,
  normalizeBookId,
  normalizeCategoryId,
  normalizeRequiredAssetId,
  patchWasApplied,
  refundPatchApplied,
  refundPayload,
  resolveBillFlag,
  refundRelationshipMap,
  reimbursementRelationshipMap,
  relationshipSourceId,
  relationshipTotal,
  requireNonnegativeMoney,
  requirePositiveMoney,
  publicUserId,
  storedBillMoney,
  tagIdsFrom,
  transferPatchApplied,
  validateRefundSource,
  type BillIdInput,
  type BookIdInput,
  type CreateBillInput,
  type CreateRefundInput,
  type CreateTransferInput,
  type DeleteBillInput,
  type BillStatisticsInput,
  type CurrencyConversionInput,
  type ListBillsInput,
  type ListBillsResult,
  type ReferenceIdInput,
  type ReimburseBillsInput,
  type UpdateBillPatch,
  type UpdateRefundPatch,
  type UpdateTransferPatch,
  MAX_BILL_CURSOR_LENGTH,
  MAX_MONEY,
  MAX_SEARCH_KEYWORD_LENGTH,
} from "./bill-rules.ts";

import {
  type DataStore,
  type BillFilters,
  type BillRow,
  type CatalogCache,
  type CatalogKind,
  type QianjiAccount,
} from "./data-store.ts";
import { AppError, safeError } from "./errors.ts";
import { binaryRound, decimalAdd, decimalDivide, decimalMultiply, decimalSubtract } from "./decimal.ts";
import {
  isCurrencySymbol,
  isOptionalPositiveLongId,
  isPositiveLongId,
} from "./ids.ts";
import {
  billSummary,
  cachedBillObject,
  categoryChildren,
  publicAssetGroups,
  publicAssetCurrency,
  publicBill,
  publicBook,
  publicCategory,
  publicCurrencyConversion,
  publicDebtAccount,
  publicTagGroups,
} from "./qianji-mappers.ts";
import { QianjiClient, type BudgetPeriod, type PullPage, type SyncBillResult } from "./qianji-client.ts";
import { calculateBillStatistics, calculateBudgetBillAmounts, type StatisticsUnit } from "./bill-statistics.ts";

interface CursorPayload {
  v: 2;
  accountId: number;
  time: number;
  id: string;
  bookId?: string;
  startTime?: number;
  endTime?: number;
  createStartTime?: number;
  createEndTime?: number;
  type?: number;
  categoryId?: string;
  tagId?: string;
  remarkKeyword?: string;
  assetId?: string;
  fromAssetId?: string;
  targetAssetId?: string;
  limit: number;
}

interface AdvancedCursorPayload {
  v: 3;
  accountId: number;
  offset: number;
  filters: Omit<ListBillsInput, "cursor" | "limit">;
  limit: number;
}

interface ReferenceCatalog {
  assets: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  tags: Record<string, unknown>[];
}

interface CatalogOptions {
  forceRefresh?: boolean;
  allowStale?: boolean;
}

interface PreparedBillUpdate {
  id: string;
  patch: UpdateBillPatch;
  raw: Record<string, unknown>;
  previousRaw: Record<string, unknown>;
  adjustment: number | undefined;
  expectedFlag: number;
  expectedStoredMoney: number | undefined;
  expectedCurrency: Record<string, unknown> | undefined;
  currencyChanged: boolean;
  tagIds: string[];
}

export interface GetBudgetInput {
  bookId?: string;
  period?: BudgetPeriod;
  includeDailyStatistics?: boolean;
}

// 这些展示字段由钱迹服务端派生，更新完整对象前必须删除，随后按业务场景重新构造。
const DISPLAY_FIELDS = ["category", "fromact", "targetact", "paytype", "bookname"];
const GLOBAL_SYNC_BOOK_ID = "-1";
const USER_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const DAILY_WRITE_LIMIT = 15;
const KNOWN_BILL_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 20, 21, 22]);
const MAX_SYNC_PAGES = 200;
const BILL_SCAN_LIMIT = 1_000_000_000;
const CATALOG_TTL_MS = {
  books: 12 * 60 * 60 * 1000,
  assets: 60 * 60 * 1000,
  categories: 30 * 60 * 1000,
  tags: 2 * 60 * 60 * 1000,
  currencies: 4 * 60 * 60 * 1000,
} as const;

/** 统一编排账号绑定、缓存读取、事务同步及受配额约束的账单写入。 */
export class MoneyTrackService {
  private readonly store: DataStore;
  private readonly client: QianjiClient;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly initializingAccounts = new Set<number>();
  private readonly initialSyncs = new Map<number, Promise<void>>();
  private readonly initialSyncFailures = new Map<number, AppError>();

  /** 创建业务服务，时间函数可注入，以便确定性验证缓存和配额边界。 */
  constructor(store: DataStore, client: QianjiClient, now: () => number = Date.now) {
    this.store = store;
    this.client = client;
    this.now = now;
  }

  /** 等待登录后仍在进行的账单同步结束，供服务关闭前安全释放存储。 */
  async close(): Promise<void> {
    await Promise.all(this.initialSyncs.values());
  }

  /** 使用浏览器计算的密码摘要绑定钱迹账号，且不持久化密码摘要。 */
  async bindAccount(patId: number, login: string | undefined, passwordMd5: string): Promise<void> {
    await this.withLock(`pat:${patId}`, async () => {
      const connection = await this.store.getPatConnection(patId);
      if (!connection) throw new AppError("PAT_NOT_FOUND", "PAT 不存在或已过期", 404);
      if (connection.accountId !== null) this.requireDataSyncNotRunning(connection.accountId);
      const suppliedLogin = login?.trim();
      if (connection.loginIdentifier && suppliedLogin && suppliedLogin !== connection.loginIdentifier) {
        throw new AppError("QIANJI_LOGIN_ACCOUNT_LOCKED", "登录账号与当前已连接账号不一致");
      }
      const effectiveLogin = connection.loginIdentifier ?? suppliedLogin;
      if (!effectiveLogin) throw new AppError("QIANJI_LOGIN_REQUIRED", "首次登录必须填写钱迹账号");
      const devid = connection.accountId === null
        ? randomUUID().toUpperCase()
        : (await this.store.requireAccount(connection.accountId)).devid;
      if (connection.accountId !== null) this.initializingAccounts.add(connection.accountId);
      let syncStarted = false;
      try {
        const result = await this.client.login(effectiveLogin, passwordMd5, devid);
        if (connection.uid !== null && connection.uid !== result.uid) {
          throw new AppError("QIANJI_ACCOUNT_MISMATCH", "重新登录的钱迹账号与当前绑定账号不一致");
        }
        const initialized = await this.client.initialize({
          id: connection.accountId ?? 0,
          uid: result.uid,
          utoken: result.utoken,
          devid,
        }, isVip(result.user, this.now()));
        if (String(initialized.user.id) !== result.uid) {
          throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹登录初始化返回了不一致的用户 ID", 502);
        }
        const account = await this.store.bindPat(patId, result.uid, result.utoken, devid, effectiveLogin);
        const refreshedAtMs = this.now();
        await this.store.setUserCache(account.id, userWithConfig(initialized.user, initialized.userConfig), refreshedAtMs);
        await this.store.setCatalogCache(account.id, "books", "", initialized.books, refreshedAtMs);
        this.startInitialSync(account.id);
        syncStarted = true;
      } finally {
        if (connection.accountId !== null && !syncStarted) this.initializingAccounts.delete(connection.accountId);
      }
    });
  }

  /** 解绑当前 PAT，只有账号不再被其他 PAT 使用时才删除其全部本地数据。 */
  async unbindAccount(patId: number, accountId: number) {
    return this.withLock(`pat:${patId}`, async () => {
      this.requireDataSyncNotRunning(accountId);
      const result = await this.store.unbindPat(patId, accountId);
      if (result.localDataDeleted) this.initialSyncFailures.delete(accountId);
      return result;
    });
  }

  /** 返回最小用户资料、缓存期内的 VIP 状态和当天共享写入配额。 */
  async getUserInfo(accountId: number): Promise<Record<string, unknown>> {
    return this.withAccount(accountId, async (account) =>
      publicUser(await this.loadUserWithCurrencyConfig(account), this.store, account.id, this.now()),
    );
  }

  /** 返回当前账号可访问的账本，并按需刷新 12 小时持久化快照。 */
  async listBooks(accountId: number, includeHidden: boolean, nameKeyword?: string): Promise<Record<string, unknown>[]> {
    return this.withAccount(accountId, async (account) => {
      const books = await this.loadBooks(account);
      const keyword = nameKeyword?.trim().toLowerCase();
      return books.filter((book) =>
        (includeHidden || Number(book.visible ?? 1) === 1) &&
        (keyword === undefined || String(book.name ?? "").toLowerCase().includes(keyword))
      ).map(publicBook);
    });
  }

  /** 返回指定账本的成员 ID 和名称，用于账单及统计成员筛选。 */
  async listBookMembers(accountId: number, bookIdInput: BookIdInput = GLOBAL_SYNC_BOOK_ID): Promise<Record<string, unknown>[]> {
    const bookId = normalizeBookId(bookIdInput);
    return this.withAccount(accountId, async (account) => {
      await this.requireBook(account, bookId);
      return this.client.listBookMembers(account, bookId);
    });
  }

  /** 返回按自定义分组或资产类型组织的资产，分组标题本身不可选择。 */
  async listAssets(
    accountId: number,
    includeHidden: boolean,
    includeBalances = false,
    nameKeyword?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.withAccount(accountId, async (account) => {
      const assets = await this.loadAssets(account);
      const keyword = nameKeyword?.trim().toLowerCase();
      const filtered = assets.filter((asset) =>
        (includeHidden || Number(asset.status ?? 0) === 0) &&
        (keyword === undefined || String(asset.name ?? "").toLowerCase().includes(keyword))
      );
      const baseCurrency = filtered.some((asset) => String(asset.currency ?? "").trim() === "")
        ? requireBaseCurrency(await this.loadUserWithCurrencyConfig(account))
        : "";
      return publicAssetGroups(filtered, includeBalances, baseCurrency, this.now());
    });
  }

  /** 独立查询借入或借出详情，不与普通资产快照聚合。 */
  async listDebtAccounts(
    accountId: number,
    direction: "borrowed" | "lent",
    status: "active" | "ended",
  ): Promise<Record<string, unknown>[]> {
    return this.withAccount(accountId, async (account) => {
      const baseCurrency = requireBaseCurrency(await this.loadUserWithCurrencyConfig(account));
      return (await this.client.listDebtAccounts(
        account,
        direction === "borrowed" ? 51 : 52,
        status === "active" ? 0 : 1,
      )).map((asset) => publicDebtAccount(asset, baseCurrency));
    });
  }

  /** 返回指定账本的分类，并按需刷新 30 分钟持久化快照。 */
  async listCategories(
    accountId: number,
    bookIdInput: BookIdInput = GLOBAL_SYNC_BOOK_ID,
    type: -1 | 0 | 1,
  ): Promise<Record<string, unknown>[]> {
    const bookId = normalizeBookId(bookIdInput);
    return this.withAccount(accountId, async (account) => {
      await this.requireBook(account, bookId);
      const categories = await this.loadCategories(account, bookId);
      return categories
        .filter((category) => type === -1 || Number(category.type ?? category.t) === type)
        .map(publicCategory);
    });
  }

  /** 返回按钱迹分组组织的标签，分组标题本身不可选择。 */
  async listTags(accountId: number, status: -1 | 1 | 2): Promise<Record<string, unknown>[]> {
    return this.withAccount(accountId, async (account) => {
      const tags = await this.loadTags(account);
      return publicTagGroups(tags.filter((tag) => status === -1 || Number(tag.status ?? 1) === status));
    });
  }

  /** 强制刷新当前账号的用户、账单及全部目录快照。 */
  async refreshCache(accountId: number): Promise<{
    userRefreshed: true;
    bookCount: number;
    visibleBookCount: number;
    hiddenBookCount: number;
    assetCount: number;
    categoryCount: number;
    tagCount: number;
    billCount: number;
  }> {
    this.requireDataSyncNotRunning(accountId);
    return this.withAccount(accountId, async (account) => {
      this.requireDataSyncNotRunning(account.id);
      const retryingInitialSync = this.initialSyncFailures.delete(account.id);
      if (retryingInitialSync) this.initializingAccounts.add(account.id);
      try {
        await this.loadUser(account, true);
        await this.syncUnlocked(account);
      } catch (error) {
        if (retryingInitialSync) this.initialSyncFailures.set(account.id, this.initialSyncFailure(error));
        throw error;
      } finally {
        if (retryingInitialSync) this.initializingAccounts.delete(account.id);
      }
      const options: CatalogOptions = { forceRefresh: true, allowStale: false };
      const books = await this.loadBooks(account, options);
      const [assets, tags, _currencies, categories] = await Promise.all([
        this.loadAssets(account, options),
        this.loadTags(account, options),
        this.loadCurrencies(account, options),
        Promise.all(books.map((book) => this.loadCategories(account, String(book.bookid), options))),
      ]);
      const visibleBookCount = books.filter((book) => Number(book.visible ?? 1) === 1).length;
      return {
        userRefreshed: true,
        bookCount: books.length,
        visibleBookCount,
        hiddenBookCount: books.length - visibleBookCount,
        assetCount: assets.length,
        categoryCount: categories.reduce(
          (count, items) => count + items.reduce((total, category) => total + 1 + categoryChildren(category).length, 0),
          0,
        ),
        tagCount: tags.length,
        billCount: await this.store.countBills(account.id),
      };
    });
  }

  /** 增量同步账单后执行筛选，并使用键集游标返回账单摘要。 */
  async listBills(accountId: number, input: ListBillsInput): Promise<ListBillsResult> {
    return this.withBillAccount(accountId, async (account) => {
      if (input.cursor && hasExplicitBillFilters(input)) {
        throw new AppError("INVALID_CURSOR_ARGUMENTS", "使用 cursor 时不能同时传入其他筛选或分页参数");
      }
      const advancedCursor = input.cursor?.startsWith("c3_")
        ? decodeAdvancedCursor(input.cursor, account.id)
        : undefined;
      if (advancedCursor) {
        return this.listBillsAdvanced(account, advancedCursor.filters, advancedCursor.offset, advancedCursor.limit);
      }
      if (usesAdvancedBillFilters(input)) {
        const { cursor: _cursor, limit = 20, ...filters } = input;
        return this.listBillsAdvanced(account, filters, 0, limit);
      }
      const decoded = input.cursor ? decodeCursor(input.cursor, account.id) : undefined;
      const bookId = decoded
        ? decoded.bookId
        : input.allBooks
          ? undefined
          : normalizeBookId(input.bookId ?? GLOBAL_SYNC_BOOK_ID);
      if (bookId !== undefined) await this.requireBook(account, bookId);
      if (await this.store.getSyncState(account.id) === undefined) await this.syncUnlocked(account);
      const limit = decoded?.limit ?? input.limit ?? 20;
      const startTime = decoded?.startTime ?? input.startTime;
      const endTime = decoded?.endTime ?? input.endTime;
      const createStartTime = decoded?.createStartTime ?? input.createStartTime;
      const createEndTime = decoded?.createEndTime ?? input.createEndTime;
      const type = decoded?.type ?? input.type;
      const categoryId = decoded?.categoryId ?? (
        input.categoryId === undefined ? undefined : normalizeCategoryId(input.categoryId)
      );
      const tagId = decoded?.tagId ?? input.tagId;
      const remarkKeyword = (decoded?.remarkKeyword ?? input.remarkKeyword)?.trim();
      const assetId = decoded?.assetId ?? (
        input.assetId === undefined ? undefined : normalizeAssetId(input.assetId)
      );
      const fromAssetId = decoded?.fromAssetId ?? (
        input.fromAssetId === undefined ? undefined : normalizeAssetId(input.fromAssetId)
      );
      const targetAssetId = decoded?.targetAssetId ?? (
        input.targetAssetId === undefined ? undefined : normalizeAssetId(input.targetAssetId)
      );
      const filters: BillFilters = {
        bookId,
        startTime,
        endTime,
        createStartTime,
        createEndTime,
        type,
        categoryId,
        tagId,
        remarkKeyword,
        assetId,
        fromAssetId,
        targetAssetId,
        limit,
        cursor: decoded ? { time: decoded.time, id: decoded.id } : undefined,
      };
      const rows = await this.store.listBills(account.id, filters);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        bills: page.map(billSummary),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({
                v: 2,
                accountId: account.id,
                time: last.time,
                id: last.id,
                bookId,
                startTime,
                endTime,
                createStartTime,
                createEndTime,
                type,
                categoryId,
                tagId,
                remarkKeyword,
                assetId,
                fromAssetId,
                targetAssetId,
                limit,
              })
            : null,
      };
    });
  }

  /** 对 APK 完整本地搜索条件执行一次统一筛选，默认简单查询仍走存储层键集分页。 */
  private async listBillsAdvanced(
    account: QianjiAccount,
    input: Omit<ListBillsInput, "cursor" | "limit">,
    offset: number,
    limit: number,
  ): Promise<ListBillsResult> {
    const normalized = normalizeAdvancedBillFilters(input);
    const bookId = normalized.allBooks ? undefined : normalizeBookId(normalized.bookId ?? GLOBAL_SYNC_BOOK_ID);
    if (bookId !== undefined) await this.requireBook(account, bookId);
    if (await this.store.getSyncState(account.id) === undefined) await this.syncUnlocked(account);

    let categoryIds = normalized.categoryIds?.map(normalizeCategoryId);
    if (categoryIds && normalized.includeSubcategories !== false) {
      const books = bookId === undefined ? await this.loadBooks(account) : [{ bookid: bookId }];
      const categories = (await Promise.all(books.map((book) => this.loadCategories(account, String(book.bookid))))).flat();
      const selected = new Set(categoryIds);
      for (const category of categories) {
        const id = String(category.id ?? category.cateid);
        if (!selected.has(id)) continue;
        for (const child of categoryChildren(category)) selected.add(String(child.id ?? child.cateid));
      }
      categoryIds = [...selected];
    }
    const baseCurrency = normalized.currency ? requireBaseCurrency(await this.loadUserWithCurrencyConfig(account)) : undefined;
    const rows = await this.store.listBills(account.id, {
      bookId,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      createStartTime: normalized.createStartTime,
      createEndTime: normalized.createEndTime,
      remarkKeyword: normalized.remarkKeyword,
      fromAssetId: normalized.fromAssetId,
      targetAssetId: normalized.targetAssetId,
      limit: BILL_SCAN_LIMIT,
    });
    const filtered = rows
      .map((row) => ({ row, raw: cachedBillObject(row) }))
      .filter(({ row, raw }) => advancedBillMatches(raw, row, { ...normalized, categoryIds }, baseCurrency));
    const direction = normalized.sort?.endsWith("Asc") ? 1 : -1;
    const byMoney = normalized.sort?.startsWith("money") ?? false;
    filtered.sort((left, right) => {
      const compared = byMoney
        ? billMainMoney(left.raw, left.row.money, left.row.type) - billMainMoney(right.raw, right.row.money, right.row.type)
        : left.row.time - right.row.time;
      return compared === 0 ? direction * left.row.id.localeCompare(right.row.id) : direction * compared;
    });
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      bills: page.map(({ row }) => billSummary(row)),
      nextCursor: nextOffset < filtered.length
        ? encodeAdvancedCursor({
            v: 3,
            accountId: account.id,
            offset: nextOffset,
            filters: normalized,
            limit,
          })
        : null,
    };
  }

  /** 在账号完成首次同步后返回一条完整的本地账单。 */
  async getBill(accountId: number, billId: BillIdInput): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      const id = normalizeBillId(billId);
      if (await this.store.getSyncState(account.id) === undefined) await this.syncUnlocked(account);
      const bill = await this.store.getBill(account.id, id);
      if (!bill) throw new AppError("BILL_NOT_FOUND", "账单不存在", 404);
      return publicBill(cachedBillObject(bill));
    });
  }

  /** 按 APK 主报表固定结构聚合本地账单，不提供任意分组。 */
  async getBillStatistics(accountId: number, input: BillStatisticsInput): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      if (await this.store.getSyncState(account.id) === undefined) await this.syncUnlocked(account);
      const bookId = input.allBooks ? undefined : normalizeBookId(input.bookId ?? GLOBAL_SYNC_BOOK_ID);
      const selectedBook = bookId === undefined ? undefined : await this.requireBook(account, bookId);
      const books = bookId === undefined ? await this.loadBooks(account) : [selectedBook ?? { bookid: bookId }];
      const allRows = await this.store.listBills(account.id, { limit: BILL_SCAN_LIMIT });
      const range = statisticsRange(input, books, allRows, this.now());
      const rows = allRows.filter((row) =>
        (bookId === undefined || row.bookid === bookId) && row.time >= range.startTime && row.time <= range.endTime
      );
      const categories = (await Promise.all(books.map((book) => this.loadCategories(account, String(book.bookid))))).flat();
      let categoryIds = input.categoryIds?.map(normalizeCategoryId);
      if (categoryIds && input.includeSubcategories !== false) {
        const selected = new Set(categoryIds);
        for (const category of categories) {
          if (!selected.has(String(category.id ?? category.cateid))) continue;
          for (const child of categoryChildren(category)) selected.add(String(child.id ?? child.cateid));
        }
        categoryIds = [...selected];
      }
      const baseCurrency = requireBaseCurrency(await this.loadUserWithCurrencyConfig(account));
      const currency = input.currency === undefined ? undefined : normalizeCurrencySymbol(input.currency, "统计币种");
      return calculateBillStatistics({
        rows,
        allRows,
        categories,
        startTime: range.startTime,
        endTime: range.endTime,
        unit: range.unit,
        baseCurrency,
        currency,
        memberIds: input.memberIds,
        tagIds: input.tagIds,
        tagMatch: input.tagMatch,
        categoryIds,
        nowMs: this.now(),
      });
    });
  }

  /** 按 APK 预算页口径聚合官方预算定义和本地账单。 */
  async getBudget(accountId: number, input: GetBudgetInput): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      const bookId = normalizeBookId(input.bookId ?? GLOBAL_SYNC_BOOK_ID);
      const book = bookId === GLOBAL_SYNC_BOOK_ID
        ? (await this.loadBooks(account)).find((candidate) => String(candidate.bookid) === bookId)
        : await this.requireBook(account, bookId);
      const range = budgetBookRange(book);
      const nowMs = this.now();
      const period = resolveBudgetPeriod(input.period, range, nowMs);
      const budgets = await this.client.listBudgets(account, bookId, period.filter, range);
      if (await this.store.getSyncState(account.id) === undefined) await this.syncUnlocked(account);
      const allRows = await this.store.listBills(account.id, { limit: BILL_SCAN_LIMIT });
      const rows = allRows.filter((row) =>
        row.bookid === bookId && row.time >= period.startTime && row.time <= period.endTime
      );
      return calculateBudget({
        budgets,
        categories: await this.loadCategories(account, bookId),
        rows,
        allRows,
        period,
        currency: requireBaseCurrency(await this.loadUserWithCurrencyConfig(account)),
        includeDailyStatistics: input.includeDailyStatistics === true,
        nowMs,
      });
    });
  }

  /** 一次提交创建一笔或多笔普通收入、支出或待报销支出。 */
  async createBills(accountId: number, inputs: CreateBillInput[]): Promise<{ bills: Record<string, unknown>[] }> {
    if (inputs.length === 0) throw new AppError("INVALID_BILLS", "bills 不能为空");
    return this.withBillAccount(accountId, async (account) => {
      const maxTagCount = Math.max(0, ...inputs.map((input) => input.tagIds?.length ?? 0));
      return this.withBusinessWrite(account, Array(maxTagCount).fill(""), async (markRemoteSuccess) => {
        const now = Math.floor(this.now() / 1000);
        const bills: Record<string, unknown>[] = [];
        const billIds = new Set<string>();
        for (const input of inputs) {
          const bookId = normalizeBookId(input.bookId ?? GLOBAL_SYNC_BOOK_ID);
          const categoryId = normalizeCategoryId(input.categoryId);
          const assetId = input.assetId === undefined ? "-1" : normalizeAssetId(input.assetId);
          const tagIds = input.tagIds ?? [];
          if (input.type === 1 && input.reimbursable) throw new AppError("INVALID_REIMBURSABLE", "收入不能标记为待报销");
          if (input.type === 1 && (input.discount ?? 0) > 0) {
            throw new AppError("BILL_ADJUSTMENT_UNSUPPORTED", "普通支出只支持优惠，收入不支持手续费或优惠");
          }
          const adjustment = billAdjustment(input.money, 0, input.discount ?? 0);
          const sourceStoredMoney = storedBillMoney(input.money, adjustment);
          const flag = resolveBillFlag(0, input);
          await this.validateWriteReferences(account, bookId, input.type, categoryId, assetId, tagIds);
          const targetCurrency = await this.assetCurrency(account, assetId);
          if (input.currencyConversion && !input.currencyConversion.sourceCurrency) {
            throw new AppError("SOURCE_CURRENCY_REQUIRED", "普通账单的 currencyConversion 必须提供 sourceCurrency");
          }
          const sourceCurrency = input.currencyConversion?.sourceCurrency ?? targetCurrency;
          const curr = sourceCurrency
            ? await this.buildCurrencyExtra(
                account,
                sourceCurrency,
                input.money,
                targetCurrency,
                adjustment,
                input.currencyConversion,
                false,
              )
            : undefined;
          const money = storedCommonBillMoney(sourceStoredMoney, curr, targetCurrency);
          const extra: Record<string, unknown> = { flag, tags: tagIds, transfee: adjustment };
          if (curr) extra.curr = curr;
          let id: string;
          do id = createBillId(this.now()); while (billIds.has(id));
          billIds.add(id);
          bills.push({
            id,
            userid: account.uid,
            bookid: bookId,
            time: input.time ?? now,
            type: input.type === 0 && input.reimbursable ? 5 : input.type,
            money,
            remark: input.remark ?? "",
            status: 2,
            cateid: categoryId,
            assetid: assetId,
            fromid: "-1",
            targetid: "-1",
            createtime: now,
            updatetime: now,
            platform: 0,
            images: [],
            ...(Object.values(extra).some((value) => value !== 0 && (!Array.isArray(value) || value.length > 0)) ? { extra } : {}),
          });
        }
        const result = await this.client.syncBills(account, { bills: { changelist: bills } });
        await this.acceptSyncBillResult(account, result, bills.map(({ id }) => String(id)), markRemoteSuccess);
        await this.confirmWrite(() => this.syncUnlocked(account));
        const confirmed = await Promise.all(bills.map((bill) => this.store.getBill(account.id, String(bill.id))));
        if (confirmed.some((row) => !row)) throw writeConfirmationFailed("批量创建后同步未确认全部账单");
        const raws = confirmed.map((row) => cachedBillObject(row!));
        for (const [index, raw] of raws.entries()) {
          if (JSON.stringify(publicCurrencyConversion(raw)) !== JSON.stringify(publicCurrencyConversion(bills[index]!))) {
            throw writeConfirmationFailed("批量创建后同步未确认跨币种金额");
          }
          await this.updateCachedCommonBillAssets(account.id, undefined, raw);
        }
        return { bills: raws.map(publicBill) };
      });
    });
  }

  /** 一次提交一项或多项普通账单补丁，并逐项确认最终状态。 */
  async updateBills(
    accountId: number,
    updates: Array<{ billId: BillIdInput; patch: UpdateBillPatch }>,
  ): Promise<{ bills: Record<string, unknown>[] }> {
    if (updates.length === 0) throw new AppError("INVALID_UPDATES", "updates 不能为空");
    const ids = updates.map(({ billId }) => normalizeBillId(billId));
    if (new Set(ids).size !== ids.length) throw new AppError("INVALID_UPDATES", "updates 不能包含重复 billId");
    return this.withBillAccount(accountId, async (account) => {
      await this.syncUnlocked(account);
      const prepared: PreparedBillUpdate[] = [];
      for (const [index, { patch }] of updates.entries()) {
        const id = ids[index]!;
        const latest = await this.store.getBill(account.id, id);
        if (!latest) throw new AppError("BILL_NOT_FOUND", `第 ${index + 1} 个账单不存在`, 404);
        const raw = cachedBillObject(latest);
        const previousRaw = {
          ...raw,
          ...(raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)
            ? { extra: { ...raw.extra as Record<string, unknown> } }
            : {}),
        };
        requireOwnedBill(raw, account.uid);
        const currentType = Number(raw.type);
        if (![0, 1, 5].includes(currentType)) {
          throw new AppError("BILL_SCENARIO_MISMATCH", "update_bills 只允许修改普通收支或待报销支出");
        }
        const semanticType = currentType === 1 ? 1 : 0;
        if (semanticType === 1 && patch.reimbursable) throw new AppError("INVALID_REIMBURSABLE", "收入不能标记为待报销");
        if (semanticType === 1 && (patch.discount ?? 0) > 0) {
          throw new AppError("BILL_ADJUSTMENT_UNSUPPORTED", "普通支出只支持优惠，收入不支持手续费或优惠");
        }
        if (hasReimbursement(raw)) {
          const changesReimbursable = patch.reimbursable !== undefined && patch.reimbursable !== (currentType === 5);
          const changesAsset = patch.assetId !== undefined && normalizeAssetId(patch.assetId) !== String(raw.assetid ?? "-1");
          const changesBook = patch.bookId !== undefined && normalizeBookId(patch.bookId) !== String(raw.bookid);
          if (changesReimbursable || changesAsset || changesBook) {
            throw new AppError("REIMBURSED_BILL_FIELD_LOCKED", "已报销账单不能修改待报销状态、资产或账本");
          }
        }
        if (hasRefund(raw) && patch.reimbursable !== undefined && patch.reimbursable !== (currentType === 5)) {
          throw new AppError("REFUNDED_BILL_TYPE_LOCKED", "已有退款的账单不能切换普通支出和待报销状态");
        }
        const currentAdjustment = Number(billExtra(raw).transfee ?? 0);
        const currentCurrency = publicCurrencyConversion(raw);
        const currentInputMoney = currentCurrency
          ? Number(currentCurrency.sourceAmount)
          : inputBillMoney(raw.money, currentAdjustment);
        const inputMoney = patch.money ?? currentInputMoney;
        const adjustment = patch.money !== undefined || patch.discount !== undefined
          ? billAdjustment(inputMoney, Math.max(currentAdjustment, 0), patch.discount ?? Math.max(-currentAdjustment, 0))
          : undefined;
        if (adjustment !== undefined && (adjustment > 0 || (semanticType === 1 && adjustment !== 0))) {
          throw new AppError("BILL_ADJUSTMENT_UNSUPPORTED", "普通支出只支持优惠，收入不支持手续费或优惠");
        }
        let expectedStoredMoney = adjustment === undefined ? undefined : storedBillMoney(inputMoney, adjustment);
        const targetBookId = normalizeBookId(patch.bookId ?? latest.bookid);
        applyPatch(raw, patch, adjustment, expectedStoredMoney);
        const expectedFlag = Number(billExtra(raw).flag ?? 0);
        if (semanticType === 0 && patch.reimbursable !== undefined) raw.type = patch.reimbursable ? 5 : 0;
        raw.userid = account.uid;
        raw.updatetime = Math.floor(this.now() / 1000);
        raw.status = 2;
        for (const field of DISPLAY_FIELDS) delete raw[field];
        const tagIds = tagIdsFrom(raw);
        await this.validateWriteReferences(
          account,
          targetBookId,
          semanticType,
          normalizeCategoryId(raw.cateid as ReferenceIdInput),
          normalizeAssetId((raw.assetid ?? "-1") as ReferenceIdInput),
          tagIds,
        );
        let expectedCurrency: Record<string, unknown> | undefined;
        const currencyChanged = Boolean(
          patch.currencyConversion ||
          patch.money !== undefined ||
          patch.discount !== undefined ||
          (patch.assetId !== undefined && String(raw.assetid ?? "-1") !== String(latest.assetid)),
        );
        if (currencyChanged) {
          const targetCurrency = await this.assetCurrency(account, String(raw.assetid ?? "-1"));
          if (patch.currencyConversion && !patch.currencyConversion.sourceCurrency && !currentCurrency?.sourceCurrency) {
            throw new AppError("SOURCE_CURRENCY_REQUIRED", "普通账单的 currencyConversion 必须提供 sourceCurrency");
          }
          const sourceCurrency = patch.currencyConversion?.sourceCurrency ?? String(currentCurrency?.sourceCurrency ?? targetCurrency ?? "");
          expectedCurrency = currentCurrency && !patch.currencyConversion && String(raw.assetid ?? "-1") === String(latest.assetid)
            ? rescaleCurrencyExtra(
                currentCurrency,
                inputMoney,
                currentAdjustment,
                adjustment ?? currentAdjustment,
                false,
                patch.money !== undefined && inputMoney !== currentInputMoney,
                patch.discount !== undefined && adjustment !== currentAdjustment,
              )
            : sourceCurrency
              ? await this.buildCurrencyExtra(
                  account,
                  sourceCurrency,
                  inputMoney,
                  targetCurrency,
                  adjustment ?? currentAdjustment,
                  patch.currencyConversion,
                  false,
                )
              : undefined;
          const extra = billExtra(raw);
          if (expectedCurrency) extra.curr = expectedCurrency;
          else delete extra.curr;
          raw.extra = extra;
          expectedStoredMoney = storedCommonBillMoney(
            storedBillMoney(inputMoney, adjustment ?? currentAdjustment),
            expectedCurrency,
            targetCurrency,
          );
          raw.money = expectedStoredMoney;
        }
        prepared.push({ id, patch, raw, previousRaw, adjustment, expectedFlag, expectedStoredMoney, expectedCurrency, currencyChanged, tagIds });
      }
      const maxTagCount = Math.max(0, ...prepared.map(({ tagIds }) => tagIds.length));
      return this.withBusinessWrite(account, Array(maxTagCount).fill(""), async (markRemoteSuccess) => {
        const result = await this.client.syncBills(account, { bills: { changelist: prepared.map(({ raw }) => raw) } });
        await this.acceptSyncBillResult(account, result, prepared.map(({ id }) => id), markRemoteSuccess);
        await this.confirmWrite(() => this.syncUnlocked(account));
        const results: Record<string, unknown>[] = [];
        for (const item of prepared) {
          const confirmed = await this.store.getBill(account.id, item.id);
          if (!confirmed) throw writeConfirmationFailed("批量修改后同步未确认全部账单");
          const confirmedRaw = cachedBillObject(confirmed);
          if (!patchWasApplied(confirmedRaw, item.patch, item.adjustment, item.expectedFlag, item.expectedStoredMoney)) {
            throw writeConfirmationFailed("批量修改后同步未确认变更");
          }
          if (item.currencyChanged && JSON.stringify(publicCurrencyConversion(confirmedRaw)) !== JSON.stringify(currencyExtraToPublic(item.expectedCurrency))) {
            throw writeConfirmationFailed("批量修改后同步未确认跨币种金额");
          }
          await this.updateCachedCommonBillAssets(account.id, item.previousRaw, confirmedRaw);
          results.push(publicBill(confirmedRaw));
        }
        return { bills: results };
      });
    });
  }

  /** 一次删除一笔或多笔账单，关联范围必须逐项显式确认。 */
  async deleteBills(
    accountId: number,
    deletions: DeleteBillInput[],
  ): Promise<{ deleted: Array<{ billId: string; relatedBillIds: string[] }> }> {
    if (deletions.length === 0) throw new AppError("INVALID_DELETIONS", "deletions 不能为空");
    const ids = deletions.map(({ billId }) => normalizeBillId(billId));
    if (new Set(ids).size !== ids.length) throw new AppError("INVALID_DELETIONS", "deletions 不能包含重复 billId");
    return this.withBillAccount(accountId, async (account) => {
      await this.syncUnlocked(account);
      const expanded = new Set<string>();
      const deleted: Array<{ billId: string; relatedBillIds: string[] }> = [];
      for (const [index, id] of ids.entries()) {
        const row = await this.store.getBill(account.id, id);
        if (!row) throw new AppError("BILL_NOT_FOUND", `第 ${index + 1} 个账单不存在`, 404);
        const raw = cachedBillObject(row);
        requireOwnedBill(raw, account.uid);
        if (![0, 1, 2, 3, 5].includes(Number(raw.type))) {
          throw new AppError("BILL_SCENARIO_UNSUPPORTED", "delete_bills 不支持债务、借贷、分期、退款或报销关联类型");
        }
        const relatedBillIds = [...new Set([
          ...refundRelationshipMap(raw).keys(),
          ...reimbursementRelationshipMap(raw).keys(),
        ])];
        if (relatedBillIds.length > 0 && !deletions[index]!.cascadeRelatedBills) {
          throw new AppError(
            "RELATED_BILLS_EXIST",
            `账单 ${id} 存在 ${relatedBillIds.length} 条退款或报销关联账单，本次未执行删除，请先取得用户对删除源账单及全部关联账单的明确确认，再将该删除项的 cascadeRelatedBills 设为 true 重试`,
          );
        }
        if (relatedBillIds.length > 0 && ![0, 5].includes(Number(raw.type))) {
          throw new AppError("BILL_SCENARIO_UNSUPPORTED", "关联删除只支持普通支出或待报销支出源账单");
        }
        expanded.add(id);
        if (deletions[index]!.cascadeRelatedBills) for (const relatedId of relatedBillIds) expanded.add(relatedId);
        deleted.push({ billId: id, relatedBillIds: deletions[index]!.cascadeRelatedBills ? relatedBillIds : [] });
      }
      return this.withBusinessWrite(account, [], async (markRemoteSuccess) => {
        const expandedIds = [...expanded];
        const result = await this.client.syncBills(account, { bills: { dellist: expandedIds } });
        await this.acceptSyncBillResult(account, result, expandedIds, markRemoteSuccess);
        await this.confirmWrite(() => this.syncUnlocked(account));
        const remaining = await Promise.all([...expanded].map((candidate) =>
          this.store.getBill(account.id, candidate)
        ));
        if (remaining.some(Boolean)) throw writeConfirmationFailed("批量删除后同步仍发现账单");
        await this.store.invalidateCatalogCache(account.id, "assets", "");
        return { deleted };
      });
    });
  }

  /** 基于缓存中的普通支出创建退款，并保存钱迹返回的完整关联账单组。 */
  async createRefund(accountId: number, input: CreateRefundInput): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      const sourceId = normalizeBillId(input.sourceBillId);
      const tagIds = input.tagIds ?? [];
      requirePositiveMoney(input.money, "退款金额");
      await this.syncUnlocked(account);
      const sourceRow = await this.store.getBill(account.id, sourceId);
      if (!sourceRow) throw new AppError("BILL_NOT_FOUND", "退款源账单不存在", 404);
      const before = cachedBillObject(sourceRow);
      requireOwnedBill(before, account.uid);
      const assetId = input.assetId === undefined
        ? normalizeAssetId(String(before.assetid ?? "-1"))
        : normalizeAssetId(input.assetId);
      const previousRefundIds = new Set(refundRelationshipMap(before).keys());

      return this.withBusinessWrite(account, tagIds, async (markRemoteSuccess) => {
        validateRefundSource(before, true);
        await this.validateAssetAndTags(account, assetId, tagIds);
        const payload = refundPayload(
          input,
          assetId,
          Math.max(Math.floor(this.now() / 1000), Number(before.time) + 1),
        );
        const targetCurrency = await this.assetCurrency(account, assetId);
        const sourceCurrency = await this.billSourceCurrency(account, before);
        if (input.currencyConversion && !sourceCurrency) {
          throw new AppError("SOURCE_CURRENCY_UNAVAILABLE", "无法从退款源账单取得来源币种");
        }
        const curr = sourceCurrency
          ? await this.buildCurrencyExtra(account, sourceCurrency, input.money, targetCurrency, 0, input.currencyConversion, false)
          : undefined;
        if (curr) payload.currency = JSON.stringify(curr);
        const expected: CreateRefundInput = {
          sourceBillId: sourceId,
          money: input.money,
          time: Number(payload.time),
          assetId,
          remark: input.remark ?? "",
          tagIds,
        };
        const returned = await this.client.refundBill(account, sourceId, payload);
        markRemoteSuccess();
        await this.confirmWrite(() => this.saveConfirmedBillsAndSync(account, returned));
        const confirmedSource = await this.store.getBill(account.id, sourceId);
        if (!confirmedSource) throw writeConfirmationFailed("退款后同步未确认源账单");
        const relationships = refundRelationshipMap(cachedBillObject(confirmedSource));
        const candidates = await Promise.all([...relationships.keys()]
          .filter((id) => !previousRefundIds.has(id))
          .map(async (id) => ({ id, row: await this.store.getBill(account.id, id) })));
        const matches = candidates.filter(({ id, row }) =>
          relationships.get(id) === input.money &&
          row !== undefined &&
          refundPatchApplied(cachedBillObject(row), expected)
        );
        const confirmedRefund = matches[0]?.row;
        if (matches.length !== 1 || !confirmedRefund) {
          throw writeConfirmationFailed("退款后同步未确认唯一的退款完整指纹及关联关系");
        }
        const confirmedRaw = cachedBillObject(confirmedRefund);
        if (JSON.stringify(publicCurrencyConversion(confirmedRaw)) !== JSON.stringify(currencyExtraToPublic(curr))) {
          throw writeConfirmationFailed("退款后同步未确认跨币种金额");
        }
        return publicBill(confirmedRaw);
      });
    });
  }

  /** 根据本地缓存推导源账单关系并更新一条退款。 */
  async updateRefund(
    accountId: number,
    refundBillId: BillIdInput,
    patch: UpdateRefundPatch,
  ): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      const refundId = normalizeBillId(refundBillId);
      await this.syncUnlocked(account);
      const refundRow = await this.store.getBill(account.id, refundId);
      if (!refundRow) throw new AppError("BILL_NOT_FOUND", "退款账单不存在", 404);
      const refund = cachedBillObject(refundRow);
      requireOwnedBill(refund, account.uid);
      if (Number(refund.type) !== 20) throw new AppError("BILL_SCENARIO_MISMATCH", "update_refund 只允许修改退款账单");
      const sourceId = relationshipSourceId(billExtra(refund).refundsid, "退款");
      const sourceRow = await this.store.getBill(account.id, sourceId);
      if (!sourceRow) throw new AppError("BILL_NOT_FOUND", "退款源账单不存在", 404);
      const source = cachedBillObject(sourceRow);
      requireOwnedBill(source, account.uid);
      const money = patch.money ?? Number(refund.money);
      const assetId = patch.assetId === undefined
        ? normalizeAssetId(String(refund.assetid ?? "-1"))
        : normalizeAssetId(patch.assetId);
      const tagIds = patch.tagIds ?? tagIdsFrom(refund);
      requirePositiveMoney(money, "退款金额");

      return this.withBusinessWrite(account, tagIds, async (markRemoteSuccess) => {
        validateRefundSource(source, false);
        await this.validateAssetAndTags(account, assetId, tagIds);
        const input: CreateRefundInput = {
          sourceBillId: sourceId,
          money,
          time: patch.time ?? Number(refund.time),
          assetId,
          remark: patch.remark ?? String(refund.remark ?? ""),
          tagIds,
        };
        const payload: Record<string, unknown> = {
          billid: refundId,
          ...refundPayload(input, assetId, Math.floor(this.now() / 1000)),
        };
        const currencyChanged = Boolean(
          patch.currencyConversion ||
          (patch.money !== undefined && money !== Number(refund.money)) ||
          (patch.assetId !== undefined && assetId !== String(refund.assetid ?? "-1")),
        );
        let expectedCurrency: Record<string, unknown> | undefined;
        if (currencyChanged) {
          const curr = await this.buildCurrencyExtra(
            account,
            await this.billSourceCurrency(account, source),
            money,
            await this.assetCurrency(account, assetId),
            0,
            patch.currencyConversion,
            false,
          );
          if (curr) payload.currency = JSON.stringify(curr);
          expectedCurrency = currencyExtraToPublic(curr);
        } else {
          const curr = currencyExtra(refund);
          if (curr) payload.currency = JSON.stringify(curr);
          expectedCurrency = publicCurrencyConversion(refund);
        }
        const returned = await this.client.refundBill(account, sourceId, payload);
        markRemoteSuccess();
        await this.confirmWrite(() => this.saveConfirmedBillsAndSync(account, returned));
        const confirmed = await this.store.getBill(account.id, refundId);
        const confirmedRaw = confirmed && cachedBillObject(confirmed);
        if (!confirmedRaw || !refundPatchApplied(confirmedRaw, input)) {
          throw writeConfirmationFailed("退款修改后同步未确认变更及关联关系");
        }
        if (JSON.stringify(publicCurrencyConversion(confirmedRaw)) !== JSON.stringify(expectedCurrency)) {
          throw writeConfirmationFailed("退款修改后同步未确认跨币种金额");
        }
        return publicBill(confirmedRaw);
      });
    });
  }

  /** 删除一条退款子账单，并确认源账单中的关联关系已移除。 */
  async deleteRefund(
    accountId: number,
    refundBillId: BillIdInput,
  ): Promise<{ deleted: true; refundBillId: string }> {
    const refundId = await this.deleteRelatedBill(accountId, refundBillId, "refund");
    return { deleted: true, refundBillId: refundId };
  }

  /** 删除一条报销入账子账单，并确认同源的其他报销关系保持不变。 */
  async deleteReimbursement(
    accountId: number,
    reimbursementBillId: BillIdInput,
  ): Promise<{ deleted: true; reimbursementBillId: string }> {
    const reimbursementId = await this.deleteRelatedBill(accountId, reimbursementBillId, "reimbursement");
    return { deleted: true, reimbursementBillId: reimbursementId };
  }

  /** 删除单条退款或报销子账单，并确认对应源关系已移除。 */
  private async deleteRelatedBill(
    accountId: number,
    relatedBillId: BillIdInput,
    relation: "refund" | "reimbursement",
  ): Promise<string> {
    return this.withBillAccount(accountId, async (account) => {
      const relatedId = normalizeBillId(relatedBillId);
      const label = relation === "refund" ? "退款" : "报销";
      const expectedType = relation === "refund" ? 20 : 21;
      await this.syncUnlocked(account);
      const row = await this.store.getBill(account.id, relatedId);
      if (!row) throw new AppError("BILL_NOT_FOUND", `${label}账单不存在`, 404);
      const raw = cachedBillObject(row);
      requireOwnedBill(raw, account.uid);
      if (Number(raw.type) !== expectedType) {
        throw new AppError("BILL_SCENARIO_MISMATCH", `${relation === "refund" ? "delete_refund" : "delete_reimbursement"} 只允许删除${label}账单`);
      }
      const sourceId = relationshipSourceId(
        billExtra(raw)[relation === "refund" ? "refundsid" : "bxsid"],
        label,
      );
      const sourceRow = await this.store.getBill(account.id, sourceId);
      if (!sourceRow) throw new AppError("BILL_NOT_FOUND", `${label}源账单不存在`, 404);
      const sourceRaw = cachedBillObject(sourceRow);
      requireOwnedBill(sourceRaw, account.uid);
      const previousRelationships = relation === "refund"
        ? refundRelationshipMap(sourceRaw)
        : reimbursementRelationshipMap(sourceRaw);
      const expectedRelationships = new Map(previousRelationships);
      expectedRelationships.delete(relatedId);
      return this.withBusinessWrite(account, [], async (markRemoteSuccess) => {
        const result = await this.client.syncBills(account, { bills: { dellist: [relatedId] } });
        await this.acceptSyncBillResult(account, result, [relatedId], markRemoteSuccess);
        await this.confirmWrite(() => this.syncUnlocked(account));
        const [source, remainingRelated] = await Promise.all([
          this.store.getBill(account.id, sourceId),
          this.store.getBill(account.id, relatedId),
        ]);
        const sourceRelationships = source && (relation === "refund"
          ? refundRelationshipMap(cachedBillObject(source))
          : reimbursementRelationshipMap(cachedBillObject(source)));
        if (
          remainingRelated || !sourceRelationships ||
          sourceRelationships.size !== expectedRelationships.size ||
          [...expectedRelationships].some(([id, money]) => sourceRelationships.get(id) !== money)
        ) {
          throw writeConfirmationFailed(`删除${label}后同步未确认源账单及其他关联保持不变`);
        }
        await this.store.invalidateCatalogCache(account.id, "assets", "");
        return relatedId;
      });
    });
  }

  /** 将一条或多条 type 5 源账单作为一次计入配额的业务写入完成报销。 */
  async reimburseBills(
    accountId: number,
    input: ReimburseBillsInput,
  ): Promise<{ bills: Record<string, unknown>[] }> {
    return this.withBillAccount(accountId, async (account) => {
      if (input.sourceBillIds.length === 0) throw new AppError("INVALID_SOURCE_BILLS", "sourceBillIds 不能为空");
      const ids = input.sourceBillIds.map(normalizeBillId);
      if (new Set(ids).size !== ids.length) throw new AppError("INVALID_SOURCE_BILLS", "sourceBillIds 不能重复");
      const total = input.money;
      requirePositiveMoney(total, "报销总金额");
      const assetId = input.assetId === undefined ? "-1" : normalizeAssetId(input.assetId);
      const tagIds = input.tagIds ?? [];
      const loadSources = async () => {
        await this.syncUnlocked(account);
        const sources = new Map<string, { raw: Record<string, unknown>; related: Set<string>; total: number }>();
        for (const [index, id] of ids.entries()) {
          const row = await this.store.getBill(account.id, id);
          if (!row) throw new AppError("BILL_NOT_FOUND", `第 ${index + 1} 个报销源账单不存在`, 404);
          const raw = cachedBillObject(row);
          if (Number(raw.type) !== 5) throw new AppError("BILL_SCENARIO_MISMATCH", "reimburse_bills 只接受待报销 type 5 源账单");
          requireOwnedBill(raw, account.uid, true);
          const map = reimbursementRelationshipMap(raw);
          sources.set(id, { raw, related: new Set(map.keys()), total: relationshipTotal(map) });
        }
        return sources;
      };
      let before = await loadSources();
      const sourceCurrencies = new Set(await Promise.all([...before.values()].map(async ({ raw }) =>
        this.billSourceCurrency(account, raw)
      )));
      if (sourceCurrencies.size !== 1) {
        throw new AppError("REIMBURSEMENT_CURRENCY_MISMATCH", "同一批报销的源账单必须使用相同来源币种");
      }
      if (input.currencyConversion && ![...sourceCurrencies][0]) {
        throw new AppError("SOURCE_CURRENCY_UNAVAILABLE", "无法从报销源账单取得来源币种");
      }

      return this.withBusinessWrite(account, tagIds, async (markRemoteSuccess) => {
        await this.validateAssetAndTags(account, assetId, tagIds);
        const targetCurrency = await this.assetCurrency(account, assetId);
        const sourceCurrency = [...sourceCurrencies][0]!;
        const batchCurrency = sourceCurrency
          ? await this.buildCurrencyExtra(account, sourceCurrency, total, targetCurrency, 0, input.currencyConversion, false)
          : undefined;
        const prepare = (sources: typeof before) => {
          const orderedIds = [...ids].sort((left, right) => {
            const leftTime = Number(sources.get(left)!.raw.time);
            const rightTime = Number(sources.get(right)!.raw.time);
            return leftTime - rightTime || left.length - right.length || left.localeCompare(right);
          });
          const amounts = new Map<string, number>();
          let remaining = total;
          for (const [index, id] of orderedIds.entries()) {
            const source = sources.get(id)!;
            const sourceMoney = Number(source.raw.money);
            if (!Number.isFinite(sourceMoney) || sourceMoney < 0) {
              throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹报销源账单金额无效", 502);
            }
            const available = Math.max(0, decimalSubtract(
              decimalSubtract(sourceMoney, relationshipTotal(refundRelationshipMap(source.raw))),
              source.total,
            ));
            const money = index === orderedIds.length - 1 ? remaining : Math.min(available, remaining);
            amounts.set(id, money);
            remaining = decimalSubtract(remaining, money);
          }

          const expectedCurrencies = new Map<string, Record<string, unknown> | undefined>();
          const allocations: Record<string, { money: number } | { curr: Record<string, unknown> }> = {};
          const baseRate = batchCurrency ? decimalDivide(Number(batchCurrency.bv), total, 10) : 0;
          const targetRate = batchCurrency?.ts ? decimalDivide(Number(batchCurrency.tv), total, 10) : 0;
          let remainingBase = batchCurrency ? Number(batchCurrency.bv) : 0;
          let remainingTarget = batchCurrency?.ts ? Number(batchCurrency.tv) : 0;
          for (const [index, id] of orderedIds.entries()) {
            const money = amounts.get(id)!;
            let curr: Record<string, unknown> | undefined;
            if (batchCurrency) {
              const last = index === orderedIds.length - 1;
              const base = last ? remainingBase : decimalMultiply(money, baseRate);
              const target = last ? remainingTarget : decimalMultiply(money, targetRate);
              if (base < 0 || target < 0) {
                throw new AppError("CURRENCY_DISTRIBUTION_INVALID", "跨币种报销换算余量无效，请调整整批目标或本位金额");
              }
              remainingBase = decimalSubtract(remainingBase, base);
              remainingTarget = decimalSubtract(remainingTarget, target);
              curr = {
                ...batchCurrency,
                sv: money,
                bv: base,
                ...(batchCurrency.ts ? { tv: target } : {}),
              };
            }
            expectedCurrencies.set(id, currencyExtraToPublic(curr));
            allocations[id] = curr ? { curr } : { money };
          }
          return {
            amounts,
            expectedCurrencies,
            request: {
              allocations,
              assetId,
              time: input.time ?? Math.floor(this.now() / 1000),
              remark: input.remark,
              tagIds,
            },
          };
        };
        let prepared = prepare(before);
        let returned: Awaited<ReturnType<QianjiClient["reimburseBills"]>>;
        try {
          returned = await this.client.reimburseBills(account, prepared.request);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED") throw error;
          if (!input.confirmReimbursementUpgrade) {
            throw new AppError(
              "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED",
              "钱迹账号需要迁移到新版报销，迁移后旧版本将不能继续使用报销，请先说明影响并取得用户明确同意，再将 confirmReimbursementUpgrade 设为 true 重试",
              409,
            );
          }
          await this.client.upgradeReimbursement(account);
          try {
            before = await loadSources();
            prepared = prepare(before);
            returned = await this.client.reimburseBills(account, prepared.request);
          } catch (retryError) {
            const cause = safeError(retryError);
            throw new AppError(
              "REIMBURSEMENT_UPGRADED_BUT_FAILED",
              `新版报销迁移已完成，本次报销未完成，请勿再次迁移，处理以下原因后重新调用 reimburse_bills：${cause.message}`,
              cause.httpStatus,
            );
          }
        }
        markRemoteSuccess();
        await this.confirmWrite(() => this.saveConfirmedBillsAndSync(account, returned.bills));
        const affected = new Set(ids);
        for (const id of ids) {
          const row = await this.store.getBill(account.id, id);
          if (!row) throw writeConfirmationFailed("报销后同步未确认源账单");
          const current = reimbursementRelationshipMap(cachedBillObject(row));
          const previous = before.get(id)!;
          const expectedAmount = prepared.amounts.get(id)!;
          if (decimalSubtract(decimalSubtract(relationshipTotal(current), previous.total), expectedAmount) !== 0) {
            throw writeConfirmationFailed("报销后同步未确认金额及关联关系");
          }
          const newRelated = [...current.keys()].filter((relatedId) => !previous.related.has(relatedId));
          if (newRelated.length > 1 || (expectedAmount > 0 && newRelated.length !== 1)) {
            throw writeConfirmationFailed("报销后同步未确认唯一的关联账单");
          }
          for (const relatedId of newRelated) affected.add(relatedId);
          if (newRelated.length === 1) {
            const expectedCurrency = prepared.expectedCurrencies.get(id);
            const relatedRow = await this.store.getBill(account.id, newRelated[0]!);
            if (!relatedRow || JSON.stringify(publicCurrencyConversion(cachedBillObject(relatedRow))) !== JSON.stringify(expectedCurrency)) {
              throw writeConfirmationFailed("报销后同步未确认跨币种金额");
            }
          }
        }
        const bills = await Promise.all([...affected].map((id) => this.store.getBill(account.id, id)));
        if (bills.some((row) => !row)) throw writeConfirmationFailed("报销后同步缺少关联账单");
        return { bills: bills.map((row) => publicBill(cachedBillObject(row!))) };
      });
    });
  }

  /** 使用源账单 ID 取消报销，并确认所有报销子账单均已删除。 */
  async cancelReimbursements(
    accountId: number,
    sourceBillIds: BillIdInput[],
  ): Promise<{ cancelled: true; sourceBillIds: string[] }> {
    return this.withBillAccount(accountId, async (account) => {
      if (sourceBillIds.length === 0) throw new AppError("INVALID_SOURCE_BILLS", "sourceBillIds 不能为空");
      const ids = sourceBillIds.map(normalizeBillId);
      if (new Set(ids).size !== ids.length) throw new AppError("INVALID_SOURCE_BILLS", "sourceBillIds 不能重复");
      await this.syncUnlocked(account);
      const children = new Set<string>();
      for (const id of ids) {
        const row = await this.store.getBill(account.id, id);
        if (!row) throw new AppError("BILL_NOT_FOUND", "报销源账单不存在", 404);
        const raw = cachedBillObject(row);
        if (Number(raw.type) !== 5) throw new AppError("BILL_SCENARIO_MISMATCH", "取消报销必须传入 type 5 源账单 ID");
        requireOwnedBill(raw, account.uid, true);
        const related = [...reimbursementRelationshipMap(raw).keys()];
        if (related.length === 0) throw new AppError("REIMBURSEMENT_NOT_FOUND", "源账单没有可取消的报销关系");
        for (const child of related) children.add(child);
      }
      return this.withBusinessWrite(account, [], async (markRemoteSuccess) => {
        await this.client.cancelReimbursement(account, ids);
        markRemoteSuccess();
        await this.confirmWrite(() => this.syncUnlocked(account));
        for (const id of ids) {
          const row = await this.store.getBill(account.id, id);
          if (!row || reimbursementRelationshipMap(cachedBillObject(row)).size > 0) {
            throw writeConfirmationFailed("取消报销后同步仍发现源账单关联");
          }
        }
        const remainingChildren = await Promise.all([...children].map((id) => this.store.getBill(account.id, id)));
        if (remainingChildren.some(Boolean)) {
          throw writeConfirmationFailed("取消报销后同步仍发现报销子账单");
        }
        await this.store.invalidateCatalogCache(account.id, "assets", "");
        return { cancelled: true, sourceBillIds: ids };
      });
    });
  }

  /** 使用共用上游结构创建转账或信用卡还款。 */
  async createTransfer(
    accountId: number,
    input: CreateTransferInput,
  ): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      const bookId = normalizeBookId(input.bookId ?? GLOBAL_SYNC_BOOK_ID);
      const fromAssetId = normalizeRequiredAssetId(input.fromAssetId);
      const targetAssetId = normalizeRequiredAssetId(input.targetAssetId);
      const tagIds = input.tagIds ?? [];
      const adjustment = billAdjustment(input.money, input.fee ?? 0, input.discount ?? 0);
      const money = storedBillMoney(input.money, adjustment);
      const flag = resolveBillFlag(0, input);
      const type = input.creditRepayment ? 3 : 2;
      return this.withBusinessWrite(account, tagIds, async (markRemoteSuccess) => {
        const { from, target } = await this.validateTransferReferences(
          account,
          bookId,
          fromAssetId,
          targetAssetId,
          tagIds,
          type === 3,
        );
        const now = Math.floor(this.now() / 1000);
        const extra: Record<string, unknown> = { transfee: adjustment };
        if (input.tagIds !== undefined) extra.tags = tagIds;
        if (flag !== 0) extra.flag = flag;
        const curr = await this.buildCurrencyExtra(
          account,
          await this.resolvedAssetCurrency(account, from),
          input.money,
          await this.resolvedAssetCurrency(account, target),
          adjustment,
          input.currencyConversion,
          true,
        );
        if (curr) extra.curr = curr;
        const raw = {
          id: createBillId(this.now()),
          userid: account.uid,
          bookid: bookId,
          time: input.time ?? now,
          type,
          money,
          remark: input.remark ?? "",
          status: 2,
          cateid: "-1",
          assetid: "-1",
          fromid: fromAssetId,
          targetid: targetAssetId,
          fromact: String(from.name ?? ""),
          targetact: String(target.name ?? ""),
          descinfo: `${String(from.name ?? "")}->${String(target.name ?? "")}`,
          createtime: now,
          updatetime: now,
          platform: 0,
          images: [],
          extra,
        };
        const result = await this.client.syncBills(account, { bills: { changelist: [raw] } });
        await this.acceptSyncBillResult(account, result, [raw.id], markRemoteSuccess);
        await this.confirmWrite(() => this.syncUnlocked(account));
        const confirmed = await this.store.getBill(account.id, raw.id);
        if (!confirmed) throw writeConfirmationFailed("转账或还款创建后同步未确认账单");
        const confirmedRaw = cachedBillObject(confirmed);
        if (JSON.stringify(publicCurrencyConversion(confirmedRaw)) !== JSON.stringify(currencyExtraToPublic(curr))) {
          throw writeConfirmationFailed("转账或还款创建后同步未确认跨币种金额");
        }
        await this.store.invalidateCatalogCache(account.id, "assets", "");
        return publicBill(confirmedRaw);
      });
    });
  }

  /** 更新转账或信用卡还款，除非显式指定，否则保持原业务场景。 */
  async updateTransfer(
    accountId: number,
    billId: BillIdInput,
    patch: UpdateTransferPatch,
  ): Promise<Record<string, unknown>> {
    return this.withBillAccount(accountId, async (account) => {
      const id = normalizeBillId(billId);
      await this.syncUnlocked(account);
      const row = await this.store.getBill(account.id, id);
      if (!row) throw new AppError("BILL_NOT_FOUND", "转账或还款账单不存在", 404);
      const raw = cachedBillObject(row);
      requireOwnedBill(raw, account.uid);
      const currentType = Number(raw.type);
      if (![2, 3].includes(currentType)) {
        throw new AppError("BILL_SCENARIO_MISMATCH", "update_transfer 只允许修改转账或信用卡还款");
      }
      const previousFromAssetId = String(raw.fromid);
      const previousTargetAssetId = String(raw.targetid);
      const creditRepayment = patch.creditRepayment ?? (currentType === 3);
      const type: 2 | 3 = creditRepayment ? 3 : 2;
      const extra = billExtra(raw);
      const changesFlag = patch.excludeFromIncomeExpense !== undefined || patch.excludeFromBudget !== undefined;
      const currentAdjustment = Number(extra.transfee ?? 0);
      const currentInputMoney = inputBillMoney(raw.money, currentAdjustment);
      const currentCurrency = publicCurrencyConversion(raw);
      const inputMoney = patch.money ?? currentInputMoney;
      // 钱迹用同一有符号字段表示优惠或手续费，修改其中一个时必须清除另一个。
      const adjustment = patch.money !== undefined || patch.fee !== undefined || patch.discount !== undefined
        ? billAdjustment(
            inputMoney,
            patch.fee ?? (patch.discount !== undefined ? 0 : Math.max(currentAdjustment, 0)),
            patch.discount ?? (patch.fee !== undefined ? 0 : Math.max(-currentAdjustment, 0)),
          )
        : currentAdjustment;
      const money = storedBillMoney(inputMoney, adjustment);
      const fromAssetId = normalizeRequiredAssetId(patch.fromAssetId ?? String(raw.fromid));
      const targetAssetId = normalizeRequiredAssetId(patch.targetAssetId ?? String(raw.targetid));
      const bookId = normalizeBookId(patch.bookId ?? row.bookid);
      if (patch.bookId !== undefined) raw.bookid = bookId;
      if (patch.time !== undefined) raw.time = patch.time;
      raw.type = type;
      raw.money = money;
      raw.fromid = fromAssetId;
      raw.targetid = targetAssetId;
      raw.cateid = "-1";
      raw.assetid = "-1";
      raw.userid = account.uid;
      if (patch.remark !== undefined) raw.remark = patch.remark;
      extra.transfee = adjustment;
      if (patch.tagIds !== undefined) extra.tags = patch.tagIds;
      if (changesFlag) extra.flag = resolveBillFlag(extra.flag, patch);
      const expectedFlag = Number(extra.flag ?? 0);
      raw.extra = extra;
      raw.updatetime = Math.floor(this.now() / 1000);
      raw.status = 2;
      for (const field of DISPLAY_FIELDS) delete raw[field];
      const tagIds = tagIdsFrom(raw);
      return this.withBusinessWrite(account, tagIds, async (markRemoteSuccess) => {
        const { from, target } = await this.validateTransferReferences(
          account,
          bookId,
          fromAssetId,
          targetAssetId,
          tagIds,
          type === 3,
        );
        raw.fromact = String(from.name ?? "");
        raw.targetact = String(target.name ?? "");
        raw.descinfo = `${String(from.name ?? "")}->${String(target.name ?? "")}`;
        const currencyChanged = Boolean(
          patch.currencyConversion ||
          (patch.money !== undefined && inputMoney !== currentInputMoney) ||
          ((patch.fee !== undefined || patch.discount !== undefined) && adjustment !== currentAdjustment) ||
          (patch.fromAssetId !== undefined && fromAssetId !== previousFromAssetId) ||
          (patch.targetAssetId !== undefined && targetAssetId !== previousTargetAssetId),
        );
        const nextCurrencyExtra = currencyChanged
          ? currentCurrency && !patch.currencyConversion &&
              fromAssetId === previousFromAssetId && targetAssetId === previousTargetAssetId
            ? rescaleCurrencyExtra(
                currentCurrency,
                inputMoney,
                currentAdjustment,
                adjustment,
                true,
                patch.money !== undefined && inputMoney !== currentInputMoney,
                (patch.fee !== undefined || patch.discount !== undefined) && adjustment !== currentAdjustment,
              )
            : await this.buildCurrencyExtra(
                account,
                await this.resolvedAssetCurrency(account, from),
                inputMoney,
                await this.resolvedAssetCurrency(account, target),
                adjustment,
                patch.currencyConversion,
                true,
              )
          : undefined;
        if (currencyChanged) {
          if (nextCurrencyExtra) extra.curr = nextCurrencyExtra;
          else delete extra.curr;
        }
        raw.extra = extra;
        const expectedCurrency = currencyChanged
          ? currencyExtraToPublic(nextCurrencyExtra)
          : publicCurrencyConversion(raw);
        const result = await this.client.syncBills(account, { bills: { changelist: [raw] } });
        await this.acceptSyncBillResult(account, result, [id], markRemoteSuccess);
        await this.confirmWrite(() => this.syncUnlocked(account));
        const confirmed = await this.store.getBill(account.id, id);
        const confirmedRaw = confirmed && cachedBillObject(confirmed);
        if (
          !confirmedRaw || !transferPatchApplied(
            confirmedRaw,
            patch,
            money,
            adjustment,
            fromAssetId,
            targetAssetId,
            type,
            expectedFlag,
          )
        ) throw writeConfirmationFailed("转账或还款修改后同步未确认变更");
        if (JSON.stringify(publicCurrencyConversion(confirmedRaw)) !== JSON.stringify(expectedCurrency)) {
          throw writeConfirmationFailed("转账或还款修改后同步未确认跨币种金额");
        }
        await this.store.invalidateCatalogCache(account.id, "assets", "");
        return publicBill(confirmedRaw);
      });
    });
  }

  /** 统一执行标签上限、非 VIP 配额预占及远端成功后的配额保留。 */
  private async withBusinessWrite<T>(
    account: QianjiAccount,
    tagIds: string[],
    operation: (markRemoteSuccess: () => void) => Promise<T>,
  ): Promise<T> {
    const vip = isVip(await this.loadUser(account, false, false), this.now());
    const tagLimit = vip ? 8 : 1;
    if (tagIds.length > tagLimit) {
      throw new AppError("TAG_LIMIT_EXCEEDED", `${vip ? "VIP" : "非 VIP"} 每次写入最多使用 ${tagLimit} 个标签`);
    }
    if (vip) return operation(() => {});

    const date = shanghaiDate(this.now());
    await this.store.reserveWriteQuota(account.id, date, DAILY_WRITE_LIMIT);
    // 配额统计钱迹已接受的写入，因此本地确认失败时也不能释放名额。
    // ponytail: 接受前崩溃最多占用一个名额到上海午夜，实际发生后再引入持久化写入日志。
    let remoteSucceeded = false;
    try {
      return await operation(() => { remoteSucceeded = true; });
    } finally {
      if (!remoteSucceeded) await this.store.releaseWriteQuota(account.id, date);
    }
  }

  /** 在唯一入口处保留部分成功配额、刷新本地状态并返回逐项结果。 */
  private async acceptSyncBillResult(
    account: QianjiAccount,
    result: SyncBillResult,
    expectedIds: string[],
    markRemoteSuccess: () => void,
  ): Promise<void> {
    const inspected = inspectWriteResult(result, expectedIds);
    if (inspected.appliedIds.length > 0) markRemoteSuccess();
    if (!inspected.error) return;
    if (inspected.appliedIds.length > 0) {
      try {
        await this.store.invalidateCatalogCache(account.id, "assets", "");
        await this.syncUnlocked(account);
      } catch (error) {
        throw new AppError(
          inspected.error.code,
          `${inspected.error.message}，本地缓存刷新失败：${safeError(error).message}，请先调用 refresh_cache 再继续`,
          inspected.error.httpStatus,
        );
      }
    }
    throw inspected.error;
  }

  /** 将远端写入后的本地确认失败转换为可恢复的稳定错误。 */
  private async confirmWrite(confirm: () => Promise<void>): Promise<void> {
    try {
      await confirm();
    } catch (error) {
      throw writeConfirmationFailed(`远端已成功写入，但本地缓存确认失败：${safeError(error).message}`);
    }
  }

  /** 保存上游返回的关联账单并立即同步最终状态。 */
  private async saveConfirmedBillsAndSync(
    account: QianjiAccount,
    bills: Record<string, unknown>[],
  ): Promise<void> {
    await this.store.saveConfirmedBills(account.id, bills, true);
    await this.syncUnlocked(account);
  }

  /** 立即拒绝登录初始化期间的账单操作，并在后台失败后提供显式恢复动作。 */
  private requireDataSyncIdle(accountId: number): void {
    this.requireDataSyncNotRunning(accountId);
    const failure = this.initialSyncFailures.get(accountId);
    if (failure) throw failure;
  }

  /** 立即拒绝仍在进行的登录初始化。 */
  private requireDataSyncNotRunning(accountId: number): void {
    if (this.initializingAccounts.has(accountId)) {
      throw new AppError("QIANJI_DATA_SYNCING", "钱迹账单正在同步，请稍后再试", 409);
    }
  }

  /** 在首次同步门禁内串行执行账单操作。 */
  private async withBillAccount<T>(
    accountId: number,
    operation: (account: QianjiAccount) => Promise<T>,
  ): Promise<T> {
    this.requireDataSyncIdle(accountId);
    return this.withAccount(accountId, async (account) => {
      this.requireDataSyncIdle(accountId);
      return operation(account);
    });
  }

  /** 登录成功后启动一次后台账单同步，并保留失败供后续调用显式处理。 */
  private startInitialSync(accountId: number): void {
    if (this.initialSyncs.has(accountId)) return;
    this.initializingAccounts.add(accountId);
    this.initialSyncFailures.delete(accountId);
    const task = this.withAccount(accountId, async (account) => this.syncUnlocked(account))
      .catch((error) => {
        this.initialSyncFailures.set(accountId, this.initialSyncFailure(error));
      })
      .finally(() => {
        this.initializingAccounts.delete(accountId);
        if (this.initialSyncs.get(accountId) === task) this.initialSyncs.delete(accountId);
      });
    this.initialSyncs.set(accountId, task);
  }

  /** 将后台同步异常转换为不会泄露内部信息的稳定恢复错误。 */
  private initialSyncFailure(error: unknown): AppError {
    const cause = safeError(error);
    return cause.code === "QIANJI_TOKEN_INVALID"
      ? cause
      : new AppError(
          "QIANJI_INITIAL_SYNC_FAILED",
          `钱迹账单初始化失败：${cause.message}，请调用 refresh_cache 重试`,
          cause.httpStatus,
        );
  }

  /** 在账号级串行锁内重新读取绑定，避免使用过期的请求期账号快照。 */
  private async withAccount<T>(
    accountId: number,
    operation: (account: QianjiAccount) => Promise<T>,
  ): Promise<T> {
    // ponytail: 进程内账号锁符合单实例约束，支持多副本前改用数据库级锁。
    return this.withLock(`account:${accountId}`, async () => operation(await this.store.requireAccount(accountId)));
  }

  /** 使用 Promise 尾链串行执行同一键的任务，并在队列耗尽后释放锁记录。 */
  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 新任务先挂到当前尾部，再等待前序完成，这样并发调用不会同时越过锁。
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** 拉取完整增量分页，并把数据变化与最终游标作为一个事务提交。 */
  private async syncUnlocked(account: QianjiAccount): Promise<void> {
    const initialLasttimes = await this.store.getSyncState(account.id);
    let bookid = GLOBAL_SYNC_BOOK_ID;
    let pageoffset = 0;
    let pagesign = "";
    let finalLasttimes: unknown;
    const seen = new Set<string>();
    const pages: PullPage[] = [];

    // 先在内存中收齐所有分页，避免部分分页与中间游标提前落库。
    while (true) {
      let page: PullPage;
      try {
        page = await this.client.pullBills(account, {
          bookid,
          pageoffset,
          pagesign,
          lasttimes: initialLasttimes,
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          ["QIANJI_TOKEN_INVALID", "QIANJI_SIGNATURE_REJECTED", "QIANJI_BUSINESS_ERROR", "SYNC_CURSOR_INVALID"].includes(error.code)
        ) {
          throw error;
        }
        throw new AppError("SYNC_PAGE_FAILED", "钱迹同步分页失败", 502);
      }
      pages.push(page);
      finalLasttimes = page.lasttimes;
      if (page.hasmore === 0) break;
      if (pages.length >= MAX_SYNC_PAGES) {
        throw new AppError("SYNC_PAGE_LIMIT_EXCEEDED", `钱迹同步超过 ${MAX_SYNC_PAGES} 页上限`, 502);
      }

      const cursor = `${page.bookid}:${page.pageoffset}:${page.pagesign}`;
      if (seen.has(cursor) || (page.bookid === bookid && page.pageoffset === pageoffset && page.pagesign === pagesign)) {
        throw new AppError("SYNC_CURSOR_INVALID", "钱迹同步游标没有前进", 502);
      }
      seen.add(cursor);
      bookid = page.bookid;
      pageoffset = page.pageoffset;
      pagesign = page.pagesign;
    }
    if (finalLasttimes === undefined) {
      throw new AppError("SYNC_CURSOR_INVALID", "钱迹同步响应缺少 lasttimes", 502);
    }

    try {
      const invalidatedCategoryScopes = pages.flatMap((page) => page.categories
        .map((category) => String(category.bookid ?? page.bookid))
        .filter((bookId) => bookId !== GLOBAL_SYNC_BOOK_ID));
      await this.store.applySyncBatch(account.id, {
        changes: pages.flatMap((page) => page.changes),
        deletes: pages.flatMap((page) => page.deletes),
        invalidatedCategoryScopes,
        lasttimes: finalLasttimes,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("DATABASE_TRANSACTION_FAILED", "同步事务失败并已回滚", 500);
    }
  }

  /** 读取目录缓存，过期时刷新，并按调用方策略决定是否允许使用陈旧快照。 */
  private async loadCatalog(
    account: QianjiAccount,
    kind: CatalogKind,
    scope: string,
    refresh: (cached?: CatalogCache) => Promise<Record<string, unknown>[]>,
    options: CatalogOptions = {},
  ): Promise<Record<string, unknown>[]> {
    const cached = await this.store.getCatalogCache(account.id, kind, scope);
    if (!options.forceRefresh && cached && this.isCatalogFresh(account, kind, cached)) return cached.data;
    try {
      const data = await refresh(options.forceRefresh || cached?.data.length === 0 ? undefined : cached);
      await this.store.setCatalogCache(account.id, kind, scope, data);
      return data;
    } catch (error) {
      if (options.allowStale !== false && cached) return cached.data;
      throw error;
    }
  }

  /** 读取用户缓存，过期时通过客户端初始化接口同时刷新用户和账本。 */
  private async loadUser(
    account: QianjiAccount,
    forceRefresh = false,
    allowStale = true,
  ): Promise<Record<string, unknown>> {
    const cached = await this.store.getUserCache(account.id);
    if (!forceRefresh && cached && this.now() - cached.refreshedAtMs < USER_CACHE_TTL_MS) return cached.data;
    try {
      const refreshed = await this.client.initialize(account, cached ? isVip(cached.data, this.now()) : false);
      const refreshedAtMs = this.now();
      const user = userWithConfig(refreshed.user, refreshed.userConfig);
      await this.store.setUserCache(account.id, user, refreshedAtMs);
      await this.store.setCatalogCache(account.id, "books", "", refreshed.books, refreshedAtMs);
      return user;
    } catch (error) {
      if (!forceRefresh && allowStale && cached) return cached.data;
      throw error;
    }
  }

  /** 旧用户快照不含币种配置时强制初始化一次，避免猜测本位币。 */
  private async loadUserWithCurrencyConfig(account: QianjiAccount): Promise<Record<string, unknown>> {
    const user = await this.loadUser(account);
    return isCurrencySymbol(String(user.__baseCurrency ?? ""))
      ? user
      : this.loadUser(account, true, false);
  }

  /** 读取完整账本目录，隐藏过滤由公开读取方法负责。 */
  private loadBooks(
    account: QianjiAccount,
    options?: CatalogOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.loadCatalog(account, "books", "", () => this.client.listBooks(account, true), options);
  }

  /** 读取完整资产目录，隐藏过滤由公开读取方法负责。 */
  private loadAssets(
    account: QianjiAccount,
    options?: CatalogOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.loadCatalog(account, "assets", "", () => this.client.listAssets(account, true), options);
  }

  /** 读取仅供跨币种校验和换算使用的内部币种目录。 */
  private loadCurrencies(
    account: QianjiAccount,
    options?: CatalogOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.loadCatalog(account, "currencies", "", () => this.client.listCurrencies(account), options);
  }

  /** 按 APP 的普通账单本地增量语义更新已有资产快照，不触发资产接口刷新。 */
  private async updateCachedCommonBillAssets(
    accountId: number,
    previous: Record<string, unknown> | undefined,
    current: Record<string, unknown> | undefined,
  ): Promise<void> {
    const deltas = new Map<string, number>();
    for (const [bill, direction] of [[previous, -1], [current, 1]] as const) {
      if (!bill) continue;
      const type = Number(bill.type);
      const assetId = String(bill.assetid ?? "-1");
      if (![0, 1, 5].includes(type) || !isPositiveLongId(assetId)) continue;
      const money = Number(bill.money);
      if (!Number.isFinite(money)) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹确认账单金额无效", 502);
      const conversion = publicCurrencyConversion(bill);
      const assetMoney = conversion?.targetAmount === undefined ? money : Number(conversion.targetAmount);
      const effect = decimalMultiply(assetMoney, (type === 1 ? 1 : -1) * direction);
      deltas.set(assetId, decimalAdd(deltas.get(assetId) ?? 0, effect));
    }
    for (const [assetId, delta] of deltas) if (delta === 0) deltas.delete(assetId);
    if (deltas.size === 0) return;

    const cached = await this.store.getCatalogCache(accountId, "assets", "");
    if (!cached) return;
    const data = cached.data.map((asset) => {
      const delta = deltas.get(String(asset.id));
      if (delta === undefined) return asset;
      const money = Number(asset.money ?? 0);
      if (!Number.isFinite(money)) throw new AppError("QIANJI_RESPONSE_INVALID", "资产缓存余额无效", 502);
      return { ...asset, money: decimalAdd(money, delta) };
    });
    await this.store.setCatalogCache(accountId, "assets", "", data, cached.refreshedAtMs);
  }

  /** 读取指定账本的完整分类目录。 */
  private loadCategories(
    account: QianjiAccount,
    bookId: string,
    options?: CatalogOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.loadCatalog(
      account,
      "categories",
      bookId,
      () => this.client.listCategories(account, bookId, -1),
      options,
    );
  }

  /** 读取包含正常和归档标签的完整目录。 */
  private loadTags(
    account: QianjiAccount,
    options?: CatalogOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.loadCatalog(
      account,
      "tags",
      "",
      () => this.client.listTags(account, -1, 0),
      options,
    );
  }

  /** 验证账本归属，新账本未命中时强制刷新一次以排除陈旧缓存。 */
  private async requireBook(
    account: QianjiAccount,
    bookId: string,
    options: CatalogOptions = {},
  ): Promise<Record<string, unknown> | undefined> {
    if (bookId === GLOBAL_SYNC_BOOK_ID) return undefined;
    const cachedWasFresh = this.isCatalogFresh(account, "books", await this.store.getCatalogCache(account.id, "books"));
    let books = await this.loadBooks(account, options);
    let book = books.find((candidate) => String(candidate.bookid) === bookId);
    if (book) return book;
    if (!options.forceRefresh && cachedWasFresh) {
      books = await this.loadBooks(account, { forceRefresh: true, allowStale: false });
      book = books.find((candidate) => String(candidate.bookid) === bookId);
      if (book) return book;
    }
    throw crossAccount("账本");
  }

  /** 拒绝官方标记为成员到期，或所有者 VIP 到期后的非默认账本写入。 */
  private async requireWritableBook(account: QianjiAccount, bookId: string): Promise<void> {
    const book = await this.requireBook(account, bookId, { allowStale: false });
    if (!book) return;
    if (
      Number(book.expired) === 1 &&
      String(book.userid) !== account.uid &&
      String(book.memberid) === account.uid
    ) throw new AppError("BOOK_EXPIRED", "该共享账本成员资格已到期，不能继续写入");
    if (String(book.userid) !== account.uid) return;
    let user = await this.loadUser(account, false, false);
    if (Number(user.vipend ?? 0) <= 0 || isVip(user, this.now())) return;
    user = await this.loadUser(account, true, false);
    if (!isVip(user, this.now())) throw new AppError("BOOK_EXPIRED", "该非默认账本已随 VIP 到期，不能继续写入");
  }

  /** 判断目录缓存是否有效，并排除已过期的外部成员账本快照。 */
  private isCatalogFresh(account: QianjiAccount, kind: CatalogKind, cached?: CatalogCache): boolean {
    if (!cached || cached.data.length === 0 || this.now() - cached.refreshedAtMs >= CATALOG_TTL_MS[kind]) return false;
    return kind !== "books" || !cached.data.some((book) =>
      Number(book.expired) === 1 && String(book.userid) !== account.uid && String(book.memberid) === account.uid
    );
  }

  /** 并行加载普通账单写入所需的资产、分类和标签目录。 */
  private async loadWriteReferences(
    account: QianjiAccount,
    bookId: string,
    forceRefresh = false,
  ): Promise<ReferenceCatalog> {
    const options = { forceRefresh, allowStale: false };
    const [assets, categories, tags] = await Promise.all([
      this.loadAssets(account, options),
      this.loadCategories(account, bookId, options),
      this.loadTags(account, options),
    ]);
    return { assets, categories, tags };
  }

  /** 校验普通账单引用归属，首次失败后强制刷新一次以排除缓存陈旧。 */
  private async validateWriteReferences(
    account: QianjiAccount,
    bookId: string,
    type: 0 | 1,
    categoryId: string,
    assetId: string,
    tagIds: string[],
  ): Promise<void> {
    await this.requireWritableBook(account, bookId);
    await this.validateAfterCatalogRefresh(
      (forceRefresh) => this.loadWriteReferences(account, bookId, forceRefresh),
      (references) => this.validateReferences(
        references,
        type,
        categoryId,
        assetId,
        tagIds,
      ),
    );
  }

  /** 引用未命中时强制刷新目录一次并重新校验。 */
  private async validateAfterCatalogRefresh<T, R>(
    load: (forceRefresh: boolean) => Promise<T>,
    validate: (references: T) => R,
  ): Promise<R> {
    try {
      return validate(await load(false));
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CROSS_ACCOUNT_RESOURCE") throw error;
      return validate(await load(true));
    }
  }

  /** 对已加载的目录执行分类类型、资产和标签归属校验。 */
  private validateReferences(
    references: ReferenceCatalog,
    type: 0 | 1,
    categoryId: string,
    assetId: string,
    tagIds: string[],
  ): void {
    if (!references.categories.some((category) =>
      [category, ...categoryChildren(category)].some((item) =>
        String(item.id ?? item.cateid) === categoryId && Number(item.type ?? item.t) === type
      )
    )) throw crossAccount("分类");
    if (assetId !== "-1" && !references.assets.some((asset) => String(asset.id) === assetId)) throw crossAccount("资产");
    const availableTags = new Set(references.tags.map((tag) => String(tag.id)));
    if (tagIds.some((tagId) => !availableTags.has(tagId))) throw crossAccount("标签");
  }

  /** 并行加载退款、报销和转账共用的资产与标签目录。 */
  private async loadAssetAndTagReferences(
    account: QianjiAccount,
    forceRefresh = false,
  ): Promise<{ assets: Record<string, unknown>[]; tags: Record<string, unknown>[] }> {
    const options = { forceRefresh, allowStale: false };
    const [assets, tags] = await Promise.all([
      this.loadAssets(account, options),
      this.loadTags(account, options),
    ]);
    return { assets, tags };
  }

  /** 校验资产和标签归属，首次失败后强制刷新一次目录。 */
  private async validateAssetAndTags(account: QianjiAccount, assetId: string, tagIds: string[]): Promise<void> {
    const validate = ({ assets, tags }: { assets: Record<string, unknown>[]; tags: Record<string, unknown>[] }): void => {
      if (assetId !== "-1" && !assets.some((asset) => String(asset.id) === assetId)) throw crossAccount("资产");
      const availableTags = new Set(tags.map((tag) => String(tag.id)));
      if (tagIds.some((tagId) => !availableTags.has(tagId))) throw crossAccount("标签");
    };
    await this.validateAfterCatalogRefresh(
      (forceRefresh) => this.loadAssetAndTagReferences(account, forceRefresh),
      validate,
    );
  }

  private async assetCurrency(account: QianjiAccount, assetId: string): Promise<string | undefined> {
    if (assetId === "-1") return undefined;
    const asset = (await this.loadAssets(account, { allowStale: false }))
      .find((candidate) => String(candidate.id) === assetId);
    if (!asset) throw crossAccount("资产");
    return this.resolvedAssetCurrency(account, asset);
  }

  /** 按 APK 规则解析资产币种，原始值为空时使用账号本位币。 */
  private async resolvedAssetCurrency(account: QianjiAccount, asset: Record<string, unknown>): Promise<string> {
    const baseCurrency = String(asset.currency ?? "").trim()
      ? ""
      : requireBaseCurrency(await this.loadUserWithCurrencyConfig(account));
    return publicAssetCurrency(asset, baseCurrency);
  }

  /** 历史换算优先，无换算且无资产时按 APP 语义使用本位币。 */
  private async billSourceCurrency(account: QianjiAccount, raw: Record<string, unknown>): Promise<string> {
    return String(
      publicCurrencyConversion(raw)?.sourceCurrency ??
      await this.assetCurrency(account, String(raw.assetid ?? "-1")) ??
      requireBaseCurrency(await this.loadUserWithCurrencyConfig(account)),
    );
  }

  /** 校验转账双方资产、币种、信用账户要求及标签归属。 */
  private async validateTransferReferences(
    account: QianjiAccount,
    bookId: string,
    fromAssetId: string,
    targetAssetId: string,
    tagIds: string[],
    requireCreditTarget: boolean,
  ): Promise<{ from: Record<string, unknown>; target: Record<string, unknown> }> {
    if (fromAssetId === targetAssetId) throw new AppError("TRANSFER_ASSET_SAME", "转出和转入资产必须不同");
    await this.requireWritableBook(account, bookId);
    const validate = (
      { assets, tags }: { assets: Record<string, unknown>[]; tags: Record<string, unknown>[] },
    ): { from: Record<string, unknown>; target: Record<string, unknown> } => {
      const from = assets.find((asset) => String(asset.id) === fromAssetId);
      const target = assets.find((asset) => String(asset.id) === targetAssetId);
      if (!from || !target) throw crossAccount("资产");
      if ([5, 6].includes(Number(from.type)) || [5, 6].includes(Number(target.type))) {
        throw new AppError("TRANSFER_DEBT_LOAN_UNSUPPORTED", "当前不支持债务或借贷资产转账");
      }
      if (requireCreditTarget && Number(target.type) !== 2) {
        throw new AppError("CREDIT_ASSET_REQUIRED", "信用卡还款的目标资产必须是信用账户");
      }
      const availableTags = new Set(tags.map((tag) => String(tag.id)));
      if (tagIds.some((tagId) => !availableTags.has(tagId))) throw crossAccount("标签");
      return { from, target };
    };
    return this.validateAfterCatalogRefresh(
      (forceRefresh) => this.loadAssetAndTagReferences(account, forceRefresh),
      validate,
    );
  }

  /** 构造 APK `CurrencyExtra`，显式金额优先，省略时才按内部币种目录换算。 */
  private async buildCurrencyExtra(
    account: QianjiAccount,
    sourceCurrencyInput: string,
    sourceAmount: number,
    targetCurrencyInput: string | undefined,
    adjustment: number,
    input: CurrencyConversionInput | undefined,
    transfer: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    const user = await this.loadUserWithCurrencyConfig(account);
    const sourceCurrency = normalizeCurrencySymbol(sourceCurrencyInput, "来源币种");
    const targetCurrency = targetCurrencyInput ? normalizeCurrencySymbol(targetCurrencyInput, "目标币种") : undefined;
    const configuredBaseCurrency = String(user.__baseCurrency ?? "").trim();
    if (!isCurrencySymbol(configuredBaseCurrency)) {
      if (input || (targetCurrency !== undefined && targetCurrency !== sourceCurrency)) requireBaseCurrency(user);
      return undefined;
    }
    const baseCurrency = configuredBaseCurrency;
    const isCrossCurrency = sourceCurrency !== baseCurrency || (targetCurrency !== undefined && targetCurrency !== baseCurrency);
    if (!isCrossCurrency) {
      if (input?.targetAmount !== undefined || input?.baseAmount !== undefined) {
        throw new AppError("CURRENCY_CONVERSION_NOT_NEEDED", "同本位币账单不接受目标或本位换算金额");
      }
      return undefined;
    }
    if (user.__multiCurrencyEnabled !== true) {
      throw new AppError("MULTI_CURRENCY_DISABLED", "当前钱迹账户未开启多币种，请先在钱迹 APP 开启后调用 refresh_cache 重试");
    }
    requirePositiveMoney(sourceAmount, "来源金额");
    if (input?.targetAmount !== undefined) requireNonnegativeMoney(input.targetAmount, "目标金额");
    if (input?.baseAmount !== undefined) requireNonnegativeMoney(input.baseAmount, "本位金额");
    if (input?.targetAmount !== undefined && !targetCurrency) {
      throw new AppError("TARGET_CURRENCY_REQUIRED", "没有目标资产币种时不能传 targetAmount");
    }
    if (
      targetCurrency === baseCurrency &&
      input?.targetAmount !== undefined && input.baseAmount !== undefined &&
      input.targetAmount !== input.baseAmount
    ) {
      throw new AppError("CURRENCY_CONVERSION_INCONSISTENT", "目标币种与本位币相同时，目标金额和本位金额必须相等");
    }
    const sharedTargetBaseAmount = targetCurrency === baseCurrency
      ? input?.targetAmount ?? input?.baseAmount
      : undefined;
    const needsPrice = sharedTargetBaseAmount === undefined &&
      (input?.baseAmount === undefined || (targetCurrency !== undefined && input?.targetAmount === undefined));
    const currencies = needsPrice ? await this.loadCurrencies(account, { allowStale: false }) : [];
    const price = (symbol: string): number => {
      const currency = currencies.find((item) => String(item.symbol) === symbol);
      const value = Number(currency?.baseprice);
      if (!currency || !Number.isFinite(value) || value <= 0) {
        const priceTime = Number(currency?.pricetime ?? 0);
        throw new AppError(
          "CURRENCY_PRICE_UNAVAILABLE",
          `${symbol} 缺少有效正数价格${priceTime > 0 ? `（价格时间 ${priceTime}）` : ""}`,
          502,
        );
      }
      return value;
    };
    const effectiveTargetAmount = transfer && adjustment > 0
      ? decimalSubtract(sourceAmount, adjustment)
      : !transfer && adjustment < 0
        ? decimalAdd(sourceAmount, adjustment)
        : sourceAmount;
    // APK 先用 HALF_UP 将汇率保留 10 位，再用 HALF_EVEN 将转换金额格式化为两位小数。
    const convertedAmount = (target: string): number => {
      const rate = decimalDivide(price(sourceCurrency), price(target), 10);
      return binaryRound(decimalMultiply(effectiveTargetAmount, rate), 2);
    };
    const baseAmount = sharedTargetBaseAmount ?? input?.baseAmount ?? convertedAmount(baseCurrency);
    const result: Record<string, unknown> = {
      ss: sourceCurrency,
      sv: sourceAmount,
      bs: baseCurrency,
      bv: baseAmount,
    };
    if (targetCurrency) {
      result.ts = targetCurrency;
      result.tv = sharedTargetBaseAmount ?? input?.targetAmount ?? convertedAmount(targetCurrency);
    }
    return result;
  }
}

/** 构造公开用户资料，并为非 VIP 用户附加当天写入配额。 */
async function publicUser(
  user: Record<string, unknown>,
  store: DataStore,
  accountId: number,
  nowMs: number,
): Promise<Record<string, unknown>> {
  const vip = isVip(user, nowMs);
  const result: Record<string, unknown> = {
    id: String(user.id),
    name: String(user.name ?? ""),
    avatar: String(user.avatar ?? ""),
    registeredAt: Number(user.time ?? 0),
    vipType: vipTypeName(Number(user.viptype ?? -1)),
    vipStart: publicVipTime(user.vipstart, "生效"),
    vipEnd: publicVipTime(user.vipend, "失效"),
    isVip: vip,
    baseCurrency: requireBaseCurrency(user),
  };
  const registrationMethod = registrationMethodName(Number(user.platform ?? 0));
  if (registrationMethod) result.registrationMethod = registrationMethod;
  if (vip) return result;
  const quota = await store.getWriteQuota(accountId);
  const today = shanghaiDate(nowMs);
  const used = quota.date === today ? quota.used : 0;
  return {
    ...result,
    dailyWriteLimit: DAILY_WRITE_LIMIT,
    dailyWriteUsed: used,
    dailyWriteRemaining: Math.max(0, DAILY_WRITE_LIMIT - used),
    dailyWriteResetsAt: nextShanghaiMidnight(today),
  };
}

function publicVipTime(value: unknown, label: string): number | null {
  const time = Number(value ?? 0);
  if (time === -1) return null;
  if (!Number.isInteger(time) || time < 0) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹 VIP ${label}时间无效`, 502);
  }
  return time;
}

function userWithConfig(
  user: Record<string, unknown>,
  config: { baseCurrency?: string; multiCurrencyEnabled?: boolean },
): Record<string, unknown> {
  return {
    ...user,
    ...(config.baseCurrency ? { __baseCurrency: config.baseCurrency } : {}),
    ...(config.multiCurrencyEnabled === undefined ? {} : { __multiCurrencyEnabled: config.multiCurrencyEnabled }),
  };
}

function requireBaseCurrency(user: Record<string, unknown>): string {
  const currency = String(user.__baseCurrency ?? "").trim();
  if (!isCurrencySymbol(currency)) {
    throw new AppError("BASE_CURRENCY_UNAVAILABLE", "无法取得当前钱迹账户的本位币，请调用 refresh_cache 后重试");
  }
  return currency;
}

function normalizeCurrencySymbol(value: string, label: string): string {
  const currency = value.trim();
  if (!isCurrencySymbol(currency)) throw new AppError("INVALID_CURRENCY", `${label}不能为空`);
  return currency;
}

/** 普通收支选择跨币种资产时，APK 将目标资产金额保存为账单主金额。 */
function storedCommonBillMoney(
  sourceStoredMoney: number,
  currency: Record<string, unknown> | undefined,
  assetCurrency: string | undefined,
): number {
  return currency && currency.ts === assetCurrency ? Number(currency.tv) : sourceStoredMoney;
}

/** 按 APK `CurrencyValues` 的编辑顺序用账单历史汇率缩放已保存换算金额。 */
function rescaleCurrencyExtra(
  conversion: Record<string, unknown>,
  nextSourceAmount: number,
  currentAdjustment: number,
  nextAdjustment: number,
  transfer: boolean,
  moneyChanged: boolean,
  adjustmentChanged: boolean,
): Record<string, unknown> {
  let sourceAmount = Number(conversion.sourceAmount);
  let baseAmount = conversion.baseAmount === undefined ? undefined : Number(conversion.baseAmount);
  let targetAmount = conversion.targetAmount === undefined ? undefined : Number(conversion.targetAmount);
  let adjustment = currentAdjustment;
  const preConvert = (money: number, fee: number): number =>
    (transfer && fee > 0) || (!transfer && fee < 0) ? decimalSubtract(money, Math.abs(fee)) : money;
  const apply = (money: number, fee: number): void => {
    const previous = preConvert(sourceAmount, adjustment);
    const next = preConvert(money, fee);
    const scale = (value: number | undefined): number | undefined =>
      value !== undefined && value > 0 && previous > 0
        ? binaryRound(decimalMultiply(decimalDivide(value, previous, 10), next), 2)
        : value;
    baseAmount = scale(baseAmount);
    targetAmount = scale(targetAmount);
    sourceAmount = money;
    adjustment = fee;
  };
  if (moneyChanged) apply(nextSourceAmount, adjustment);
  if (adjustmentChanged) apply(sourceAmount, nextAdjustment);
  return {
    ss: conversion.sourceCurrency,
    sv: nextSourceAmount,
    ...(conversion.baseCurrency ? { bs: conversion.baseCurrency, bv: baseAmount } : {}),
    ...(conversion.targetCurrency ? { ts: conversion.targetCurrency, tv: targetAmount } : {}),
  };
}

function currencyExtraToPublic(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const result: Record<string, unknown> = {
    sourceCurrency: value.ss,
    sourceAmount: value.sv,
    baseCurrency: value.bs,
    baseAmount: value.bv,
  };
  if (value.ts) {
    result.targetCurrency = value.ts;
    result.targetAmount = value.tv;
  }
  return result;
}

function statisticsRange(
  input: BillStatisticsInput,
  books: Record<string, unknown>[],
  rows: Array<{ bookid: string; time: number }>,
  nowMs: number,
): { startTime: number; endTime: number; unit: StatisticsUnit } {
  const offset = 8 * 60 * 60;
  const localSecond = (year: number, month: number, day: number): number =>
    Math.floor(Date.UTC(year, month - 1, day) / 1000) - offset;
  if (input.range.kind === "custom") {
    if (input.range.startTime > input.range.endTime) throw new AppError("INVALID_TIME_RANGE", "startTime 不能晚于 endTime");
    const days = (input.range.endTime + 1 - input.range.startTime) / 86_400;
    return { ...input.range, unit: days <= 365 ? "day" : "year" };
  }
  if (input.range.kind === "month") {
    const startTime = localSecond(input.range.year, input.range.month, 1);
    return {
      startTime,
      endTime: localSecond(input.range.year, input.range.month + 1, 1) - 1,
      unit: "day",
    };
  }
  if (input.range.kind === "year") {
    return {
      startTime: localSecond(input.range.year, 1, 1),
      endTime: localSecond(input.range.year + 1, 1, 1) - 1,
      unit: "month",
    };
  }
  const bookIds = new Set(books.map((book) => String(book.bookid)));
  const times = rows.filter((row) => bookIds.has(row.bookid)).map((row) => row.time);
  const endTime = Math.floor(nowMs / 1000);
  const startTime = times.length > 0 ? Math.min(...times) : endTime;
  return {
    startTime,
    endTime,
    unit: (endTime - startTime) / 86_400 <= 365 ? "month" : "year",
  };
}

type ResolvedBudgetPeriod = {
  filter: BudgetPeriod;
  startTime: number;
  endTime: number;
};

interface BudgetCategoryDefinition {
  id: string;
  name: string;
  parentId?: string;
  limit: number;
}

interface BudgetCategoryUsage {
  used: number;
  count: number;
}

function budgetBookRange(book: Record<string, unknown> | undefined): string | undefined {
  if (!book || book.config === undefined || book.config === null) return undefined;
  if (typeof book.config !== "object" || Array.isArray(book.config)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账本月份范围配置无效", 502);
  }
  const range = (book.config as Record<string, unknown>).range;
  if (range === undefined || range === null || range === "") return undefined;
  if (typeof range !== "string") throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账本月份范围配置无效", 502);
  return range;
}

function resolveBudgetPeriod(
  input: BudgetPeriod | undefined,
  range: string | undefined,
  nowMs: number,
): ResolvedBudgetPeriod {
  const startDay = budgetStartDay(range);
  let filter = input;
  if (!filter) {
    const local = new Date(nowMs + 28_800_000);
    let year = local.getUTCFullYear();
    let month = local.getUTCMonth() + 1;
    if (Math.floor(nowMs / 1000) < shanghaiSecond(year, month, startDay)) {
      const previous = new Date(Date.UTC(year, month - 2, 1));
      year = previous.getUTCFullYear();
      month = previous.getUTCMonth() + 1;
    }
    filter = { kind: "month", year, month };
  }
  if (!Number.isInteger(filter.year) || filter.year < 1970 || filter.year > 9999) {
    throw new AppError("INVALID_BUDGET_PERIOD", "预算年份必须是 1970 到 9999 之间的整数");
  }
  if (filter.kind === "month") {
    if (!Number.isInteger(filter.month) || filter.month < 1 || filter.month > 12) {
      throw new AppError("INVALID_BUDGET_PERIOD", "预算月份必须是 1 到 12 之间的整数");
    }
    const startTime = shanghaiSecond(filter.year, filter.month, startDay);
    return {
      filter,
      startTime,
      endTime: shanghaiSecond(filter.year, filter.month + 1, startDay) - 1,
    };
  }
  if (filter.kind !== "year") throw new AppError("INVALID_BUDGET_PERIOD", "预算期间只支持月份或年份");
  return {
    filter,
    startTime: shanghaiSecond(filter.year, 1, 1),
    endTime: shanghaiSecond(filter.year + 1, 1, 1) - 1,
  };
}

function budgetStartDay(range: string | undefined): number {
  if (!range?.startsWith("m")) return 1;
  const day = Number(range.slice(1));
  if (!Number.isSafeInteger(day) || day < 1) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账本月份起始日无效", 502);
  }
  return day;
}

function shanghaiSecond(year: number, month: number, day: number): number {
  const time = Date.UTC(year, month - 1, day) / 1000 - 28_800;
  if (!Number.isFinite(time)) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账本月份范围无效", 502);
  return Math.floor(time);
}

function calculateBudget(options: {
  budgets: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  rows: BillRow[];
  allRows: BillRow[];
  period: ResolvedBudgetPeriod;
  currency: string;
  includeDailyStatistics: boolean;
  nowMs: number;
}): Record<string, unknown> {
  const categoryIndex = new Map<string, { name: string; parentId?: string }>();
  for (const category of options.categories) indexBudgetCategory(categoryIndex, category);
  for (const budget of options.budgets) {
    if (budget.category && typeof budget.category === "object" && !Array.isArray(budget.category)) {
      indexBudgetCategory(categoryIndex, budget.category as Record<string, unknown>);
    }
  }

  let fullLimit = 0;
  const definitions = new Map<string, BudgetCategoryDefinition>();
  const order: string[] = [];
  for (const budget of options.budgets) {
    const flag = Number(budget.flag);
    if (flag !== 1 && flag !== 2) continue;
    const limit = budgetResponseAmount(budget.money);
    if (flag === 1) {
      fullLimit = limit;
      continue;
    }
    const id = String(budget.cateid ?? "");
    const category = categoryIndex.get(id);
    if (!isPositiveLongId(id) || !category) continue;
    if (!definitions.has(id)) order.push(id);
    if (limit > 0) definitions.set(id, { id, ...category, limit });
    else definitions.delete(id);
  }

  const parentIds = new Set([...definitions.values()].filter(({ parentId }) => !parentId).map(({ id }) => id));
  const childrenByParent = new Map<string, BudgetCategoryDefinition[]>();
  for (const id of order) {
    const definition = definitions.get(id);
    if (!definition?.parentId || !parentIds.has(definition.parentId)) continue;
    const children = childrenByParent.get(definition.parentId) ?? [];
    children.push(definition);
    childrenByParent.set(definition.parentId, children);
  }
  const rootDefinitions = order.map((id) => definitions.get(id)).filter((definition): definition is BudgetCategoryDefinition =>
    Boolean(definition && (!definition.parentId || !parentIds.has(definition.parentId)))
  );
  const effectiveLimit = (definition: BudgetCategoryDefinition): number => Math.max(
    definition.limit,
    (childrenByParent.get(definition.id) ?? []).reduce((total, child) => decimalAdd(total, child.limit), 0),
  );
  const totalCategoryLimit = rootDefinitions.reduce((total, definition) =>
    decimalAdd(total, effectiveLimit(definition)), 0
  );
  const configured = fullLimit > 0 || totalCategoryLimit > 0;
  const period = {
    ...options.period.filter,
    startTime: options.period.startTime,
    endTime: options.period.endTime,
    timezoneOffsetSeconds: 28_800,
  };
  if (!configured) {
    return {
      period,
      currency: options.currency,
      configured: false,
      summary: null,
      categories: [],
      ...(options.includeDailyStatistics ? { dailyStatistics: [] } : {}),
    };
  }

  const spendingScope = fullLimit > totalCategoryLimit ? "allExpenses" : "budgetedCategories";
  const selectedRoots = new Set([...definitions.values()].map((definition) => definition.parentId ?? definition.id));
  const usage = new Map<string, BudgetCategoryUsage>();
  const dailySpend = new Map<number, number>();
  const rawById = new Map(options.allRows.map((row) => [row.id, cachedBillObject(row)]));
  let allSpend = 0;
  let excludedFromBudget = 0;
  for (const row of options.rows) {
    if (![0, 2, 3, 5, 10].includes(row.type)) continue;
    const raw = rawById.get(row.id)!;
    const amounts = calculateBudgetBillAmounts(raw, options.currency, rawById);
    if (amounts.spend > 0) allSpend = decimalAdd(allSpend, amounts.spend);
    let categoryRoot: string | undefined;
    if ([0, 5, 10].includes(row.type)) {
      if (amounts.excludedFromBudget > 0) {
        excludedFromBudget = decimalAdd(excludedFromBudget, amounts.excludedFromBudget);
      }
      if (row.cateid) {
        const category = categoryIndex.get(row.cateid);
        categoryRoot = category?.parentId ?? row.cateid;
        addBudgetCategoryUsage(usage, categoryRoot, amounts.spend);
        if (category?.parentId) addBudgetCategoryUsage(usage, row.cateid, amounts.spend);
      }
    }
    const included = spendingScope === "allExpenses" || (categoryRoot !== undefined && selectedRoots.has(categoryRoot));
    if (included && amounts.spend > 0) {
      const day = Math.floor((row.time + 28_800) / 86_400) * 86_400 - 28_800;
      dailySpend.set(day, decimalAdd(dailySpend.get(day) ?? 0, amounts.spend));
    }
  }

  const categories = rootDefinitions.map((definition) => publicBudgetCategory(
    definition,
    effectiveLimit(definition),
    usage,
    (childrenByParent.get(definition.id) ?? []).map((child) => publicBudgetCategory(child, child.limit, usage, [])),
  ));
  const categorySpend = rootDefinitions.reduce((total, definition) =>
    decimalAdd(total, usage.get(definition.id)?.used ?? 0), 0
  );
  const limit = Math.max(fullLimit, totalCategoryLimit);
  const used = spendingScope === "allExpenses" ? allSpend : categorySpend;
  const remaining = decimalSubtract(limit, used);
  const totalDays = (options.period.endTime + 1 - options.period.startTime) / 86_400;
  const now = Math.floor(options.nowMs / 1000);
  const remainingDays = options.period.filter.kind === "month" && now >= options.period.startTime && now <= options.period.endTime
    ? Math.floor((options.period.endTime - now) / 86_400) + 1
    : 0;
  const summary: Record<string, unknown> = {
    spendingScope,
    limit,
    used,
    remaining,
    excludedFromBudgetAmount: excludedFromBudget,
    dailyAverageBudget: limit / totalDays,
  };
  if (remainingDays > 0 && limit > 0 && remaining >= 0) summary.remainingDailyAverage = remaining / remainingDays;
  return {
    period,
    currency: options.currency,
    configured: true,
    summary,
    categories,
    ...(options.includeDailyStatistics
      ? { dailyStatistics: publicBudgetDays(options.period, limit, dailySpend) }
      : {}),
  };
}

function indexBudgetCategory(
  index: Map<string, { name: string; parentId?: string }>,
  category: Record<string, unknown>,
): void {
  const id = String(category.id ?? category.cateid ?? "");
  if (!isPositiveLongId(id)) return;
  const parentId = String(category.parentid ?? "-1");
  index.set(id, {
    name: String(category.name ?? ""),
    ...(isPositiveLongId(parentId) ? { parentId } : {}),
  });
  for (const child of categoryChildren(category)) indexBudgetCategory(index, child);
}

function budgetResponseAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹预算金额无效", 502);
  }
  return amount;
}

function addBudgetCategoryUsage(
  usage: Map<string, BudgetCategoryUsage>,
  categoryId: string,
  spend: number,
): void {
  const current = usage.get(categoryId) ?? { used: 0, count: 0 };
  if (spend > 0) current.used = decimalAdd(current.used, spend);
  current.count++;
  usage.set(categoryId, current);
}

function publicBudgetCategory(
  definition: BudgetCategoryDefinition,
  limit: number,
  usage: Map<string, BudgetCategoryUsage>,
  children: Record<string, unknown>[],
): Record<string, unknown> {
  const current = usage.get(definition.id) ?? { used: 0, count: 0 };
  return {
    categoryId: definition.id,
    name: definition.name,
    limit,
    used: current.used,
    remaining: decimalSubtract(limit, current.used),
    billCount: current.count,
    children,
  };
}

function publicBudgetDays(
  period: ResolvedBudgetPeriod,
  limit: number,
  spending: Map<number, number>,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let cumulativeSpend = 0;
  for (let time = period.startTime; time <= period.endTime; time += 86_400) {
    const spend = spending.get(time) ?? 0;
    cumulativeSpend = decimalAdd(cumulativeSpend, spend);
    const date = new Date((time + 28_800) * 1000);
    result.push({
      date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
      spend,
      cumulativeSpend,
      remaining: decimalSubtract(limit, cumulativeSpend),
    });
  }
  return result;
}

/** 将钱迹平台注册代码映射为不含联系方式的注册方式。 */
function registrationMethodName(platform: number): string | undefined {
  // APK 对 2/6 返回手机号或邮箱原文，这里只披露注册方式，避免暴露联系方式。
  return platform === 2 ? "手机号"
    : platform === 3 ? "微博"
    : platform === 5 ? "QQ"
    : platform === 6 ? "邮箱"
    : platform === 7 ? "微信"
    : platform === 10 ? "Apple ID"
    : platform === 11 ? "华为账号"
    : undefined;
}

/** 将钱迹 VIP 类型代码映射为稳定的中文名称。 */
function vipTypeName(type: number): string {
  // 名称与已审计 APK 的 User.getVipName 保持一致，未知正数代码只公开为通用 VIP。
  return type === 1 ? "试用"
    : type === 2 ? "单月VIP"
    : type === 3 ? "6个月VIP"
    : type === 4 ? "年VIP"
    : type === 100 ? "终身VIP"
    : type > 0 ? "VIP"
    : "未开通";
}

/** 根据 VIP 类型和有效期判断指定时刻是否具备 VIP 权益。 */
function isVip(user: Record<string, unknown>, nowMs: number): boolean {
  const now = Math.floor(nowMs / 1000);
  const type = Number(user.viptype ?? -1);
  const start = Number(user.vipstart ?? 0);
  const end = Number(user.vipend ?? 0);
  return type >= 1 && now >= start && now < end;
}

/** 将时间戳转换为上海时区的自然日字符串。 */
function shanghaiDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

/** 计算指定上海自然日下一次午夜的 Unix 秒。 */
function nextShanghaiMidnight(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor((Date.UTC(year!, month! - 1, day! + 1) - 8 * 60 * 60 * 1000) / 1000);
}

/** 构造远端已写入但本地无法确认时的可恢复错误。 */
function writeConfirmationFailed(detail: string): AppError {
  return new AppError(
    "WRITE_CONFIRMATION_FAILED",
    `${detail}，远端操作不会自动回滚，请调用 refresh_cache 重试同步`,
    502,
  );
}

/** 将受账号和筛选条件约束的分页状态编码为连续十六进制游标。 */
function encodeCursor(cursor: CursorPayload): string {
  return `c_${Buffer.from(JSON.stringify(cursor)).toString("hex")}`;
}

function encodeAdvancedCursor(cursor: AdvancedCursorPayload): string {
  return `c3_${Buffer.from(JSON.stringify(cursor)).toString("hex")}`;
}

function decodeAdvancedCursor(cursor: string, accountId: number): AdvancedCursorPayload {
  try {
    if (cursor.length > MAX_BILL_CURSOR_LENGTH) throw new Error();
    const value = JSON.parse(Buffer.from(cursor.slice(3), "hex").toString("utf8")) as Partial<AdvancedCursorPayload>;
    if (
      value.v !== 3 ||
      value.accountId !== accountId ||
      !Number.isInteger(value.offset) || value.offset! < 0 ||
      !Number.isInteger(value.limit) || value.limit! < 1 || value.limit! > 100 ||
      !validAdvancedCursorFilters(value.filters)
    ) throw new Error();
    return { ...value, filters: normalizeAdvancedBillFilters(value.filters) } as AdvancedCursorPayload;
  } catch {
    throw new AppError("INVALID_CURSOR", "账单分页游标无效");
  }
}

/** 解码并完整校验分页游标，防止跨账号或非法筛选状态复用。 */
function decodeCursor(cursor: string, accountId: number): CursorPayload {
  try {
    if (cursor.length > MAX_BILL_CURSOR_LENGTH) throw new Error();
    // PAT 认证是信任边界，游标无需签名，但必须锁定账号并逐字段校验查询范围。
    const encoded = cursor.startsWith("c_") ? cursor.slice(2) : cursor;
    const encoding = cursor.startsWith("c_") ? "hex" : "base64url";
    const value = JSON.parse(Buffer.from(encoded, encoding).toString("utf8")) as Partial<CursorPayload>;
    if (
      value.v !== 2 ||
      value.accountId !== accountId ||
      !isNonnegativeInteger(value.time) ||
      typeof value.id !== "string" ||
      !isPositiveLongId(value.id) ||
      !Number.isInteger(value.limit) ||
      value.limit! < 1 ||
      value.limit! > 100 ||
      (value.bookId !== undefined && !isOptionalPositiveLongId(value.bookId)) ||
      (value.startTime !== undefined && !isNonnegativeInteger(value.startTime)) ||
      (value.endTime !== undefined && !isNonnegativeInteger(value.endTime)) ||
      (value.startTime !== undefined && value.endTime !== undefined && value.startTime > value.endTime) ||
      (value.createStartTime !== undefined && !isNonnegativeInteger(value.createStartTime)) ||
      (value.createEndTime !== undefined && !isNonnegativeInteger(value.createEndTime)) ||
      (value.createStartTime !== undefined && value.createEndTime !== undefined && value.createStartTime > value.createEndTime) ||
      (value.type !== undefined && (!Number.isInteger(value.type) || !KNOWN_BILL_TYPES.has(value.type))) ||
      (value.categoryId !== undefined && !isPositiveLongId(value.categoryId)) ||
      (value.tagId !== undefined && (typeof value.tagId !== "string" || value.tagId.length === 0)) ||
      (value.remarkKeyword !== undefined && (typeof value.remarkKeyword !== "string" || value.remarkKeyword.trim().length === 0 || value.remarkKeyword.length > MAX_SEARCH_KEYWORD_LENGTH)) ||
      (value.assetId !== undefined && (typeof value.assetId !== "string" || !isOptionalPositiveLongId(value.assetId))) ||
      (value.fromAssetId !== undefined && (typeof value.fromAssetId !== "string" || !isOptionalPositiveLongId(value.fromAssetId))) ||
      (value.targetAssetId !== undefined && (typeof value.targetAssetId !== "string" || !isOptionalPositiveLongId(value.targetAssetId)))
    ) {
      throw new Error();
    }
    return value as CursorPayload;
  } catch {
    throw new AppError("INVALID_CURSOR", "账单分页游标无效");
  }
}

/** 验证可被调用方篡改的高级游标内容，边界与 MCP 输入 schema 一致。 */
function validAdvancedCursorFilters(value: unknown): value is Omit<ListBillsInput, "cursor" | "limit"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const filters = value as Record<string, unknown>;
  const allowed = new Set([
    "bookId", "allBooks", "startTime", "endTime", "createStartTime", "createEndTime", "type", "types",
    "minMoney", "maxMoney", "categoryId", "categoryIds", "includeSubcategories", "tagId", "tagIds",
    "tagMatch", "remarkKeyword", "assetId", "assetIds", "fromAssetId", "targetAssetId", "source",
    "memberIds", "currency", "noAsset", "noTags", "excludeFromIncomeExpense", "excludeFromBudget", "sort",
  ]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) return false;
  const optional = (key: string, check: (candidate: unknown) => boolean): boolean =>
    filters[key] === undefined || check(filters[key]);
  const list = (key: string, check: (candidate: unknown) => boolean): boolean =>
    optional(key, (candidate) => Array.isArray(candidate) && candidate.length >= 1 && candidate.length <= 100 && candidate.every(check));
  const id = (candidate: unknown): boolean => typeof candidate === "string" && isPositiveLongId(candidate);
  const referenceId = (candidate: unknown): boolean => typeof candidate === "string" && isOptionalPositiveLongId(candidate);
  const time = (candidate: unknown): boolean => isNonnegativeInteger(candidate);
  const money = (candidate: unknown): boolean =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= MAX_MONEY;
  const text = (candidate: unknown, max: number): boolean =>
    typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= max;
  const knownType = (candidate: unknown): boolean => typeof candidate === "number" && Number.isInteger(candidate) && KNOWN_BILL_TYPES.has(candidate);
  const bool = (candidate: unknown): boolean => typeof candidate === "boolean";
  return optional("bookId", referenceId) && optional("allBooks", bool) &&
    optional("startTime", time) && optional("endTime", time) &&
    optional("createStartTime", time) && optional("createEndTime", time) &&
    optional("type", knownType) && list("types", knownType) &&
    optional("minMoney", money) && optional("maxMoney", money) &&
    optional("categoryId", id) && list("categoryIds", id) && optional("includeSubcategories", bool) &&
    optional("tagId", (candidate) => typeof candidate === "string" && candidate.length > 0) &&
    list("tagIds", (candidate) => typeof candidate === "string" && candidate.length > 0) &&
    optional("tagMatch", (candidate) => candidate === "any" || candidate === "all") &&
    optional("remarkKeyword", (candidate) => text(candidate, MAX_SEARCH_KEYWORD_LENGTH)) &&
    optional("assetId", referenceId) && list("assetIds", id) &&
    optional("fromAssetId", referenceId) && optional("targetAssetId", referenceId) &&
    optional("source", (candidate) => [0, 2, 120, 121, 122].includes(Number(candidate)) && typeof candidate === "number") &&
    list("memberIds", (candidate) => typeof candidate === "string" && candidate.length > 0) &&
    optional("currency", (candidate) => typeof candidate === "string" && isCurrencySymbol(candidate)) &&
    optional("noAsset", bool) && optional("noTags", bool) &&
    optional("excludeFromIncomeExpense", bool) && optional("excludeFromBudget", bool) &&
    optional("sort", (candidate) => typeof candidate === "string" && ["timeDesc", "timeAsc", "moneyDesc", "moneyAsc"].includes(candidate));
}

/** 判断请求是否在游标之外又显式提供了筛选或分页参数。 */
function hasExplicitBillFilters(input: ListBillsInput): boolean {
  return input.bookId !== undefined ||
    input.allBooks !== undefined ||
    input.startTime !== undefined ||
    input.endTime !== undefined ||
    input.createStartTime !== undefined ||
    input.createEndTime !== undefined ||
    input.type !== undefined ||
    input.types !== undefined ||
    input.minMoney !== undefined ||
    input.maxMoney !== undefined ||
    input.categoryId !== undefined ||
    input.categoryIds !== undefined ||
    input.includeSubcategories !== undefined ||
    input.tagId !== undefined ||
    input.tagIds !== undefined ||
    input.tagMatch !== undefined ||
    input.remarkKeyword !== undefined ||
    input.assetId !== undefined ||
    input.assetIds !== undefined ||
    input.fromAssetId !== undefined ||
    input.targetAssetId !== undefined ||
    input.source !== undefined ||
    input.memberIds !== undefined ||
    input.currency !== undefined ||
    input.noAsset !== undefined ||
    input.noTags !== undefined ||
    input.excludeFromIncomeExpense !== undefined ||
    input.excludeFromBudget !== undefined ||
    input.sort !== undefined ||
    input.limit !== undefined;
}

function usesAdvancedBillFilters(input: ListBillsInput): boolean {
  return input.types !== undefined || input.minMoney !== undefined || input.maxMoney !== undefined ||
    input.categoryIds !== undefined || input.includeSubcategories !== undefined || input.tagIds !== undefined ||
    input.tagMatch !== undefined || input.assetIds !== undefined || input.source !== undefined ||
    input.memberIds !== undefined || input.currency !== undefined || input.noAsset !== undefined ||
    input.noTags !== undefined || input.excludeFromIncomeExpense !== undefined ||
    input.excludeFromBudget !== undefined || input.sort !== undefined;
}

function normalizeAdvancedBillFilters(
  input: Omit<ListBillsInput, "cursor" | "limit">,
): Omit<ListBillsInput, "cursor" | "limit"> {
  if (input.startTime !== undefined && input.endTime !== undefined && input.startTime > input.endTime) {
    throw new AppError("INVALID_TIME_RANGE", "startTime 不能晚于 endTime");
  }
  if (input.createStartTime !== undefined && input.createEndTime !== undefined && input.createStartTime > input.createEndTime) {
    throw new AppError("INVALID_TIME_RANGE", "createStartTime 不能晚于 createEndTime");
  }
  if (input.minMoney !== undefined && input.maxMoney !== undefined && input.minMoney > input.maxMoney) {
    throw new AppError("INVALID_MONEY_RANGE", "minMoney 不能大于 maxMoney");
  }
  if (input.type !== undefined && input.types !== undefined) throw new AppError("INVALID_FILTER", "type 和 types 不能同时传入");
  if (input.categoryId !== undefined && input.categoryIds !== undefined) throw new AppError("INVALID_FILTER", "categoryId 和 categoryIds 不能同时传入");
  if (input.tagId !== undefined && input.tagIds !== undefined) throw new AppError("INVALID_FILTER", "tagId 和 tagIds 不能同时传入");
  if (input.assetId !== undefined && input.assetIds !== undefined) throw new AppError("INVALID_FILTER", "assetId 和 assetIds 不能同时传入");
  if (input.noAsset && (input.assetId !== undefined || input.assetIds !== undefined || input.fromAssetId !== undefined || input.targetAssetId !== undefined)) {
    throw new AppError("INVALID_FILTER", "noAsset 不能与资产 ID 筛选同时使用");
  }
  if (input.noTags && (input.tagId !== undefined || input.tagIds !== undefined)) {
    throw new AppError("INVALID_FILTER", "noTags 不能与标签 ID 筛选同时使用");
  }
  if (input.types?.some((type) => !KNOWN_BILL_TYPES.has(type))) throw new AppError("INVALID_FILTER", "types 包含未知账单类型");
  if (input.currency !== undefined && !isCurrencySymbol(input.currency)) throw new AppError("INVALID_CURRENCY", "currency 不能为空");
  return {
    ...input,
    types: input.types ? [...new Set(input.types)] : undefined,
    categoryIds: input.categoryIds ? [...new Set(input.categoryIds.map(normalizeCategoryId))] : undefined,
    tagIds: input.tagIds ? [...new Set(input.tagIds)] : undefined,
    assetIds: input.assetIds ? [...new Set(input.assetIds.map(normalizeAssetId))] : undefined,
    memberIds: input.memberIds ? [...new Set(input.memberIds)] : undefined,
    currency: input.currency === undefined ? undefined : normalizeCurrencySymbol(input.currency, "筛选币种"),
    remarkKeyword: input.remarkKeyword?.trim(),
    tagMatch: input.tagIds ? input.tagMatch ?? "any" : undefined,
    includeSubcategories: input.categoryIds ? input.includeSubcategories ?? true : undefined,
    sort: input.sort ?? "timeDesc",
  };
}

function advancedBillMatches(
  raw: Record<string, unknown>,
  row: { type: number; money: number; cateid: string | null; assetid: string },
  filters: Omit<ListBillsInput, "cursor" | "limit">,
  baseCurrency?: string,
): boolean {
  const money = billMainMoney(raw, row.money, row.type);
  if (filters.type !== undefined && row.type !== filters.type) return false;
  if (filters.types && !filters.types.includes(row.type)) return false;
  if (filters.minMoney !== undefined && money < filters.minMoney) return false;
  if (filters.maxMoney !== undefined && money > filters.maxMoney) return false;
  if (filters.categoryId !== undefined && row.cateid !== filters.categoryId) return false;
  if (filters.categoryIds && (row.cateid === null || !filters.categoryIds.includes(row.cateid))) return false;
  if (filters.assetId !== undefined && row.assetid !== filters.assetId) return false;
  const assetIds = [String(raw.assetid ?? "-1"), String(raw.fromid ?? "-1"), String(raw.targetid ?? "-1")];
  if (filters.assetIds && !assetIds.some((id) => filters.assetIds!.includes(id))) return false;
  if (filters.noAsset && assetIds.some(isPositiveLongId)) return false;
  const tags = tagIdsFrom(raw);
  if (filters.tagId !== undefined && !tags.includes(filters.tagId)) return false;
  if (filters.tagIds) {
    const matches = filters.tagMatch === "all"
      ? filters.tagIds.every((tag) => tags.includes(tag))
      : filters.tagIds.some((tag) => tags.includes(tag));
    if (!matches) return false;
  }
  if (filters.noTags && tags.length > 0) return false;
  if (filters.source !== undefined && !matchesBillSource(raw, filters.source)) return false;
  if (filters.memberIds && !filters.memberIds.includes(publicUserId(raw.userid))) return false;
  if (filters.currency !== undefined) {
    const conversion = publicCurrencyConversion(raw);
    if ((conversion ? conversion.sourceCurrency : baseCurrency) !== filters.currency) return false;
  }
  const flag = Number(billExtra(raw).flag ?? 0);
  if (filters.excludeFromIncomeExpense !== undefined && ((flag & 1) !== 0) !== filters.excludeFromIncomeExpense) return false;
  if (filters.excludeFromBudget !== undefined && ((flag & 2) !== 0) !== filters.excludeFromBudget) return false;
  return true;
}

/** 与账单列表输出一致的 APP 主金额，用于高级金额筛选和排序。 */
function billMainMoney(raw: Record<string, unknown>, storedMoney: number, type: number): number {
  const conversion = publicCurrencyConversion(raw);
  if (conversion) return Number(conversion.sourceAmount);
  return [0, 2, 3, 5].includes(type)
    ? inputBillMoney(storedMoney, billExtra(raw).transfee)
    : storedMoney;
}

function matchesBillSource(raw: Record<string, unknown>, source: number): boolean {
  const platform = Number(raw.platform ?? 0);
  if (source === 120) return platform === 120 || (platform === 1 && Number(raw.importpackid ?? 0) > 1_610_208_000);
  if (source === 2) return platform >= 2 && ![120, 121, 122].includes(platform);
  return platform === source;
}

/** 判断值是否为非负整数。 */
function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 按 APK 兼容规则拒绝其他用户账单，报销场景要求所有者字段严格存在。 */
function requireOwnedBill(raw: Record<string, unknown>, uid: string, exact = false): void {
  const owner = publicUserId(raw.userid);
  if ((exact && owner !== uid) || (!exact && owner !== "" && owner !== uid)) {
    throw new AppError("BILL_OWNERSHIP_MISMATCH", "不能操作其他钱迹用户创建的账单", 403);
  }
}

/** 构造资源不适用于当前账号或业务上下文的错误。 */
function crossAccount(resource: "账本" | "分类" | "资产" | "标签"): AppError {
  return new AppError(
    "CROSS_ACCOUNT_RESOURCE",
    resource === "分类"
      ? "分类不属于当前钱迹账号或目标账本，或与账单类型不匹配"
      : `${resource}不属于当前钱迹账号`,
  );
}
