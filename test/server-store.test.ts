import assert from "node:assert/strict";
import { test } from "bun:test";

import { AppError } from "../src/errors.ts";
import { ServerStore } from "../src/server-store.ts";

const urls = [process.env.QIANJI_TEST_POSTGRES_URL, process.env.QIANJI_TEST_MYSQL_URL].filter(Boolean) as string[];

test("服务端解绑在断开 PAT 前锁定账号行", async () => {
  const store = new ServerStore(new URL("postgres://unused:unused@127.0.0.1:1/unused"));
  const internal = store as unknown as {
    sql: { begin<T>(callback: (tx: unknown) => Promise<T>): Promise<T> };
    query(client: unknown, statement: string): Promise<Record<string, unknown>[]>;
  };
  const realSql = internal.sql as typeof internal.sql & { close(): Promise<void> };
  const statements: string[] = [];
  internal.sql = { async begin<T>(callback: (tx: unknown) => Promise<T>) { return callback({}); } };
  internal.query = async (_client, statement) => {
    statements.push(statement);
    if (statement.startsWith("SELECT account_id FROM pats")) return [{ account_id: 7 }];
    return [];
  };

  try {
    assert.deepEqual(await store.unbindPat(3, 7), { localDataDeleted: true });
  } finally {
    await realSql.close();
  }
  const accountLock = statements.indexOf("SELECT id FROM accounts WHERE id = ? FOR UPDATE");
  const detach = statements.indexOf("UPDATE pats SET account_id = NULL WHERE id = ?");
  assert.equal(accountLock >= 0 && accountLock < detach, true);
});

test("服务端 v2 目录约束可迁移到 v3", async () => {
  const store = new ServerStore(new URL("postgres://unused:unused@127.0.0.1:1/unused"));
  const internal = store as unknown as {
    sql: {
      unsafe(statement: string): Promise<unknown>;
      begin<T>(callback: (tx: unknown) => Promise<T>): Promise<T>;
    };
    query(client: unknown, statement: string): Promise<Record<string, unknown>[]>;
  };
  const realSql = internal.sql as typeof internal.sql & { close(): Promise<void> };
  const statements: string[] = [];
  internal.sql = {
    async unsafe(statement) { statements.push(statement); return []; },
    async begin<T>(callback: (tx: unknown) => Promise<T>) { return callback({}); },
  };
  internal.query = async (_client, statement) => {
    statements.push(statement);
    if (statement.includes("information_schema.tables")) {
      return ["qianji_schema_versions", "accounts", "pats", "sync_state", "catalog_cache", "bills"]
        .map((table_name) => ({ table_name }));
    }
    if (statement === "SELECT version FROM qianji_schema_versions ORDER BY version") return [{ version: 2 }];
    if (statement.includes("information_schema.table_constraints")) return [{ constraint_name: "catalog_cache_kind_check" }];
    return [];
  };

  try {
    await store.initialize();
  } finally {
    await realSql.close();
  }
  assert.equal(statements.some((statement) => statement.includes('DROP CONSTRAINT "catalog_cache_kind_check"')), true);
  assert.equal(statements.some((statement) => statement.includes("ADD CONSTRAINT qianji_catalog_kind_check") && statement.includes("'currencies'")), true);
  assert.equal(statements.includes("DELETE FROM qianji_schema_versions WHERE version = 2"), true);
  assert.equal(statements.includes("INSERT INTO qianji_schema_versions(version, applied_at) VALUES (?, ?)"), true);
});

test.skipIf(urls.length === 0)("PostgreSQL 和 MySQL 保持存储、事务、标签及额度契约", async () => {
  for (const value of urls) {
    const store = new ServerStore(new URL(value));
    try {
      await store.initialize();
      await store.initialize();
      const suffix = crypto.randomUUID();
      const adminToken = `mt_pat_${suffix.replaceAll("-", "").toUpperCase()}`;
      assert.equal((await store.ensureAdminPat(adminToken)).role, "admin");
      assert.equal(await store.verifyPat(adminToken.toLowerCase()), undefined);
      const pat = await store.createPat("integration", null);
      const account = await store.bindPat(pat.id, `uid-${suffix}`, "utoken", "device", `login-${suffix}`);
      assert.equal((await store.getPatConnection(pat.id))?.loginIdentifier, `login-${suffix}`);
      await store.setUserCache(account.id, { id: "18446744073709551615" }, 123);
      await store.setCatalogCache(account.id, "tags", "", [{ id: "123" }], 456);
      await store.setCatalogCache(account.id, "currencies", "", [{ symbol: "CNY", baseprice: 1 }], 457);
      assert.equal((await store.getCatalogCache(account.id, "currencies"))?.data[0]?.symbol, "CNY");
      await store.applySyncBatch(account.id, {
        changes: [
          { id: "9223372036854775807", bookid: "9223372036854775805", time: 10, type: 20, money: 1.25, cateid: -1, assetid: "9223372036854775804", fromid: "3", targetid: "4", createtime: 11, remark: "numeric tag", extra: { tags: [123] } },
          { id: "9223372036854775806", bookid: "-1", time: 9, type: 0, money: 2, cateid: "1", assetid: "-1", fromid: "-1", targetid: "-1", createtime: 9, remark: "text tag", extra: { tags: ["abc"] } },
        ],
        deletes: [],
        invalidatedCategoryScopes: [],
        lasttimes: { bills: "18446744073709551615" },
      });

      assert.equal((await store.getBill(account.id, "9223372036854775807"))?.bookid, "9223372036854775805");
      assert.equal((await store.listBills(account.id, { tagId: "123", limit: 20 }))[0]?.id, "9223372036854775807");
      assert.equal((await store.listBills(account.id, { tagId: "abc", limit: 20 }))[0]?.id, "9223372036854775806");
      assert.equal((await store.listBills(account.id, { createStartTime: 10, remarkKeyword: "numeric", assetId: "9223372036854775804", fromAssetId: "3", targetAssetId: "4", limit: 20 }))[0]?.id, "9223372036854775807");
      assert.equal((await store.listBills(account.id, { remarkKeyword: "NUMERIC", limit: 20 })).length, 1);

      const quota = await Promise.allSettled(Array.from({ length: 6 }, () => store.reserveWriteQuota(account.id, "2026-08-12", 5)));
      assert.equal(quota.filter(({ status }) => status === "fulfilled").length, 5);
      assert.equal(quota.filter(({ status }) => status === "rejected").length, 1);
      const rejected = quota.find(({ status }) => status === "rejected");
      assert.equal(rejected?.status === "rejected" && rejected.reason instanceof AppError, true);

      await assert.rejects(() => store.applySyncBatch(account.id, {
        changes: [{ id: "not-an-id", bookid: "-1", time: 11, type: 0, money: 1, cateid: -1, assetid: -1 }],
        deletes: ["9223372036854775807"],
        invalidatedCategoryScopes: [],
        lasttimes: { bills: "broken" },
      }));
      assert.equal((await store.getBill(account.id, "9223372036854775807"))?.id, "9223372036854775807");
      assert.deepEqual(await store.getSyncState(account.id), { bills: "18446744073709551615" });

      const sharedPat = await store.createPat("shared", null);
      await store.bindPat(sharedPat.id, account.uid, "shared-token", "shared-device");
      assert.deepEqual(await store.unbindPat(pat.id, account.id), { localDataDeleted: false });
      assert.equal(await store.countBills(account.id), 2);
      assert.deepEqual(await store.unbindPat(sharedPat.id, account.id), { localDataDeleted: true });
      assert.equal(await store.countBills(account.id), 0);
    } finally {
      await store.close();
    }
  }
});
