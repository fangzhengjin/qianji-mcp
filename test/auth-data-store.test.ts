import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { authenticatePat, requireAccountPrincipal, requireAdmin } from "../src/auth.ts";
import { Store } from "../src/data-store.ts";
import { QianjiClient, md5 } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";

const ADMIN_PAT = `mt_pat_${"a".repeat(43)}`;

test("启动配置会轮换唯一超级管理员 PAT 并保留账号绑定", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const first = store.ensureAdminPat(ADMIN_PAT);
  const account = store.bindPat(first.id, "admin-uid", "admin-token", "ADMIN-DEVICE");
  const rotatedToken = `mt_pat_${"b".repeat(43)}`;
  const rotated = store.ensureAdminPat(rotatedToken);

  assert.equal(rotated.id, first.id);
  assert.equal(rotated.accountId, account.id);
  assert.equal(store.verifyPat(ADMIN_PAT), undefined);
  assert.equal(store.verifyPat(rotatedToken)?.role, "admin");
  assert.equal(store.listPats().filter(({ role }) => role === "admin").length, 1);
});

test("超级管理员和普通用户 PAT 映射到各自角色与账号", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.ensureAdminPat(ADMIN_PAT);
  const userPat = store.createPat("手机", null);
  const resource = new URL("https://mcp.example/mcp");
  const authenticated = (token: string) => authenticatePat(new Request(resource, {
    headers: { authorization: `Bearer ${token}` },
  }), store, resource);

  const adminAuth = (await authenticated(ADMIN_PAT))!;
  assert.equal(requireAdmin(adminAuth).role, "admin");
  assert.equal(adminAuth.accountId, null);

  const unboundAuth = (await authenticated(userPat.token))!;
  assert.equal(unboundAuth.role, "user");
  assert.equal(unboundAuth.accountId, null);
  await assert.rejects(() => requireAccountPrincipal(unboundAuth, store), { message: "尚未绑定钱迹账号" });

  const account = store.bindPat(userPat.id, "uid-1", "upstream-token", "DEVICE-1");
  const boundAuth = (await authenticated(userPat.token))!;
  assert.equal((await requireAccountPrincipal(boundAuth, store)).accountId, account.id);
});

test("PAT 明文、备注和映射入库，过期或物理删除后立即失效", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.ensureAdminPat(ADMIN_PAT);
  const now = Math.floor(Date.now() / 1000);
  const pat = store.createPat("桌面客户端", now + 60);
  const row = store.db.prepare("SELECT token, role, remark FROM pats WHERE id = ?").get(pat.id) as Record<string, unknown>;

  assert.equal(row.token, pat.token);
  assert.equal(row.role, "user");
  assert.equal(row.remark, "桌面客户端");
  const columns = store.db.prepare("PRAGMA table_info(pats)").all() as Record<string, unknown>[];
  assert.equal(columns.some(({ name }) => name === "scopes"), false);
  assert.equal(store.verifyPat(pat.token, now)?.id, pat.id);
  assert.equal(store.verifyPat(pat.token, now + 61), undefined);
  assert.deepEqual(store.deletePat(pat.id), { localDataDeleted: false });
  assert.equal(store.verifyPat(pat.token, now), undefined);
  assert.equal(store.deletePat(store.verifyPat(ADMIN_PAT)!.id), undefined);
});

test("旧数据库启动时移除 scopes 列并保留 PAT 与账号映射", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qianji-scope-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "qianji.db");
  const legacy = new Store(path);
  legacy.db.exec("ALTER TABLE pats ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'");
  const pat = legacy.createPat("旧版 PAT", null);
  const account = legacy.bindPat(pat.id, "legacy-uid", "legacy-token", "LEGACY-DEVICE");
  legacy.close();

  const migrated = new Store(path);
  t.after(() => migrated.close());
  const columns = migrated.db.prepare("PRAGMA table_info(pats)").all() as Record<string, unknown>[];
  assert.equal(columns.some(({ name }) => name === "scopes"), false);
  assert.equal(migrated.verifyPat(pat.token)?.accountId, account.id);
});

test("删除最后一枚普通 PAT 时才级联清理账号缓存", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const first = store.createPat("第一台设备", null);
  const second = store.createPat("第二台设备", null);
  const account = store.bindPat(first.id, "shared-uid", "upstream-token", "DEVICE-1");
  store.bindPat(second.id, "shared-uid", "upstream-token", "DEVICE-2");
  store.upsertBill(account.id, {
    id: "1770000000000123456",
    bookid: 1,
    time: 1_770_000_000,
    type: 0,
    money: 10,
    cateid: 2,
    assetid: -1,
    remark: "保留到最后一枚 PAT 被删除",
  });
  store.setCatalogCache(account.id, "books", "", [{ bookid: "1", name: "账本缓存" }], 1_770_000_000_000);

  assert.deepEqual(store.deletePat(first.id), { localDataDeleted: false });
  assert.equal(store.requireAccount(account.id).id, account.id);
  assert.equal(store.getBill(account.id, "1770000000000123456")?.money, 10);
  assert.equal(store.getCatalogCache(account.id, "books")?.data[0]?.name, "账本缓存");

  assert.deepEqual(store.deletePat(second.id), { localDataDeleted: true });
  assert.throws(() => store.requireAccount(account.id), { message: "尚未绑定钱迹账号" });
  assert.equal(store.getBill(account.id, "1770000000000123456"), undefined);
  assert.equal(store.getCatalogCache(account.id, "books"), undefined);
});

test("绑定只保存 uid、utoken、devid，不保存密码或 MD5", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const pat = store.createPat("绑定测试", null);
  const password = "sensitive-password";
  const passwordMd5 = md5(password);
  const client = new QianjiClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") return Response.json({ ec: 200, data: {
        user: { id: "money-user", name: "登录用户" },
        token: "upstream-token",
      } });
      if (path === "/client/init") return Response.json({ ec: 200, data: {
        userinfo: { id: "money-user", name: "登录用户" },
        books: [{ bookid: -1, name: "默认账本" }],
      } });
      if (path === "/syncv2/pull") return Response.json({ ec: 200, data: {
        changes: [], deletes: [], categories: [], bookid: -1, pageoffset: 0,
        hasmore: 0, pagesign: "", lasttimes: { cursor: 1 },
      } });
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  const service = new MoneyTrackService(store, client);
  await service.bindAccount(pat.id, "login-name", passwordMd5);
  await service.close();

  const accountId = store.verifyPat(pat.token)?.accountId;
  assert.equal(typeof accountId, "number");
  const account = store.requireAccount(accountId!);
  assert.equal(account.uid, "money-user");
  assert.equal(account.utoken, "upstream-token");
  assert.equal(store.getUserCache(account.id)?.data.name, "登录用户");
  assert.equal(store.getCatalogCache(account.id, "books")?.data[0]?.bookid, "-1");
  assert.match(account.devid, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  const columns = store.db.prepare("PRAGMA table_info(accounts)").all() as Record<string, unknown>[];
  const persisted = JSON.stringify(
    store.db.prepare("SELECT * FROM accounts").all(),
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
  );
  assert.equal(columns.some(({ name }) => name === "password" || name === "password_md5"), false);
  assert.equal(persisted.includes(password), false);
  assert.equal(persisted.includes(passwordMd5), false);
});

test("所有账单读取都按 account_id 隔离", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const pat1 = store.createPat("用户一", null);
  const pat2 = store.createPat("用户二", null);
  const account1 = store.bindPat(pat1.id, "uid-1", "token-1", "device-1");
  const account2 = store.bindPat(pat2.id, "uid-2", "token-2", "device-2");
  const bill = {
    id: "1770000000000123456",
    bookid: 1,
    time: 1_770_000_000,
    type: 0,
    money: 10,
    cateid: 2,
    assetid: -1,
    remark: "tenant-one",
  };
  store.upsertBill(account1.id, bill);

  assert.equal(store.getBill(account1.id, String(bill.id))?.remark, "tenant-one");
  assert.equal(store.getBill(account2.id, String(bill.id)), undefined);
  assert.equal(store.listBills(account2.id, { limit: 20 }).length, 0);
});

test("旧缓存中的数字标签可用字符串 tag_id 过滤", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const pat = store.createPat("旧标签", null);
  const account = store.bindPat(pat.id, "uid-tag", "token-tag", "device-tag");
  store.upsertBill(account.id, {
    id: "1770000000000123456",
    bookid: 1,
    time: 1_770_000_000,
    type: 0,
    money: 10,
    cateid: 2,
    assetid: -1,
    remark: "numeric-tag",
    extra: { tags: [123] },
  });

  assert.equal(store.listBills(account.id, { tagId: "123", limit: 20 }).length, 1);
});

test("旧同步游标迁移为账号唯一游标并删除退休目录缓存表", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qianji-sync-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "qianji.db");
  const initial = new Store(path);
  const pat = initial.createPat("迁移测试", null);
  const account = initial.bindPat(pat.id, "uid-migration", "token-migration", "device-migration");
  initial.close();

  const legacy = new Database(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    DROP TABLE sync_state;
    CREATE TABLE sync_state (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      bookid INTEGER NOT NULL,
      lasttimes_json TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, bookid)
    );
    INSERT INTO sync_state VALUES (${account.id}, -1, '{"cursor":7}', 1770000000);
    CREATE TABLE books (id INTEGER);
    CREATE TABLE assets (id INTEGER);
    CREATE TABLE categories (id INTEGER);
    CREATE TABLE tags (id INTEGER);
  `);
  legacy.close();

  const migrated = new Store(path);
  t.after(() => migrated.close());
  assert.equal(migrated.verifyPat(pat.token)?.accountId, account.id);
  assert.deepEqual(migrated.getSyncState(account.id), { cursor: 7 });
  const columns = migrated.db.prepare("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>;
  assert.deepEqual(columns.map(({ name }) => name), ["account_id", "lasttimes_json"]);
  const tables = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  for (const retired of ["books", "assets", "categories", "tags"]) {
    assert.equal(tables.some(({ name }) => name === retired), false);
  }
  assert.deepEqual(
    tables.map(({ name }) => name).filter((name) => !name.startsWith("sqlite_")).sort(),
    ["accounts", "bills", "catalog_cache", "pats", "sync_state"],
  );
});

test("SQLite 目录约束迁移保留旧快照并允许内部币种缓存", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qianji-catalog-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "qianji.db");
  const initial = new Store(path);
  const pat = initial.createPat("目录迁移", null);
  const account = initial.bindPat(pat.id, "uid-catalog", "token-catalog", "device-catalog");
  initial.setCatalogCache(account.id, "tags", "", [{ id: "tag-1" }], 123);
  initial.close();

  const legacy = new Database(path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE catalog_cache RENAME TO catalog_cache_current;
    CREATE TABLE catalog_cache (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('books', 'assets', 'categories', 'tags')),
      scope TEXT NOT NULL,
      data_json TEXT NOT NULL,
      refreshed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (account_id, kind, scope)
    );
    INSERT INTO catalog_cache SELECT * FROM catalog_cache_current;
    DROP TABLE catalog_cache_current;
  `);
  legacy.close();

  const migrated = new Store(path);
  t.after(() => migrated.close());
  assert.equal(migrated.getCatalogCache(account.id, "tags")?.data[0]?.id, "tag-1");
  migrated.setCatalogCache(account.id, "currencies", "", [{ symbol: "CNY", baseprice: 1 }], 456);
  assert.equal(migrated.getCatalogCache(account.id, "currencies")?.data[0]?.symbol, "CNY");
  const definition = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'catalog_cache'")
    .get() as { sql: string };
  assert.match(definition.sql, /'currencies'/);
});

test("SQLite 权限以及 PAT、账号映射在重启后保持，且不改已有目录权限", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qianji-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "private", "qianji.db");
  const store = new Store(path);
  const pat = store.createPat("重启测试", null);
  const account = store.bindPat(pat.id, "uid-restart", "token-restart", "DEVICE-RESTART");
  store.setCatalogCache(account.id, "tags", "", [{ id: "tag-1", name: "重启缓存" }], 1_770_000_000_000);
  store.close();

  assert.equal(statSync(join(directory, "private")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const reopened = new Store(path);
  assert.equal(reopened.verifyPat(pat.token)?.accountId, account.id);
  assert.equal(reopened.requireAccount(account.id).devid, account.devid);
  assert.equal(reopened.getCatalogCache(account.id, "tags")?.data[0]?.name, "重启缓存");
  reopened.close();

  const existingDirectory = join(directory, "existing");
  mkdirSync(existingDirectory, { mode: 0o755 });
  chmodSync(existingDirectory, 0o755);
  const existingPath = join(existingDirectory, "qianji.db");
  const existingStore = new Store(existingPath);
  existingStore.close();
  assert.equal(statSync(existingDirectory).mode & 0o777, 0o755);
  assert.equal(statSync(existingPath).mode & 0o777, 0o600);
});

test("bun:sqlite 保持 WAL、外键、事务回滚和 64 位业务 ID 精度", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qianji-bun-sqlite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "qianji.db"));
  t.after(() => store.close());
  const pat = store.createPat("Bun SQLite", null);
  const account = store.bindPat(pat.id, "bun-sqlite-uid", "bun-sqlite-token", "BUN-SQLITE-DEVICE");
  const billId = "1770000000000123456";

  assert.equal((store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((store.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: bigint }).foreign_keys, 1n);

  store.beginSync();
  store.upsertBill(account.id, {
    id: billId,
    bookid: "16435204029937364",
    time: 1_770_000_000,
    type: 0,
    money: 1,
    cateid: "920499594434982870",
    assetid: "9007199254740993",
  });
  store.rollbackSync();
  assert.equal(store.getBill(account.id, billId), undefined);

  store.beginSync();
  store.upsertBill(account.id, {
    id: billId,
    bookid: "16435204029937364",
    time: 1_770_000_000,
    type: 0,
    money: 1,
    cateid: "920499594434982870",
    assetid: "9007199254740993",
  });
  store.commitSync();
  assert.deepEqual(store.getBill(account.id, billId), {
    id: billId,
    bookid: "16435204029937364",
    time: 1_770_000_000,
    type: 0,
    money: 1,
    cateid: "920499594434982870",
    assetid: "9007199254740993",
    remark: "",
    rawJson: JSON.stringify({
      id: billId,
      bookid: "16435204029937364",
      time: 1_770_000_000,
      type: 0,
      money: 1,
      cateid: "920499594434982870",
      assetid: "9007199254740993",
    }),
  });
});

test("旧 accounts 表升级后具备登录标识、用户缓存与 UID 共享额度列", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qianji-account-cache-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "qianji.db");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      utoken TEXT NOT NULL,
      devid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO accounts VALUES (1, 'legacy-user', 'legacy-token', 'LEGACY-DEVICE', 1, 1);
  `);
  legacy.close();

  const migrated = new Store(path);
  t.after(() => migrated.close());
  const columns = migrated.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  assert.deepEqual(columns.map(({ name }) => name), [
    "id",
    "uid",
    "utoken",
    "devid",
    "created_at",
    "updated_at",
    "user_json",
    "user_refreshed_at_ms",
    "write_quota_date",
    "write_quota_used",
    "login_identifier",
  ]);
  const row = migrated.db.prepare(`
    SELECT user_json, user_refreshed_at_ms, write_quota_date, write_quota_used, login_identifier
    FROM accounts WHERE id = 1
  `).get() as Record<string, unknown>;
  assert.deepEqual(row, {
    user_json: null,
    user_refreshed_at_ms: null,
    write_quota_date: null,
    write_quota_used: 0n,
    login_identifier: null,
  });
});
