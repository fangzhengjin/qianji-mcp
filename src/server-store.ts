import { SQL } from "bun";

import {
  Store,
  generatePatToken,
  normalizeBillForStorage,
  type BillFilters,
  type BillRow,
  type CatalogCache,
  type CatalogKind,
  type DataStore,
  type PatConnection,
  type PatRecord,
  type QianjiAccount,
  type SyncBatch,
  type UserCache,
  type UnbindResult,
  type WriteQuota,
} from "./data-store.ts";
import { AppError } from "./errors.ts";
import { parseQianjiJson } from "./qianji-client.ts";

type Dialect = "postgres" | "mysql";
type Row = Record<string, unknown>;

/** 未配置服务端数据库地址时使用 SQLite，否则创建 PostgreSQL 或 MySQL 存储。 */
export async function createDataStore(databasePath: string, databaseUrl?: URL): Promise<DataStore> {
  if (!databaseUrl) return new Store(databasePath);
  const store = new ServerStore(databaseUrl);
  try {
    await store.initialize();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** 基于 Bun.SQL 的 PostgreSQL 或 MySQL 持久化实现。 */
export class ServerStore implements DataStore {
  private readonly sql: SQL;
  private readonly dialect: Dialect;

  /** 根据数据库 URL 选择方言并创建连接池。 */
  constructor(url: URL) {
    this.dialect = url.protocol === "mysql:" ? "mysql" : "postgres";
    this.sql = new SQL({ url, adapter: this.dialect, bigint: true });
  }

  /** 在专用空数据库中创建当前 Schema，或验证已初始化版本。 */
  async initialize(): Promise<void> {
    const existingTables = (await this.query(this.sql, this.dialect === "postgres"
      ? "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('qianji_schema_versions', 'accounts', 'pats', 'sync_state', 'catalog_cache', 'bills')"
      : "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('qianji_schema_versions', 'accounts', 'pats', 'sync_state', 'catalog_cache', 'bills')"))
      .map((row) => String(Object.values(row)[0]));
    if (existingTables.includes("qianji_schema_versions")) {
      const versions = await this.query(this.sql, "SELECT version FROM qianji_schema_versions ORDER BY version");
      if (versions.length !== 1 || existingTables.length !== 6) {
        throw new Error("Unsupported or incomplete qianji-mcp database schema");
      }
      const version = Number(versions[0]!.version);
      if (version === 1) {
        await this.migrateToVersion2();
        await this.migrateToVersion3();
        return;
      }
      if (version === 2) {
        await this.migrateToVersion3();
        return;
      }
      if (version !== 3 || !(await this.hasLoginIdentifierColumn())) {
        throw new Error("Unsupported or incomplete qianji-mcp database schema");
      }
      return;
    }
    if (existingTables.length > 0) throw new Error("QIANJI_MCP_DATABASE_URL must reference an empty or initialized qianji-mcp database");
    await this.sql.unsafe(`CREATE TABLE qianji_schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )${this.dialect === "mysql" ? " ENGINE=InnoDB" : ""}`);
    for (const statement of schemaStatements(this.dialect)) await this.sql.unsafe(statement);
    await this.query(this.sql, "INSERT INTO qianji_schema_versions(version, applied_at) VALUES (?, ?)", [3, unixNow()]);
  }

  /** 关闭 Bun.SQL 连接池。 */
  async close(): Promise<void> {
    await this.sql.close();
  }

  /** 创建或轮换启动配置管理的管理员 PAT，同时保留现有绑定。 */
  async ensureAdminPat(token: string): Promise<PatRecord> {
    try {
      await this.sql.begin(async (tx) => {
        const existing = (await this.query(tx, "SELECT id FROM pats WHERE role = ? FOR UPDATE", ["admin"]))[0];
        if (existing) {
          await this.query(tx, "UPDATE pats SET token = ?, remark = 'superadmin', expires_at = NULL WHERE id = ?", [token, existing.id]);
        } else {
          await this.query(tx, "INSERT INTO pats(account_id, token, role, remark, expires_at, created_at) VALUES (NULL, ?, 'admin', 'superadmin', NULL, ?)", [token, unixNow()]);
        }
      });
    } catch {
      const concurrent = await this.verifyPat(token);
      if (concurrent?.role === "admin") return concurrent;
      throw new AppError("ADMIN_PAT_CONFLICT", "超级管理员 PAT 与现有 PAT 冲突", 500);
    }
    return (await this.verifyPat(token))!;
  }

  /** 创建一个普通 PAT，并可选择绑定现有账号。 */
  async createPat(remark: string, expiresAt: number | null, accountId: number | null = null): Promise<PatRecord> {
    if (accountId !== null && !(await this.query(this.sql, "SELECT 1 FROM accounts WHERE id = ?", [accountId]))[0]) {
      throw new AppError("ACCOUNT_NOT_FOUND", "账号不存在", 404);
    }
    const token = generatePatToken();
    await this.query(this.sql, "INSERT INTO pats(account_id, token, role, remark, expires_at, created_at) VALUES (?, ?, 'user', ?, ?, ?)", [accountId, token, remark, expiresAt, unixNow()]);
    return (await this.verifyPat(token))!;
  }

  /** 验证明文 PAT，并返回其可选账号绑定。 */
  async verifyPat(token: string, now = unixNow()): Promise<PatRecord | undefined> {
    const row = (await this.query(this.sql, `
      SELECT p.*, a.uid FROM pats p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.token = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
    `, [token, now]))[0];
    return row ? patFromRow(row) : undefined;
  }

  /** 为管理员工具列出全部 PAT。 */
  async listPats(): Promise<PatRecord[]> {
    return (await this.query(this.sql, "SELECT p.*, a.uid FROM pats p LEFT JOIN accounts a ON a.id = p.account_id ORDER BY p.id")).map(patFromRow);
  }

  /** 删除普通 PAT，并清理已无任何 PAT 引用的账号。 */
  async deletePat(id: number): Promise<{ localDataDeleted: boolean } | undefined> {
    return this.sql.begin(async (tx) => {
      const row = (await this.query(tx, "SELECT account_id FROM pats WHERE id = ? AND role = 'user' FOR UPDATE", [id]))[0];
      if (!row) return undefined;
      if (row.account_id !== null) await this.query(tx, "SELECT id FROM accounts WHERE id = ? FOR UPDATE", [row.account_id]);
      await this.query(tx, "DELETE FROM pats WHERE id = ? AND role = 'user'", [id]);
      let localDataDeleted = false;
      if (row.account_id !== null && !(await this.query(tx, "SELECT 1 FROM pats WHERE account_id = ?", [row.account_id]))[0]) {
        await this.query(tx, "DELETE FROM accounts WHERE id = ?", [row.account_id]);
        localDataDeleted = true;
      }
      return { localDataDeleted };
    });
  }

  /** 按主键读取仍有效的 PAT 绑定及服务端登录标识。 */
  async getPatConnection(patId: number, now = unixNow()): Promise<PatConnection | undefined> {
    const row = (await this.query(this.sql, `
      SELECT p.id AS pat_id, p.account_id, a.uid, a.login_identifier
      FROM pats p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
    `, [patId, now]))[0];
    return row ? patConnectionFromRow(row) : undefined;
  }

  /** 将任意 PAT 原子绑定到已认证的钱迹账号。 */
  async bindPat(
    patId: number,
    uid: string,
    utoken: string,
    devid: string,
    loginIdentifier: string | null = null,
  ): Promise<QianjiAccount> {
    try {
      const accountId = await this.sql.begin(async (tx) => {
        const pat = (await this.query(tx, "SELECT account_id FROM pats WHERE id = ? FOR UPDATE", [patId]))[0];
        if (!pat) throw new AppError("PAT_NOT_FOUND", "PAT 不存在", 404);
        const oldAccountId = pat.account_id === null ? null : Number(pat.account_id);
        if (oldAccountId !== null) {
          const current = (await this.query(tx, "SELECT uid FROM accounts WHERE id = ? FOR UPDATE", [oldAccountId]))[0];
          if (!current || String(current.uid) !== uid) {
            throw new AppError("QIANJI_ACCOUNT_MISMATCH", "重新登录的账号与当前已连接账号不一致");
          }
        }
        const now = unixNow();
        await this.upsert(tx, "accounts", ["uid", "utoken", "devid", "created_at", "updated_at"], [uid, utoken, devid, now, now], ["utoken", "devid", "updated_at"]);
        const account = (await this.query(tx, "SELECT id FROM accounts WHERE uid = ? FOR UPDATE", [uid]))[0]!;
        const accountId = Number(account.id);
        if (loginIdentifier !== null) {
          await this.query(tx, "UPDATE accounts SET login_identifier = ? WHERE id = ?", [loginIdentifier, accountId]);
        }
        await this.query(tx, "UPDATE pats SET account_id = ? WHERE id = ?", [accountId, patId]);
        return accountId;
      });
      return this.requireAccount(accountId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("DATABASE_TRANSACTION_FAILED", "绑定事务失败并已回滚", 500);
    }
  }

  /** 解绑当前 PAT，并在没有共享引用时依靠外键级联删除账号本地数据。 */
  async unbindPat(patId: number, expectedAccountId: number): Promise<UnbindResult> {
    return this.sql.begin(async (tx) => {
      const row = (await this.query(tx, "SELECT account_id FROM pats WHERE id = ? FOR UPDATE", [patId]))[0];
      if (!row) throw new AppError("PAT_NOT_FOUND", "PAT 不存在", 404);
      if (row.account_id === null || Number(row.account_id) !== expectedAccountId) {
        throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "当前 PAT 的账号绑定已变化");
      }
      await this.query(tx, "SELECT id FROM accounts WHERE id = ? FOR UPDATE", [expectedAccountId]);
      await this.query(tx, "UPDATE pats SET account_id = NULL WHERE id = ?", [patId]);
      const shared = Boolean((await this.query(tx, "SELECT 1 FROM pats WHERE account_id = ?", [expectedAccountId]))[0]);
      if (!shared) await this.query(tx, "DELETE FROM accounts WHERE id = ?", [expectedAccountId]);
      return { localDataDeleted: !shared };
    });
  }

  /** 按本地主键读取已绑定账号。 */
  async requireAccount(accountId: number): Promise<QianjiAccount> {
    const row = (await this.query(this.sql, "SELECT id, uid, utoken, devid FROM accounts WHERE id = ?", [accountId]))[0];
    if (!row) throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "尚未绑定钱迹账号");
    return { id: Number(row.id), uid: String(row.uid), utoken: String(row.utoken), devid: String(row.devid) };
  }

  /** 读取用户缓存，不公开账号凭据。 */
  async getUserCache(accountId: number): Promise<UserCache | undefined> {
    const row = (await this.query(this.sql, "SELECT user_json, user_refreshed_at_ms FROM accounts WHERE id = ?", [accountId]))[0];
    if (!row || row.user_json === null || row.user_refreshed_at_ms === null) return undefined;
    return { data: parseQianjiJson(String(row.user_json)) as Record<string, unknown>, refreshedAtMs: Number(row.user_refreshed_at_ms) };
  }

  /** 上游请求成功后替换用户缓存。 */
  async setUserCache(accountId: number, user: Record<string, unknown>, refreshedAtMs = Date.now()): Promise<void> {
    await this.query(this.sql, "UPDATE accounts SET user_json = ?, user_refreshed_at_ms = ? WHERE id = ?", [JSON.stringify(user), refreshedAtMs, accountId]);
  }

  /** 读取持久化的每日写入配额。 */
  async getWriteQuota(accountId: number): Promise<WriteQuota> {
    const row = (await this.query(this.sql, "SELECT write_quota_date, write_quota_used FROM accounts WHERE id = ?", [accountId]))[0];
    if (!row) throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "尚未绑定钱迹账号");
    return { date: row.write_quota_date === null ? null : String(row.write_quota_date), used: Number(row.write_quota_used) };
  }

  /** 使用跨进程共享的行锁预占一个非 VIP 写入名额。 */
  async reserveWriteQuota(accountId: number, date: string, limit: number): Promise<WriteQuota> {
    return this.sql.begin(async (tx) => {
      const row = (await this.query(tx, "SELECT write_quota_date, write_quota_used FROM accounts WHERE id = ? FOR UPDATE", [accountId]))[0];
      if (!row) throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "尚未绑定钱迹账号");
      const used = row.write_quota_date === date ? Number(row.write_quota_used) : 0;
      if (used >= limit) throw new AppError("DAILY_WRITE_LIMIT_REACHED", `今日成功业务写入已达到 ${limit} 次上限`);
      await this.query(tx, "UPDATE accounts SET write_quota_date = ?, write_quota_used = ? WHERE id = ?", [date, used + 1, accountId]);
      return { date, used: used + 1 };
    });
  }

  /** 上游未接受写入时释放预占名额。 */
  async releaseWriteQuota(accountId: number, date: string): Promise<void> {
    await this.query(this.sql, "UPDATE accounts SET write_quota_used = write_quota_used - 1 WHERE id = ? AND write_quota_date = ? AND write_quota_used > 0", [accountId, date]);
  }

  /** 统计一个账号的全部本地缓存账单。 */
  async countBills(accountId: number): Promise<number> {
    return Number((await this.query(this.sql, "SELECT COUNT(*) AS count FROM bills WHERE account_id = ?", [accountId]))[0]!.count);
  }

  /** 读取最后完整提交的同步游标。 */
  async getSyncState(accountId: number): Promise<unknown | undefined> {
    const row = (await this.query(this.sql, "SELECT lasttimes_json FROM sync_state WHERE account_id = ?", [accountId]))[0];
    return row ? parseQianjiJson(String(row.lasttimes_json)) : undefined;
  }

  /** 在一个事务中应用全部分页、删除、缓存失效和最终游标。 */
  async applySyncBatch(accountId: number, batch: SyncBatch): Promise<void> {
    await this.sql.begin(async (tx) => {
      for (const bill of batch.changes) await this.upsertBill(tx, accountId, bill);
      for (const id of batch.deletes) await this.query(tx, "DELETE FROM bills WHERE account_id = ? AND id = ?", [accountId, id]);
      for (const scope of new Set(batch.invalidatedCategoryScopes)) {
        await this.query(tx, "DELETE FROM catalog_cache WHERE account_id = ? AND kind = 'categories' AND scope = ?", [accountId, scope]);
      }
      await this.upsert(tx, "sync_state", ["account_id", "lasttimes_json"], [accountId, JSON.stringify(batch.lasttimes)], ["lasttimes_json"]);
    });
  }

  /** 读取账号范围内的目录快照。 */
  async getCatalogCache(accountId: number, kind: CatalogKind, scope = ""): Promise<CatalogCache | undefined> {
    const row = (await this.query(this.sql, "SELECT data_json, refreshed_at_ms FROM catalog_cache WHERE account_id = ? AND kind = ? AND scope = ?", [accountId, kind, scope]))[0];
    return row ? { data: parseQianjiJson(String(row.data_json)) as Record<string, unknown>[], refreshedAtMs: Number(row.refreshed_at_ms) } : undefined;
  }

  /** 替换账号范围内的目录快照。 */
  async setCatalogCache(accountId: number, kind: CatalogKind, scope: string, data: Record<string, unknown>[], refreshedAtMs = Date.now()): Promise<void> {
    await this.upsert(this.sql, "catalog_cache", ["account_id", "kind", "scope", "data_json", "refreshed_at_ms"], [accountId, kind, scope, JSON.stringify(data), refreshedAtMs], ["data_json", "refreshed_at_ms"]);
  }

  /** 使账号范围内的目录快照失效。 */
  async invalidateCatalogCache(accountId: number, kind: CatalogKind, scope: string): Promise<void> {
    await this.query(this.sql, "DELETE FROM catalog_cache WHERE account_id = ? AND kind = ? AND scope = ?", [accountId, kind, scope]);
  }

  /** 原子保存成功返回的多账单响应。 */
  async saveConfirmedBills(accountId: number, bills: Record<string, unknown>[], invalidateAssets = false): Promise<void> {
    await this.sql.begin(async (tx) => {
      for (const bill of bills) await this.upsertBill(tx, accountId, bill);
      if (invalidateAssets) await this.query(tx, "DELETE FROM catalog_cache WHERE account_id = ? AND kind = 'assets' AND scope = ''", [accountId]);
    });
  }

  /** 读取账号范围内的一条完整账单。 */
  async getBill(accountId: number, id: string): Promise<BillRow | undefined> {
    const row = (await this.query(this.sql, "SELECT id, bookid, time, type, money, cateid, assetid, remark, raw_json FROM bills WHERE account_id = ? AND id = ?", [accountId, id]))[0];
    return row ? billFromRow(row) : undefined;
  }

  /** 应用账号范围内的键集筛选，并为分页多返回一行。 */
  async listBills(accountId: number, filters: BillFilters): Promise<BillRow[]> {
    const where = ["account_id = ?"];
    const values: unknown[] = [accountId];
    // 仅拼接调用方显式提供的筛选，参数统一交给 Bun.SQL 绑定。
    const add = (clause: string, value: unknown): void => {
      if (value !== undefined) { where.push(clause); values.push(value); }
    };
    add("bookid = ?", filters.bookId);
    add("time >= ?", filters.startTime);
    add("time <= ?", filters.endTime);
    if (this.dialect === "postgres") {
      add("CAST(raw_json::jsonb ->> 'createtime' AS BIGINT) >= ?", filters.createStartTime);
      add("CAST(raw_json::jsonb ->> 'createtime' AS BIGINT) <= ?", filters.createEndTime);
    } else {
      add("CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.createtime')) AS UNSIGNED) >= ?", filters.createStartTime);
      add("CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.createtime')) AS UNSIGNED) <= ?", filters.createEndTime);
    }
    add("type = ?", filters.type);
    add("cateid = ?", filters.categoryId);
    add(this.dialect === "postgres" ? "STRPOS(LOWER(remark), LOWER(?)) > 0" : "INSTR(LOWER(remark), LOWER(?)) > 0", filters.remarkKeyword);
    add("assetid = ?", filters.assetId);
    if (this.dialect === "postgres") {
      add("raw_json::jsonb ->> 'fromid' = ?", filters.fromAssetId);
      add("raw_json::jsonb ->> 'targetid' = ?", filters.targetAssetId);
    } else {
      add("JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fromid')) = CAST(? AS CHAR)", filters.fromAssetId);
      add("JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.targetid')) = CAST(? AS CHAR)", filters.targetAssetId);
    }
    if (filters.tagId !== undefined) {
      where.push(this.dialect === "postgres"
        ? "EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(raw_json::jsonb #> '{extra,tags}', '[]'::jsonb)) AS tags(value) WHERE tags.value = ?)"
        : "EXISTS (SELECT 1 FROM JSON_TABLE(COALESCE(JSON_EXTRACT(raw_json, '$.extra.tags'), JSON_ARRAY()), '$[*]' COLUMNS(tag_id VARCHAR(255) PATH '$')) AS tags WHERE tags.tag_id COLLATE utf8mb4_bin = CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin)");
      values.push(filters.tagId);
    }
    if (filters.cursor) {
      where.push("(time < ? OR (time = ? AND id < ?))");
      values.push(filters.cursor.time, filters.cursor.time, filters.cursor.id);
    }
    values.push(filters.limit + 1);
    const rows = await this.query(this.sql, `SELECT id, bookid, time, type, money, cateid, assetid, remark, raw_json FROM bills WHERE ${where.join(" AND ")} ORDER BY time DESC, id DESC LIMIT ?`, values);
    return rows.map(billFromRow);
  }

  /** 规范化并写入一条完整账单。 */
  private async upsertBill(client: SQL, accountId: number, bill: Record<string, unknown>): Promise<void> {
    const value = normalizeBillForStorage(bill);
    await this.upsert(client, "bills", ["account_id", "id", "bookid", "time", "type", "money", "cateid", "assetid", "remark", "raw_json"], [accountId, value.id, value.bookId, value.time, value.type, value.money, value.categoryId, value.assetId, value.remark, value.rawJson], ["bookid", "time", "type", "money", "cateid", "assetid", "remark", "raw_json"]);
  }

  /** 按数据库方言构造受控表名集合中的 upsert 语句。 */
  private async upsert(client: SQL, table: string, columns: string[], values: unknown[], updated: string[]): Promise<void> {
    const placeholders = columns.map(() => "?").join(", ");
    const conflict = table === "bills" ? "account_id, id" : table === "catalog_cache" ? "account_id, kind, scope" : table === "accounts" ? "uid" : "account_id";
    const update = this.dialect === "postgres"
      ? `ON CONFLICT (${conflict}) DO UPDATE SET ${updated.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}`
      : `ON DUPLICATE KEY UPDATE ${updated.map((column) => `${column} = VALUES(${column})`).join(", ")}`;
    await this.query(client, `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ${update}`, values);
  }

  /** 将通用问号占位符转换为目标方言，并执行参数化查询。 */
  private query(client: SQL, statement: string, values: unknown[] = []): Promise<Row[]> {
    let index = 0;
    const sql = this.dialect === "postgres" ? statement.replaceAll("?", () => `$${++index}`) : statement;
    return client.unsafe<Row[]>(sql, values) as unknown as Promise<Row[]>;
  }

  /** 从版本 1 增加可空登录标识，列先落地，使 MySQL DDL 中断后可幂等重试。 */
  private async migrateToVersion2(): Promise<void> {
    if (!(await this.hasLoginIdentifierColumn())) {
      await this.sql.unsafe("ALTER TABLE accounts ADD COLUMN login_identifier VARCHAR(320)");
    }
    await this.sql.begin(async (tx) => {
      await this.query(tx, "DELETE FROM qianji_schema_versions WHERE version = 1");
      await this.query(tx, "INSERT INTO qianji_schema_versions(version, applied_at) VALUES (?, ?)", [2, unixNow()]);
    });
  }

  /** 将目录缓存约束扩展到内部币种目录，DDL 可幂等重试且不改现有快照数据。 */
  private async migrateToVersion3(): Promise<void> {
    const rows = await this.query(this.sql, this.dialect === "postgres"
      ? "SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = current_schema() AND table_name = 'catalog_cache' AND constraint_type = 'CHECK'"
      : "SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'catalog_cache' AND constraint_type = 'CHECK'");
    for (const row of rows) {
      const name = String(row.constraint_name);
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unsupported catalog_cache constraint name");
      await this.sql.unsafe(this.dialect === "postgres"
        ? `ALTER TABLE catalog_cache DROP CONSTRAINT "${name}"`
        : `ALTER TABLE catalog_cache DROP CHECK \`${name}\``);
    }
    await this.sql.unsafe("ALTER TABLE catalog_cache ADD CONSTRAINT qianji_catalog_kind_check CHECK (kind IN ('books', 'assets', 'categories', 'tags', 'currencies'))");
    await this.sql.begin(async (tx) => {
      await this.query(tx, "DELETE FROM qianji_schema_versions WHERE version = 2");
      await this.query(tx, "INSERT INTO qianji_schema_versions(version, applied_at) VALUES (?, ?)", [3, unixNow()]);
    });
  }

  private async hasLoginIdentifierColumn(): Promise<boolean> {
    const rows = await this.query(this.sql, this.dialect === "postgres"
      ? "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'accounts' AND column_name = 'login_identifier'"
      : "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'accounts' AND column_name = 'login_identifier'");
    return rows.length === 1;
  }
}

/** 将服务端数据库行转换为 PAT 领域对象。 */
function patFromRow(row: Row): PatRecord {
  return { id: Number(row.id), accountId: row.account_id === null ? null : Number(row.account_id), uid: row.uid === null ? null : String(row.uid), token: String(row.token), role: String(row.role) as PatRecord["role"], remark: String(row.remark), expiresAt: row.expires_at === null ? null : Number(row.expires_at), createdAt: Number(row.created_at) };
}

function patConnectionFromRow(row: Row): PatConnection {
  return { patId: Number(row.pat_id), accountId: row.account_id === null ? null : Number(row.account_id), uid: row.uid === null ? null : String(row.uid), loginIdentifier: row.login_identifier === null ? null : String(row.login_identifier) };
}

/** 将服务端数据库行转换为账单查询对象。 */
function billFromRow(row: Row): BillRow {
  return { id: String(row.id), bookid: String(row.bookid), time: Number(row.time), type: Number(row.type), money: Number(row.money), cateid: String(row.cateid) === "-1" ? null : String(row.cateid), assetid: String(row.assetid), remark: String(row.remark), rawJson: String(row.raw_json) };
}

/** 返回当前 Unix 秒。 */
function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** 按数据库方言生成当前 Schema 语句。 */
function schemaStatements(dialect: Dialect): string[] {
  const serial = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "BIGINT AUTO_INCREMENT PRIMARY KEY";
  const text = dialect === "postgres" ? "TEXT" : "LONGTEXT";
  const double = dialect === "postgres" ? "DOUBLE PRECISION" : "DOUBLE";
  const adminColumn = dialect === "mysql" ? ", admin_guard VARCHAR(5) GENERATED ALWAYS AS (CASE WHEN role = 'admin' THEN 'admin' ELSE NULL END) STORED UNIQUE" : "";
  const statements = [
    `CREATE TABLE IF NOT EXISTS accounts (id ${serial}, uid VARCHAR(255)${dialect === "mysql" ? " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" : ""} NOT NULL UNIQUE, utoken TEXT NOT NULL, devid VARCHAR(255) NOT NULL, login_identifier VARCHAR(320), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, user_json ${text}, user_refreshed_at_ms BIGINT, write_quota_date VARCHAR(10), write_quota_used INTEGER NOT NULL DEFAULT 0 CHECK (write_quota_used >= 0))${dialect === "mysql" ? " ENGINE=InnoDB" : ""}`,
    `CREATE TABLE IF NOT EXISTS pats (id ${serial}, account_id BIGINT, token VARCHAR(255)${dialect === "mysql" ? " CHARACTER SET ascii COLLATE ascii_bin" : ""} NOT NULL UNIQUE, role VARCHAR(5) NOT NULL CHECK (role IN ('admin', 'user')), remark VARCHAR(100) NOT NULL, expires_at BIGINT, created_at BIGINT NOT NULL${adminColumn}, FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)${dialect === "mysql" ? " ENGINE=InnoDB" : ""}`,
    `CREATE TABLE IF NOT EXISTS sync_state (account_id BIGINT PRIMARY KEY, lasttimes_json ${text} NOT NULL, FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)${dialect === "mysql" ? " ENGINE=InnoDB" : ""}`,
    `CREATE TABLE IF NOT EXISTS catalog_cache (account_id BIGINT NOT NULL, kind VARCHAR(10) NOT NULL, scope VARCHAR(255) NOT NULL, data_json ${text} NOT NULL, refreshed_at_ms BIGINT NOT NULL, CONSTRAINT qianji_catalog_kind_check CHECK (kind IN ('books', 'assets', 'categories', 'tags', 'currencies')), PRIMARY KEY (account_id, kind, scope), FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)${dialect === "mysql" ? " ENGINE=InnoDB" : ""}`,
    `CREATE TABLE IF NOT EXISTS bills (account_id BIGINT NOT NULL, id ${dialect === "postgres" ? "NUMERIC" : "DECIMAL(65,0)"} NOT NULL, bookid ${dialect === "postgres" ? "NUMERIC" : "DECIMAL(65,0)"} NOT NULL, time BIGINT NOT NULL, type INTEGER NOT NULL, money ${double} NOT NULL, cateid ${dialect === "postgres" ? "NUMERIC" : "DECIMAL(65,0)"} NOT NULL, assetid ${dialect === "postgres" ? "NUMERIC" : "DECIMAL(65,0)"} NOT NULL, remark VARCHAR(500) NOT NULL, raw_json ${text} NOT NULL, PRIMARY KEY (account_id, id), FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE${dialect === "mysql" ? ", KEY bills_query_idx (account_id, time DESC, id DESC)" : ""})${dialect === "mysql" ? " ENGINE=InnoDB" : ""}`,
  ];
  if (dialect === "postgres") {
    statements.splice(2, 0, "CREATE UNIQUE INDEX IF NOT EXISTS pats_single_admin_idx ON pats(role) WHERE role = 'admin'");
    statements.push("CREATE INDEX IF NOT EXISTS bills_query_idx ON bills(account_id, time DESC, id DESC)");
  }
  return statements;
}
