import assert from "node:assert/strict";

import { normalizeTagId } from "../src/bill-rules.ts";
import { Store, type QianjiAccount } from "../src/data-store.ts";
import { AppError } from "../src/errors.ts";
import { QianjiClient } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";

const accountFixture: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

function ok(data: unknown): Response {
  return Response.json({ ec: 200, data });
}

function setup(): { store: Store; accountId: number; account: QianjiAccount } {
  const store = new Store(":memory:");
  const pat = store.createPat("标签测试", null);
  const account = store.bindPat(pat.id, "uid-1", "token-1", "device-1");
  return { store, accountId: account.id, account };
}

function seedUser(store: Store, account: QianjiAccount, now: number): void {
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0, __baseCurrency: "CNY" }, now);
}

test("创建标签组按 APK 表单契约发送组名并规范化响应组", async () => {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  let submitCalls = 0;
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/tag/submitgroup") {
        submitCalls += 1;
        return submitCalls === 1 ? ok({ id: "g1", name: "工作", sort: 1 }) : ok({});
      }
      return ok({});
    },
  });

  const created = await client.createTagGroup(accountFixture, "工作");
  assert.deepEqual(created, { id: "g1", name: "工作", sort: 1 });
  assert.equal(requests[0]!.path, "/tag/submitgroup");
  assert.deepEqual(Object.fromEntries(requests[0]!.form), { uid: "u", v: "工作", fr: "u" });

  const withoutId = await client.createTagGroup(accountFixture, "生活");
  assert.equal(withoutId, undefined);
});

test("创建标签发送 JSON 字符串载荷并规范化响应标签", async () => {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  let submitCalls = 0;
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/tag/submittag") {
        submitCalls += 1;
        return submitCalls === 1 ? ok({ id: "t1", name: "工作" }) : ok({ id: "t2", name: "夜宵" });
      }
      return ok({});
    },
  });

  const created = await client.createTag(accountFixture, { name: "工作" });
  assert.deepEqual(created, { id: "t1", name: "工作" });
  assert.equal(requests[0]!.path, "/tag/submittag");
  assert.equal(requests[0]!.form.get("did"), null);
  assert.equal(requests[0]!.form.get("v"), '{"name":"工作"}');

  const withExtras = await client.createTag(accountFixture, { name: "夜宵", groupId: "g1", color: "FF0000" });
  assert.deepEqual(withExtras, { id: "t2", name: "夜宵" });
  const form = requests[1]!.form;
  assert.equal(form.get("v"), '{"name":"夜宵","groupid":"g1","color":"FF0000"}');

  const withoutId = new QianjiClient({ fetch: async () => ok({}) });
  assert.equal(await withoutId.createTag(accountFixture, { name: "午餐" }), undefined);
});

test("修改标签发送 did 与仅含变更字段的 JSON 载荷", async () => {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      return ok({});
    },
  });

  await client.updateTag(accountFixture, "t1", { name: "新名", groupId: "g2", color: "00ff00" });
  assert.equal(requests[0]!.path, "/tag/submittag");
  assert.equal(requests[0]!.form.get("did"), "t1");
  assert.equal(requests[0]!.form.get("v"), '{"name":"新名","groupid":"g2","color":"00ff00"}');

  await client.updateTag(accountFixture, "t1", { color: "abcdef" });
  assert.equal(requests[1]!.form.get("did"), "t1");
  assert.equal(requests[1]!.form.get("v"), '{"color":"abcdef"}');
});

test("删除、归档标签与删除标签组发送 did 表单", async () => {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      return ok({});
    },
  });

  await client.deleteTag(accountFixture, "t1");
  assert.equal(requests[0]!.path, "/tag/deletetag");
  assert.equal(requests[0]!.form.get("did"), "t1");

  await client.archiveTag(accountFixture, "t2");
  assert.equal(requests[1]!.path, "/tag/archivetag");
  assert.equal(requests[1]!.form.get("did"), "t2");

  await client.deleteTagGroup(accountFixture, "g1");
  assert.equal(requests[2]!.path, "/tag/deletegroup");
  assert.equal(requests[2]!.form.get("did"), "g1");
});

test("重排标签和标签组发送 JSON 字符串 ID 数组并拒绝非法 ID", async () => {
  const forms: URLSearchParams[] = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      assert.ok(["/tag/reordertag", "/tag/reordergroup"].includes(path));
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({});
    },
  });

  await client.reorderTags(accountFixture, ["t1", "t2"]);
  assert.equal(forms[0]!.get("v"), '["t1","t2"]');

  await client.reorderTagGroups(accountFixture, ["g1", "g2"]);
  assert.equal(forms[1]!.get("v"), '["g1","g2"]');

  for (const ids of [[""], ["t1", ""]]) {
    await assert.rejects(
      () => client.reorderTags(accountFixture, ids),
      (error) => error instanceof AppError && error.code === "QIANJI_PAYLOAD_INVALID",
    );
  }
  await assert.rejects(
    () => client.reorderTagGroups(accountFixture, [""]),
    (error) => error instanceof AppError && error.code === "QIANJI_PAYLOAD_INVALID",
  );
});

test("服务层创建标签组校验名称并失效标签快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "t0", name: "旧标签", status: 1, groupId: "", groupName: "" }], now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/tag/submitgroup") return ok({ id: "g1", name: "工作", sort: 1 });
      throw new Error(`Unexpected fixture path: ${path}`);
    },
  }), () => now);

  const result = await service.createTagGroups(accountId, [{ name: " 工作 " }]);
  assert.deepEqual(result, { groups: [{ groupId: "g1", name: "工作" }] });
  assert.deepEqual(forms.map(({ path }) => path), ["/tag/submitgroup"]);
  assert.deepEqual(Object.fromEntries(forms[0]!.form), { uid: "uid-1", v: "工作", fr: "uid-1" });
  assert.equal(store.getCatalogCache(account.id, "tags", ""), undefined);

  for (const [groups, code] of [
    [[], "INVALID_TAG_GROUPS"],
    [[{ name: "  " }], "INVALID_TAG_NAME"],
  ] as const) {
    await assert.rejects(
      () => service.createTagGroups(accountId, [...groups]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层批量删除标签组发送 did 并拒绝重复和非法 ID", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      assert.equal(path, "/tag/deletegroup");
      return ok({});
    },
  }), () => now);

  const result = await service.deleteTagGroups(accountId, ["g1", "g2"]);
  assert.deepEqual(result, { deletedGroupIds: ["g1", "g2"] });
  assert.deepEqual(forms.map(({ form }) => form.get("did")), ["g1", "g2"]);

  for (const [groupIds, code] of [
    [[], "INVALID_TAG_GROUP_DELETIONS"],
    [["g1", "g1"], "INVALID_TAG_GROUP_DELETIONS"],
    [[""], "INVALID_TAG_ID"],
  ] as const) {
    await assert.rejects(
      () => service.deleteTagGroups(accountId, [...groupIds]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层创建标签发送 JSON 载荷并失效标签快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "t0", name: "旧标签", status: 1, groupId: "", groupName: "" }], now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  let submitCalls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/tag/submittag") {
        submitCalls += 1;
        return submitCalls === 1 ? ok({ id: "t1", name: "工作" }) : ok({});
      }
      throw new Error(`Unexpected fixture path: ${path}`);
    },
  }), () => now);

  const result = await service.createTags(accountId, [
    { name: " 工作 ", groupId: "g1", color: "FF0000" },
    { name: "默认组标签", groupId: "" },
  ]);
  assert.deepEqual(result, { tags: [{ id: "t1", name: "工作", status: 1 }] });
  assert.deepEqual(forms.map(({ path }) => path), ["/tag/submittag", "/tag/submittag"]);
  assert.equal(forms[0]!.form.get("v"), '{"name":"工作","groupid":"g1","color":"ff0000"}');
  assert.equal(forms[1]!.form.get("v"), '{"name":"默认组标签","groupid":""}');
  assert.equal(store.getCatalogCache(account.id, "tags", ""), undefined);

  for (const [tags, code] of [
    [[], "INVALID_TAGS"],
    [[{ name: "  " }], "INVALID_TAG_NAME"],
    [[{ name: "工作", color: "red" }], "INVALID_TAG_COLOR"],
    [[{ name: "工作", groupId: "g".repeat(65) }], "INVALID_TAG_GROUP_ID"],
  ] as const) {
    await assert.rejects(
      () => service.createTags(accountId, [...tags]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层批量修改标签发送 did 与变更字段并拒绝重复和空补丁", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      assert.equal(path, "/tag/submittag");
      return ok({});
    },
  }), () => now);

  const result = await service.updateTags(accountId, [
    { tagId: "t1", name: " 新名 ", groupId: "g2", color: "00FF00" },
    { tagId: "t2", color: "abcdef" },
  ]);
  assert.deepEqual(result, {
    tags: [
      { tagId: "t1", name: "新名", groupId: "g2", color: "00ff00" },
      { tagId: "t2", color: "abcdef" },
    ],
  });
  assert.deepEqual(forms.map(({ form }) => ({ did: form.get("did"), v: form.get("v") })), [
    { did: "t1", v: '{"name":"新名","groupid":"g2","color":"00ff00"}' },
    { did: "t2", v: '{"color":"abcdef"}' },
  ]);

  for (const [updates, code] of [
    [[], "INVALID_TAG_UPDATES"],
    [[{ tagId: "" }], "INVALID_TAG_ID"],
    [[{ tagId: "t1" }], "INVALID_TAG_UPDATES"],
    [[{ tagId: "t1", name: "" }], "INVALID_TAG_NAME"],
    [[{ tagId: "t1", color: "red" }], "INVALID_TAG_COLOR"],
    [
      [{ tagId: "t1", name: "A" }, { tagId: "t1", name: "B" }],
      "INVALID_TAG_UPDATES",
    ],
  ] as const) {
    await assert.rejects(
      () => service.updateTags(accountId, [...updates]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层批量删除标签发送 did 并拒绝重复和非法 ID", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      assert.equal(path, "/tag/deletetag");
      return ok({});
    },
  }), () => now);

  const result = await service.deleteTags(accountId, ["t1", "t2"]);
  assert.deepEqual(result, { deletedTagIds: ["t1", "t2"] });
  assert.deepEqual(forms.map(({ form }) => form.get("did")), ["t1", "t2"]);

  for (const [tagIds, code] of [
    [[], "INVALID_TAG_DELETIONS"],
    [["t1", "t1"], "INVALID_TAG_DELETIONS"],
    [[""], "INVALID_TAG_ID"],
  ] as const) {
    await assert.rejects(
      () => service.deleteTags(accountId, [...tagIds]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层批量归档标签发送 did 并失效标签快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "t0", name: "旧标签", status: 1, groupId: "", groupName: "" }], now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      assert.equal(path, "/tag/archivetag");
      return ok({});
    },
  }), () => now);

  const result = await service.archiveTags(accountId, ["t1", "t2"]);
  assert.deepEqual(result, { archivedTagIds: ["t1", "t2"] });
  assert.deepEqual(forms.map(({ form }) => form.get("did")), ["t1", "t2"]);
  assert.equal(store.getCatalogCache(account.id, "tags", ""), undefined);

  for (const [tagIds, code] of [
    [[], "INVALID_TAG_ARCHIVES"],
    [["t1", "t1"], "INVALID_TAG_ARCHIVES"],
    [[""], "INVALID_TAG_ID"],
  ] as const) {
    await assert.rejects(
      () => service.archiveTags(accountId, [...tagIds]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层重排标签发送 JSON 字符串 ID 数组并失效标签快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "t0", name: "旧标签", status: 1, groupId: "", groupName: "" }], now);
  const forms: URLSearchParams[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/tag/reordertag");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({});
    },
  }), () => now);

  const result = await service.reorderTags(accountId, ["t1", "t2"]);
  assert.deepEqual(result, { orderedTagIds: ["t1", "t2"] });
  assert.equal(forms[0]!.get("v"), '["t1","t2"]');
  assert.equal(store.getCatalogCache(account.id, "tags", ""), undefined);

  for (const [ids, code] of [
    [[], "INVALID_TAG_ORDER"],
    [["t1", "t1"], "INVALID_TAG_ORDER"],
    [[""], "INVALID_TAG_ID"],
  ] as const) {
    await assert.rejects(
      () => service.reorderTags(accountId, [...ids]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层重排标签组发送 JSON 字符串 ID 数组并失效标签快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: URLSearchParams[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/tag/reordergroup");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({});
    },
  }), () => now);

  const result = await service.reorderTagGroups(accountId, ["g1", "g2"]);
  assert.deepEqual(result, { orderedGroupIds: ["g1", "g2"] });
  assert.equal(forms[0]!.get("v"), '["g1","g2"]');

  for (const [ids, code] of [
    [[], "INVALID_TAG_GROUP_ORDER"],
    [["g1", "g1"], "INVALID_TAG_GROUP_ORDER"],
    [[""], "INVALID_TAG_ID"],
  ] as const) {
    await assert.rejects(
      () => service.reorderTagGroups(accountId, [...ids]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("标签写入预占并保留非 VIP 每日写入配额，远端失败时释放", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  let failNext = false;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/tag/submittag");
      return failNext ? Response.json({ ec: 500, em: "server failure" }) : ok({});
    },
  }), () => now);

  await service.updateTags(accountId, [{ tagId: "t1", name: "新名" }]);
  assert.equal(store.getWriteQuota(accountId).used, 1);

  failNext = true;
  await assert.rejects(
    () => service.updateTags(accountId, [{ tagId: "t2", name: "失败" }]),
    (error) => error instanceof AppError && error.code === "QIANJI_BUSINESS_ERROR",
  );
  assert.equal(store.getWriteQuota(accountId).used, 1);
});

test("normalizeTagId 拒绝空文本与超长文本并接受不透明字符串", () => {
  assert.equal(normalizeTagId("2610166ad198e2aebf12370"), "2610166ad198e2aebf12370");
  assert.throws(() => normalizeTagId(""), (error) => error instanceof AppError && error.code === "INVALID_TAG_ID");
  assert.throws(
    () => normalizeTagId("t".repeat(65)),
    (error) => error instanceof AppError && error.code === "INVALID_TAG_ID",
  );
});
