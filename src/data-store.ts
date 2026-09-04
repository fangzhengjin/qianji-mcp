import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";

import { refundRelationshipMap, reimbursementRelationshipMap, validatedCurrencyConversion } from "./bill-rules.ts";
import { AppError } from "./errors.ts";
import { isOptionalPositiveLongId, isPositiveLongId } from "./ids.ts";
import { parseQianjiJson } from "./qianji-client.ts";
import { SCHEMA } from "./sqlite-schema.ts";

export type PatRole = "admin" | "user";
export type CatalogKind = "books" | "assets" | "categories" | "tags" | "currencies";

/** 生成以 `mt_pat_` 开头、正文仅含小写十六进制字符的 256 位随机 PAT。 */
export function generatePatToken(): string {
  return `mt_pat_${randomBytes(32).toString("hex")}`;
}

/** 一个已绑定钱迹账号的持久化上游身份和凭据。 */
export interface QianjiAccount {
  id: number;
  uid: string;
  utoken: string;
  devid: string;
}

/** PAT 当前绑定及仅供登录流程使用的账号标识。 */
export interface PatConnection {
  patId: number;
  accountId: number | null;
  uid: string | null;
  loginIdentifier: string | null;
}

export interface UnbindResult {
  localDataDeleted: boolean;
}

/** PAT 元数据，除一次性创建结果外，调用方不得公开明文 `token`。 */
export interface PatRecord {
  id: number;
  accountId: number | null;
  uid: string | null;
  token: string;
  role: PatRole;
  remark: string;
  expiresAt: number | null;
  createdAt: number;
}

/** 账单查询投影及用于完整读取和更新的无损上游 JSON。 */
export interface BillRow {
  id: string;
  bookid: string;
  time: number;
  type: number;
  money: number;
  cateid: string | null;
  assetid: string;
  remark: string;
  rawJson: string;
}

export interface BillCursor {
  time: number;
  id: string;
}

export interface CatalogCache {
  data: Record<string, unknown>[];
  refreshedAtMs: number;
}

export interface UserCache {
  data: Record<string, unknown>;
  refreshedAtMs: number;
}

export interface WriteQuota {
  date: string | null;
  used: number;
}

export interface BillFilters {
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
  cursor?: BillCursor;
}

export interface StoredBill {
  id: string;
  bookId: string;
  time: number;
  type: number;
  money: number;
  categoryId: string;
  assetId: string;
  remark: string;
  rawJson: string;
}

/** 一轮拉取的全部分页，存储层必须原子应用数据和最终游标。 */
export interface SyncBatch {
  changes: Record<string, unknown>[];
  deletes: string[];
  invalidatedCategoryScopes: string[];
  lasttimes: unknown;
}

type MaybePromise<T> = T | Promise<T>;

/** 默认 SQLite 与可配置服务端数据库共用的持久化契约。 */
export interface DataStore {
  /** 关闭数据库连接。 */
  close(): MaybePromise<void>;
  /** 创建或轮换启动配置管理的管理员 PAT。 */
  ensureAdminPat(token: string): MaybePromise<PatRecord>;
  /** 创建普通 PAT，并可选择绑定现有账号。 */
  createPat(remark: string, expiresAt: number | null, accountId?: number | null): MaybePromise<PatRecord>;
  /** 验证明文 PAT 是否有效。 */
  verifyPat(token: string, now?: number): MaybePromise<PatRecord | undefined>;
  /** 列出全部 PAT 元数据。 */
  listPats(): MaybePromise<PatRecord[]>;
  /** 删除普通 PAT。 */
  deletePat(id: number): MaybePromise<{ localDataDeleted: boolean } | undefined>;
  /** 读取有效 PAT 的当前绑定，登录标识不得进入公开输出或日志。 */
  getPatConnection(patId: number, now?: number): MaybePromise<PatConnection | undefined>;
  /** 将 PAT 绑定到已认证的钱迹账号。 */
  bindPat(patId: number, uid: string, utoken: string, devid: string, loginIdentifier?: string | null): MaybePromise<QianjiAccount>;
  /** 解绑当前 PAT，仅在账号已无其他 PAT 引用时删除账号及其级联数据。 */
  unbindPat(patId: number, expectedAccountId: number): MaybePromise<UnbindResult>;
  /** 读取一个已绑定的钱迹账号。 */
  requireAccount(accountId: number): MaybePromise<QianjiAccount>;
  /** 读取用户资料缓存。 */
  getUserCache(accountId: number): MaybePromise<UserCache | undefined>;
  /** 写入用户资料缓存。 */
  setUserCache(accountId: number, user: Record<string, unknown>, refreshedAtMs?: number): MaybePromise<void>;
  /** 读取账号当天的写入配额。 */
  getWriteQuota(accountId: number): MaybePromise<WriteQuota>;
  /** 原子预占一个写入名额。 */
  reserveWriteQuota(accountId: number, date: string, limit: number): MaybePromise<WriteQuota>;
  /** 释放未形成远端写入的预占名额。 */
  releaseWriteQuota(accountId: number, date: string): MaybePromise<void>;
  /** 统计账号的本地账单数量。 */
  countBills(accountId: number): MaybePromise<number>;
  /** 读取最后提交的全局同步游标。 */
  getSyncState(accountId: number): MaybePromise<unknown | undefined>;
  /** 原子应用完整同步批次。 */
  applySyncBatch(accountId: number, batch: SyncBatch): MaybePromise<void>;
  /** 读取指定目录快照。 */
  getCatalogCache(accountId: number, kind: CatalogKind, scope?: string): MaybePromise<CatalogCache | undefined>;
  /** 写入指定目录快照。 */
  setCatalogCache(accountId: number, kind: CatalogKind, scope: string, data: Record<string, unknown>[], refreshedAtMs?: number): MaybePromise<void>;
  /** 使指定目录快照失效。 */
  invalidateCatalogCache(accountId: number, kind: CatalogKind, scope: string): MaybePromise<void>;
  /** 原子保存远端已确认的账单组。 */
  saveConfirmedBills(accountId: number, bills: Record<string, unknown>[], invalidateAssets?: boolean): MaybePromise<void>;
  /** 读取一条账号范围内的完整账单。 */
  getBill(accountId: number, id: string): MaybePromise<BillRow | undefined>;
  /** 按筛选条件读取账号范围内的账单列表。 */
  listBills(accountId: number, filters: BillFilters): MaybePromise<BillRow[]>;
}

interface SqlRow {
  [key: string]: string | number | bigint | null;
}

/** 单服务实例的 SQLite 持久化，所有业务查询都限定账号范围。 */
export class Store implements DataStore {
  readonly db: Database;

  /** 打开数据库、收紧文件权限、创建 Schema 并执行兼容迁移。 */
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path, { safeIntegers: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrateAccountCache();
    this.migrateLegacyPatScopes();
    this.migrateSyncState();
    this.migrateCatalogCacheKinds();
    this.dropLegacyReferenceCaches();
  }

  /** 关闭数据库连接。 */
  close(): void {
    this.db.close();
  }

  /** 创建或轮换唯一管理员 PAT，同时保留其现有账号绑定。 */
  ensureAdminPat(token: string): PatRecord {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db.prepare("SELECT id FROM pats WHERE role = 'admin'").get() as SqlRow | undefined;
    try {
      if (existing) {
        this.db
          .prepare("UPDATE pats SET token = ?, remark = 'superadmin', expires_at = NULL WHERE id = ?")
          .run(token, Number(existing.id));
      } else {
        this.db
          .prepare("INSERT INTO pats(account_id, token, role, remark, expires_at, created_at) VALUES (NULL, ?, 'admin', 'superadmin', NULL, ?)")
          .run(token, now);
      }
    } catch {
      throw new AppError("ADMIN_PAT_CONFLICT", "超级管理员 PAT 与现有 PAT 冲突", 500);
    }
    return this.verifyPat(token)!;
  }

  /** 创建一个普通 PAT，并可选择绑定现有账号。 */
  createPat(remark: string, expiresAt: number | null, accountId: number | null = null): PatRecord {
    if (accountId !== null && !this.accountExists(accountId)) {
      throw new AppError("ACCOUNT_NOT_FOUND", "账号不存在", 404);
    }
    const token = generatePatToken();
    const createdAt = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare("INSERT INTO pats(account_id, token, role, remark, expires_at, created_at) VALUES (?, ?, 'user', ?, ?, ?)")
      .run(accountId, token, remark, expiresAt, createdAt);
    return this.verifyPatById(Number(result.lastInsertRowid))!;
  }

  /** 验证明文 PAT，并返回其可选账号绑定。 */
  verifyPat(token: string, now = Math.floor(Date.now() / 1000)): PatRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT p.*, a.uid
        FROM pats p
        LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.token = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
      `)
      .get(token, now) as SqlRow | undefined;
    return row ? this.patFromRow(row) : undefined;
  }

  /** 为管理员工具列出全部 PAT。 */
  listPats(): PatRecord[] {
    return (this.db
      .prepare("SELECT p.*, a.uid FROM pats p LEFT JOIN accounts a ON a.id = p.account_id ORDER BY p.id")
      .all() as SqlRow[]).map((row) => this.patFromRow(row));
  }

  /** 物理删除普通 PAT，并清理已无任何 PAT 引用的账号。 */
  deletePat(id: number): { localDataDeleted: boolean } | undefined {
    const row = this.db.prepare("SELECT account_id FROM pats WHERE id = ? AND role = 'user'").get(id) as SqlRow | undefined;
    if (!row) return undefined;
    const accountId = row.account_id === null ? null : Number(row.account_id);
    let localDataDeleted = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM pats WHERE id = ? AND role = 'user'").run(id);
      if (accountId !== null && !this.db.prepare("SELECT 1 FROM pats WHERE account_id = ?").get(accountId)) {
        this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
        localDataDeleted = true;
      }
      this.db.exec("COMMIT");
      return { localDataDeleted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 按主键读取仍有效的 PAT 绑定及服务端登录标识。 */
  getPatConnection(patId: number, now = Math.floor(Date.now() / 1000)): PatConnection | undefined {
    const row = this.db.prepare(`
      SELECT p.id AS pat_id, p.account_id, a.uid, a.login_identifier
      FROM pats p
      LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
    `).get(patId, now) as SqlRow | undefined;
    return row ? patConnectionFromRow(row) : undefined;
  }

  /** 将任意 PAT 原子绑定到已认证的钱迹账号。 */
  bindPat(
    patId: number,
    uid: string,
    utoken: string,
    devid: string,
    loginIdentifier: string | null = null,
  ): QianjiAccount {
    const now = Math.floor(Date.now() / 1000);
    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const pat = this.db.prepare("SELECT account_id FROM pats WHERE id = ?").get(patId) as SqlRow | undefined;
      if (!pat) throw new AppError("PAT_NOT_FOUND", "PAT 不存在", 404);
      const oldAccountId = pat.account_id === null ? null : Number(pat.account_id);
      if (oldAccountId !== null) {
        const current = this.db.prepare("SELECT uid FROM accounts WHERE id = ?").get(oldAccountId) as SqlRow | undefined;
        if (!current || String(current.uid) !== uid) {
          throw new AppError("QIANJI_ACCOUNT_MISMATCH", "重新登录的账号与当前已连接账号不一致");
        }
      }
      const existing = this.db.prepare("SELECT id FROM accounts WHERE uid = ?").get(uid) as SqlRow | undefined;
      let accountId: number;
      if (existing) {
        accountId = Number(existing.id);
        this.db.prepare("UPDATE accounts SET utoken = ?, devid = ?, login_identifier = COALESCE(?, login_identifier), updated_at = ? WHERE id = ?")
          .run(utoken, devid, loginIdentifier, now, accountId);
      } else {
        const result = this.db
          .prepare("INSERT INTO accounts(uid, utoken, devid, login_identifier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(uid, utoken, devid, loginIdentifier, now, now);
        accountId = Number(result.lastInsertRowid);
      }
      this.db.prepare("UPDATE pats SET account_id = ? WHERE id = ?").run(accountId, patId);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return this.requireAccount(accountId);
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      if (error instanceof AppError) throw error;
      throw new AppError("DATABASE_TRANSACTION_FAILED", "绑定事务失败并已回滚", 500);
    }
  }

  /** 解绑当前 PAT，并在没有共享引用时依靠外键级联删除账号本地数据。 */
  unbindPat(patId: number, expectedAccountId: number): UnbindResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT account_id FROM pats WHERE id = ?").get(patId) as SqlRow | undefined;
      if (!row) throw new AppError("PAT_NOT_FOUND", "PAT 不存在", 404);
      if (row.account_id === null || Number(row.account_id) !== expectedAccountId) {
        throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "当前 PAT 的账号绑定已变化");
      }
      this.db.prepare("UPDATE pats SET account_id = NULL WHERE id = ?").run(patId);
      const shared = Boolean(this.db.prepare("SELECT 1 FROM pats WHERE account_id = ?").get(expectedAccountId));
      if (!shared) this.db.prepare("DELETE FROM accounts WHERE id = ?").run(expectedAccountId);
      this.db.exec("COMMIT");
      return { localDataDeleted: !shared };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 读取已认证用户的账号绑定，不允许跨账号访问。 */
  requireAccount(accountId: number): QianjiAccount {
    const row = this.db
      .prepare("SELECT id, uid, utoken, devid FROM accounts WHERE id = ?")
      .get(accountId) as SqlRow | undefined;
    if (!row) throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "尚未绑定钱迹账号");
    return {
      id: Number(row.id),
      uid: String(row.uid),
      utoken: String(row.utoken),
      devid: String(row.devid),
    };
  }

  /** 读取钱迹用户缓存，不公开账号凭据。 */
  getUserCache(accountId: number): UserCache | undefined {
    const row = this.db
      .prepare("SELECT user_json, user_refreshed_at_ms FROM accounts WHERE id = ?")
      .get(accountId) as SqlRow | undefined;
    if (!row || row.user_json === null || row.user_refreshed_at_ms === null) return undefined;
    return {
      data: parseQianjiJson(String(row.user_json)) as Record<string, unknown>,
      refreshedAtMs: Number(row.user_refreshed_at_ms),
    };
  }

  /** 在登录或客户端初始化成功后替换钱迹用户缓存。 */
  setUserCache(accountId: number, user: Record<string, unknown>, refreshedAtMs = Date.now()): void {
    this.db
      .prepare("UPDATE accounts SET user_json = ?, user_refreshed_at_ms = ? WHERE id = ?")
      .run(JSON.stringify(user), refreshedAtMs, accountId);
  }

  /** 读取钱迹账号 UID 共用的持久化每日写入配额。 */
  getWriteQuota(accountId: number): WriteQuota {
    const row = this.db
      .prepare("SELECT write_quota_date, write_quota_used FROM accounts WHERE id = ?")
      .get(accountId) as SqlRow | undefined;
    if (!row) throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "尚未绑定钱迹账号");
    return {
      date: row.write_quota_date === null ? null : String(row.write_quota_date),
      used: Number(row.write_quota_used),
    };
  }

  /** 原子预占一个非 VIP 写入名额，并在自然日变化时重置旧计数。 */
  reserveWriteQuota(accountId: number, date: string, limit: number): WriteQuota {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWriteQuota(accountId);
      const used = current.date === date ? current.used : 0;
      if (used >= limit) {
        throw new AppError("DAILY_WRITE_LIMIT_REACHED", `今日成功业务写入已达到 ${limit} 次上限`);
      }
      const next = used + 1;
      this.db.prepare("UPDATE accounts SET write_quota_date = ?, write_quota_used = ? WHERE id = ?")
        .run(date, next, accountId);
      this.db.exec("COMMIT");
      return { date, used: next };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 在上游未接受写入时释放预占名额。 */
  releaseWriteQuota(accountId: number, date: string): void {
    this.db.prepare(`
      UPDATE accounts
      SET write_quota_used = write_quota_used - 1
      WHERE id = ? AND write_quota_date = ? AND write_quota_used > 0
    `).run(accountId, date);
  }

  /** 统计一个账号的全部本地缓存账单。 */
  countBills(accountId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM bills WHERE account_id = ?").get(accountId) as SqlRow;
    return Number(row.count);
  }

  /** 开始包含全部分页的同步事务。 */
  beginSync(): void {
    this.db.exec("BEGIN IMMEDIATE");
  }

  /** 提交一轮完整同步。 */
  commitSync(): void {
    this.db.exec("COMMIT");
  }

  /** 同时回滚账单缓存变化和未提交游标。 */
  rollbackSync(): void {
    this.db.exec("ROLLBACK");
  }

  /** 原子应用全部账单变化、缓存失效和最终游标。 */
  applySyncBatch(accountId: number, batch: SyncBatch): void {
    this.beginSync();
    try {
      for (const bill of batch.changes) this.upsertBill(accountId, bill);
      for (const id of batch.deletes) this.deleteBill(accountId, id);
      for (const scope of new Set(batch.invalidatedCategoryScopes)) {
        this.invalidateCatalogCache(accountId, "categories", scope);
      }
      this.setSyncState(accountId, batch.lasttimes);
      this.commitSync();
    } catch (error) {
      this.rollbackSync();
      throw error;
    }
  }

  /** 读取账号最后提交的全局同步游标。 */
  getSyncState(accountId: number): unknown | undefined {
    const row = this.db
      .prepare("SELECT lasttimes_json FROM sync_state WHERE account_id = ?")
      .get(accountId) as SqlRow | undefined;
    return row ? parseQianjiJson(String(row.lasttimes_json)) : undefined;
  }

  /** 在当前同步事务内写入最终上游游标。 */
  setSyncState(accountId: number, lasttimes: unknown): void {
    this.db
      .prepare(`
        INSERT INTO sync_state(account_id, lasttimes_json)
        VALUES (?, ?)
        ON CONFLICT(account_id) DO UPDATE SET lasttimes_json = excluded.lasttimes_json
      `)
      .run(accountId, JSON.stringify(lasttimes));
  }

  /** 读取账号范围内的目录快照及成功刷新时间。 */
  getCatalogCache(accountId: number, kind: CatalogKind, scope = ""): CatalogCache | undefined {
    const row = this.db
      .prepare("SELECT data_json, refreshed_at_ms FROM catalog_cache WHERE account_id = ? AND kind = ? AND scope = ?")
      .get(accountId, kind, scope) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      data: parseQianjiJson(String(row.data_json)) as Record<string, unknown>[],
      refreshedAtMs: Number(row.refreshed_at_ms),
    };
  }

  /** 上游刷新成功后替换账号范围内的目录快照。 */
  setCatalogCache(
    accountId: number,
    kind: CatalogKind,
    scope: string,
    data: Record<string, unknown>[],
    refreshedAtMs = Date.now(),
  ): void {
    this.db
      .prepare(`
        INSERT INTO catalog_cache(account_id, kind, scope, data_json, refreshed_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, kind, scope) DO UPDATE SET
          data_json = excluded.data_json,
          refreshed_at_ms = excluded.refreshed_at_ms
      `)
      .run(accountId, kind, scope, JSON.stringify(data), refreshedAtMs);
  }

  /** 在调用方当前事务内使一个目录快照失效。 */
  invalidateCatalogCache(accountId: number, kind: CatalogKind, scope: string): void {
    this.db.prepare("DELETE FROM catalog_cache WHERE account_id = ? AND kind = ? AND scope = ?")
      .run(accountId, kind, scope);
  }

  /** 写入任意上游账单类型，并保留完整原始 JSON。 */
  upsertBill(accountId: number, bill: Record<string, unknown>): void {
    const normalized = normalizeBillForStorage(bill);
    this.db
      .prepare(`
        INSERT INTO bills(account_id, id, bookid, time, type, money, cateid, assetid, remark, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, id) DO UPDATE SET
          bookid = excluded.bookid, time = excluded.time, type = excluded.type,
          money = excluded.money, cateid = excluded.cateid, assetid = excluded.assetid,
          remark = excluded.remark, raw_json = excluded.raw_json
      `)
      .run(
        accountId,
        normalized.id,
        normalized.bookId,
        normalized.time,
        normalized.type,
        normalized.money,
        normalized.categoryId,
        normalized.assetId,
        normalized.remark,
        normalized.rawJson,
      );
  }

  /** 原子保存成功返回的多账单响应，并可选择使资产快照失效。 */
  saveConfirmedBills(
    accountId: number,
    bills: Record<string, unknown>[],
    invalidateAssets = false,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const bill of bills) this.upsertBill(accountId, bill);
      if (invalidateAssets) this.invalidateCatalogCache(accountId, "assets", "");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 在当前同步事务内删除一条上游账单。 */
  deleteBill(accountId: number, id: string): void {
    this.db.prepare("DELETE FROM bills WHERE account_id = ? AND id = ?").run(accountId, id);
  }

  /** 仅在已认证钱迹账号范围内读取完整账单。 */
  getBill(accountId: number, id: string): BillRow | undefined {
    const row = this.db
      .prepare("SELECT id, CAST(bookid AS TEXT) AS bookid, time, type, money, CASE cateid WHEN -1 THEN NULL ELSE CAST(cateid AS TEXT) END AS cateid, CAST(assetid AS TEXT) AS assetid, remark, raw_json FROM bills WHERE account_id = ? AND id = ?")
      .get(accountId, id) as SqlRow | undefined;
    return row ? this.billFromRow(row) : undefined;
  }

  /** 应用账号范围内的键集筛选，并为分页多返回一行。 */
  listBills(accountId: number, filters: BillFilters): BillRow[] {
    const where = ["account_id = ?"];
    const params: Array<string | number> = [accountId];
    // 仅拼接调用方显式提供的筛选，参数始终通过预编译语句绑定。
    const add = (sql: string, value: string | number | undefined): void => {
      if (value !== undefined) {
        where.push(sql);
        params.push(value);
      }
    };
    add("bookid = ?", filters.bookId);
    add("time >= ?", filters.startTime);
    add("time <= ?", filters.endTime);
    add("CAST(json_extract(raw_json, '$.createtime') AS INTEGER) >= ?", filters.createStartTime);
    add("CAST(json_extract(raw_json, '$.createtime') AS INTEGER) <= ?", filters.createEndTime);
    add("type = ?", filters.type);
    add("cateid = ?", filters.categoryId);
    add("instr(lower(remark), lower(?)) > 0", filters.remarkKeyword);
    add("assetid = ?", filters.assetId);
    add("CAST(json_extract(raw_json, '$.fromid') AS TEXT) = ?", filters.fromAssetId);
    add("CAST(json_extract(raw_json, '$.targetid') AS TEXT) = ?", filters.targetAssetId);
    if (filters.tagId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM json_each(bills.raw_json, '$.extra.tags') WHERE CAST(value AS TEXT) = ?)");
      params.push(filters.tagId);
    }
    if (filters.cursor) {
      where.push("(time < ? OR (time = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER)))");
      params.push(filters.cursor.time, filters.cursor.time, filters.cursor.id);
    }
    params.push(filters.limit + 1);
    const rows = this.db
      .prepare(`SELECT id, CAST(bookid AS TEXT) AS bookid, time, type, money, CASE cateid WHEN -1 THEN NULL ELSE CAST(cateid AS TEXT) END AS cateid, CAST(assetid AS TEXT) AS assetid, remark, raw_json FROM bills WHERE ${where.join(" AND ")} ORDER BY time DESC, CAST(id AS INTEGER) DESC LIMIT ?`)
      .all(...params) as SqlRow[];
    return rows.map((row) => this.billFromRow(row));
  }

  /** 判断本地账号是否存在。 */
  private accountExists(accountId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId));
  }

  /** 为早于用户缓存功能创建的数据库补充缓存和配额列。 */
  private migrateAccountCache(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(accounts)").all() as SqlRow[]).map(({ name }) => String(name)),
    );
    const missing = [
      ["user_json", "TEXT"],
      ["user_refreshed_at_ms", "INTEGER"],
      ["write_quota_date", "TEXT"],
      ["write_quota_used", "INTEGER NOT NULL DEFAULT 0 CHECK (write_quota_used >= 0)"],
      ["login_identifier", "TEXT"],
    ].filter(([name]) => !columns.has(name!));
    if (missing.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [name, definition] of missing) {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 删除已废弃的只读 PAT 列，同时保留现有凭据和绑定。 */
  private migrateLegacyPatScopes(): void {
    const columns = this.db.prepare("PRAGMA table_info(pats)").all() as SqlRow[];
    if (!columns.some(({ name }) => name === "scopes")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("ALTER TABLE pats DROP COLUMN scopes");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 将已废弃的逐账本游标表收敛为同步使用的单一全局游标。 */
  private migrateSyncState(): void {
    const columns = this.db.prepare("PRAGMA table_info(sync_state)").all() as SqlRow[];
    if (!columns.some(({ name }) => name === "bookid")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS sync_state_new;
        CREATE TABLE sync_state_new (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          lasttimes_json TEXT NOT NULL
        );
        INSERT OR REPLACE INTO sync_state_new(account_id, lasttimes_json)
          SELECT account_id, lasttimes_json FROM sync_state WHERE bookid = -1;
        DROP TABLE sync_state;
        ALTER TABLE sync_state_new RENAME TO sync_state;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 扩展目录缓存允许值，并在同一事务内保留现有快照。 */
  private migrateCatalogCacheKinds(): void {
    const definition = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'catalog_cache'")
      .get() as SqlRow | undefined;
    if (String(definition?.sql ?? "").includes("'currencies'")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS catalog_cache_new;
        CREATE TABLE catalog_cache_new (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('books', 'assets', 'categories', 'tags', 'currencies')),
          scope TEXT NOT NULL,
          data_json TEXT NOT NULL,
          refreshed_at_ms INTEGER NOT NULL,
          PRIMARY KEY (account_id, kind, scope)
        );
        INSERT INTO catalog_cache_new(account_id, kind, scope, data_json, refreshed_at_ms)
          SELECT account_id, kind, scope, data_json, refreshed_at_ms FROM catalog_cache;
        DROP TABLE catalog_cache;
        ALTER TABLE catalog_cache_new RENAME TO catalog_cache;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 删除已废弃的规范化目录表，当前快照仅保存在 `catalog_cache`。 */
  private dropLegacyReferenceCaches(): void {
    this.db.exec("DROP TABLE IF EXISTS books; DROP TABLE IF EXISTS assets; DROP TABLE IF EXISTS categories; DROP TABLE IF EXISTS tags;");
  }

  /** 按主键读取 PAT，并附加可选的钱迹 UID。 */
  private verifyPatById(id: number): PatRecord | undefined {
    const row = this.db
      .prepare("SELECT p.*, a.uid FROM pats p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.patFromRow(row) : undefined;
  }

  /** 将 SQLite 行转换为 PAT 领域对象。 */
  private patFromRow(row: SqlRow): PatRecord {
    return {
      id: Number(row.id),
      accountId: row.account_id === null ? null : Number(row.account_id),
      uid: row.uid === null ? null : String(row.uid),
      token: String(row.token),
      role: String(row.role) as PatRole,
      remark: String(row.remark),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      createdAt: Number(row.created_at),
    };
  }

  /** 将 SQLite 行转换为账单查询对象。 */
  private billFromRow(row: SqlRow): BillRow {
    return {
      id: String(row.id),
      bookid: String(row.bookid),
      time: Number(row.time),
      type: Number(row.type),
      money: Number(row.money),
      cateid: row.cateid === null ? null : String(row.cateid),
      assetid: String(row.assetid),
      remark: String(row.remark),
      rawJson: String(row.raw_json),
    };
  }
}

function patConnectionFromRow(row: SqlRow): PatConnection {
  return {
    patId: Number(row.pat_id),
    accountId: row.account_id === null ? null : Number(row.account_id),
    uid: row.uid === null ? null : String(row.uid),
    loginIdentifier: row.login_identifier === null ? null : String(row.login_identifier),
  };
}

/** 在任一数据库后端持久化前统一校验上游账单身份字段。 */
export function normalizeBillForStorage(bill: Record<string, unknown>): StoredBill {
  const id = String(bill.id);
  if (!isPositiveLongId(id)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单缺少有效 ID", 502);
  }
  const type = Number(bill.type);
  if (!Number.isInteger(type)) throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单类型无效", 502);
  const money = typeof bill.money === "number" || (typeof bill.money === "string" && bill.money.trim() !== "")
    ? Number(bill.money)
    : Number.NaN;
  if (!Number.isFinite(money) || money < 0) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单金额无效", 502);
  }
  if (bill.extra !== undefined && bill.extra !== null && (!bill.extra || typeof bill.extra !== "object" || Array.isArray(bill.extra))) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单扩展金额信息无效", 502);
  }
  const extra = bill.extra as Record<string, unknown> | undefined;
  if (extra?.transfee !== undefined && extra.transfee !== null) {
    const adjustment = typeof extra.transfee === "number" || (typeof extra.transfee === "string" && extra.transfee.trim() !== "")
      ? Number(extra.transfee)
      : Number.NaN;
    if (!Number.isFinite(adjustment)) {
      throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹账单手续费或优惠金额无效", 502);
    }
  }
  validatedCurrencyConversion(bill);
  refundRelationshipMap(bill);
  reimbursementRelationshipMap(bill);
  return {
    id,
    bookId: storedOptionalPositiveId(bill.bookid, "账本"),
    time: Number(bill.time),
    type,
    money,
    categoryId: storedOptionalPositiveId(bill.cateid ?? -1, "分类"),
    assetId: storedOptionalPositiveId(bill.assetid ?? -1, "资产"),
    remark: String(bill.remark ?? ""),
    rawJson: JSON.stringify(bill),
  };
}

/** 校验允许 `-1` 哨兵值的存储层引用 ID。 */
function storedOptionalPositiveId(value: unknown, resource: string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `超出安全范围的${resource} ID 必须使用十进制字符串`, 502);
  }
  const text = String(value);
  if (!isOptionalPositiveLongId(text)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹${resource}缺少有效 ID`, 502);
  }
  return text;
}
