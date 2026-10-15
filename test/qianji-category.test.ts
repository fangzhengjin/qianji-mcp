import assert from "node:assert/strict";

import { normalizeBookId } from "../src/bill-rules.ts";
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
  const pat = store.createPat("分类测试", null);
  const account = store.bindPat(pat.id, "uid-1", "token-1", "device-1");
  return { store, accountId: account.id, account };
}

function seedUser(store: Store, account: QianjiAccount, now: number): void {
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0, __baseCurrency: "CNY" }, now);
}

function seedBooks(store: Store, account: QianjiAccount, now: number, books: Array<Record<string, unknown>>): void {
  store.setCatalogCache(account.id, "books", "", books, now);
}

test("创建分类按 APK 表单契约发送纯文本名称并规范化响应分类", async () => {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  let submitCalls = 0;
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/category/submitv2") {
        submitCalls += 1;
        return submitCalls === 1 ? ok({ id: 177, name: "餐饮", type: 0, parentid: -1 }) : ok({});
      }
      return ok({});
    },
  });

  const created = await client.createCategory(accountFixture, { bookId: "-1", name: "餐饮", type: 0 });
  assert.deepEqual(created, { id: "177", name: "餐饮", type: 0, parentid: "-1" });
  assert.equal(requests[0]!.path, "/category/submitv2");
  assert.deepEqual(Object.fromEntries(requests[0]!.form), { uid: "u", bookid: "-1", v: "餐饮", t: "0", fr: "u" });

  const withExtras = await client.createCategory(accountFixture, {
    bookId: "1",
    name: "夜宵",
    type: 0,
    parentId: "170",
    icon: "ic_food",
  });
  assert.equal(withExtras, undefined);
  const form = requests[1]!.form;
  assert.equal(form.get("bookid"), "1");
  assert.equal(form.get("v"), "夜宵");
  assert.equal(form.get("t"), "0");
  assert.equal(form.get("parentid"), "170");
  assert.equal(form.get("icon"), "ic_food");

  const withoutId = await client.createCategory(accountFixture, { bookId: "1", name: "午餐", type: 0 });
  assert.equal(withoutId, undefined);
});

test("改名、删除、删除前检查和移动分类的表单契约与 APK 证据一致", async () => {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/category/deletecheckv2") return ok({ count: 3, other: { first: "餐饮" } });
      return ok({});
    },
  });

  await client.updateCategory(accountFixture, "177", "夜宵");
  assert.equal(requests[0]!.path, "/category/submitv2");
  assert.equal(requests[0]!.form.get("did"), "177");
  assert.equal(requests[0]!.form.get("v"), "夜宵");

  await client.deleteCategory(accountFixture, "177", { transferTo: "178", deleteBills: true });
  assert.equal(requests[1]!.path, "/category/deletev2");
  assert.equal(requests[1]!.form.get("did"), "177");
  assert.equal(requests[1]!.form.get("newcateid"), "178");
  assert.equal(requests[1]!.form.get("deletebills"), "1");

  await client.deleteCategory(accountFixture, "177");
  assert.equal(requests[2]!.form.get("newcateid"), null);
  assert.equal(requests[2]!.form.get("deletebills"), null);

  const check = await client.deleteCategoryCheck(accountFixture, "177");
  assert.equal(requests[3]!.path, "/category/deletecheckv2");
  assert.equal(requests[3]!.form.get("did"), "177");
  assert.deepEqual(check, { count: 3, other: { first: "餐饮" } });

  await client.moveCategory(accountFixture, "177", "170");
  assert.equal(requests[4]!.path, "/category/movesubcate");
  assert.equal(requests[4]!.form.get("did"), "177");
  assert.equal(requests[4]!.form.get("parentid"), "170");

  await client.changeCategoryLevel(accountFixture, "177", "-1");
  assert.equal(requests[5]!.path, "/category/changelevel");
  assert.equal(requests[5]!.form.get("did"), "177");
  assert.equal(requests[5]!.form.get("parentid"), "-1");
});

test("重排分类发送保持精度的 JSON 数字数组并拒绝非法 ID", async () => {
  const forms: URLSearchParams[] = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/category/reorder3");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({});
    },
  });

  await client.reorderCategories(accountFixture, ["170", "171"]);
  assert.equal(forms[0]!.get("v"), "[170,171]");

  await client.reorderCategories(accountFixture, ["9223372036854775807"]);
  assert.equal(forms[1]!.get("v"), "[9223372036854775807]");

  for (const ids of [["abc"], ["9223372036854775808"], [""]]) {
    await assert.rejects(
      () => client.reorderCategories(accountFixture, ids),
      (error) => error instanceof AppError && error.code === "QIANJI_PAYLOAD_INVALID",
    );
  }
});

test("批量创建子分类发送 JSON 名称数组并解析分类与重复项", async () => {
  let form: URLSearchParams | undefined;
  const client = new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/category/submitmultiple");
      form = new URLSearchParams(String(init?.body));
      return ok({
        list: [{ id: 180, name: "奖金", type: 1, parentid: 170 }],
        repeats: ["红包"],
      });
    },
  });

  const result = await client.submitMultipleCategories(accountFixture, {
    bookId: "1",
    parentId: "170",
    type: 1,
    names: ["奖金", "红包"],
  });
  assert.equal(form?.get("bookid"), "1");
  assert.equal(form?.get("t"), "1");
  assert.equal(form?.get("parentid"), "170");
  assert.equal(form?.get("v"), '[{"name":"奖金"},{"name":"红包"}]');
  assert.deepEqual(result, {
    list: [{ id: "180", name: "奖金", type: 1, parentid: "170" }],
    repeats: ["红包"],
  });

  const withoutRepeats = new QianjiClient({
    fetch: async () => ok({ list: [{ id: 181, name: "工资", type: 1, parentid: 170 }] }),
  });
  assert.deepEqual(await withoutRepeats.submitMultipleCategories(accountFixture, {
    bookId: "1",
    parentId: "170",
    type: 1,
    names: ["工资"],
  }), {
    list: [{ id: "181", name: "工资", type: 1, parentid: "170" }],
    repeats: [],
  });
});

test("读取分类图标分组不携带参数并规范化分组字段", async () => {
  const forms: URLSearchParams[] = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/category/iconlist");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({
        list: [{ group: 1, groupname: "常用", icons: [{ name: "ic_food" }] }],
      });
    },
  });

  const icons = await client.listCategoryIcons(accountFixture);
  assert.deepEqual(Object.fromEntries(forms[0]!), { uid: "u", fr: "u" });
  assert.deepEqual(icons, [{ group: "1", groupName: "常用", groupname: "常用", icons: [{ name: "ic_food" }] }]);
});

test("删除前检查拒绝缺失或非法的账单数", async () => {
  for (const data of [{ count: "abc" }, { count: -1 }, { count: 1.5 }, { other: 1 }]) {
    const client = new QianjiClient({ fetch: async () => ok(data) });
    if (data.other !== undefined) {
      assert.deepEqual(await client.deleteCategoryCheck(accountFixture, "177"), { count: 0, other: 1 });
    } else {
      await assert.rejects(
        () => client.deleteCategoryCheck(accountFixture, "177"),
        (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
      );
    }
  }
});

test("服务层创建分类校验账本归属、分类名称和父分类并失效快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  seedBooks(store, account, now, [{ bookid: "1", name: "账本", visible: 1 }]);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "5", name: "旧分类", type: 0, parentid: "-1" }], now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  let submitCalls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      if (path === "/category/submitv2") {
        submitCalls += 1;
        return submitCalls === 1
          ? ok({ id: 177, name: "餐饮", type: 0, parentid: -1 })
          : ok({ id: 178, name: "工资", type: 1, parentid: -1 });
      }
      if (path === "/book/list") return ok({ list: [{ bookid: "1", name: "账本", visible: 1 }] });
      throw new Error(`Unexpected fixture path: ${path}`);
    },
  }), () => now);

  const result = await service.createCategories(accountId, [
    { bookId: "1", name: " 餐饮 ", type: 0, parentId: "170", icon: "ic_food" },
    { name: "工资", type: 1 },
  ]);
  assert.deepEqual(result, {
    categories: [
      { id: "177", name: "餐饮", type: 0, level: 1, parentId: "-1", children: [] },
      { id: "178", name: "工资", type: 1, level: 1, parentId: "-1", children: [] },
    ],
  });
  assert.deepEqual(forms.map(({ path }) => path), ["/category/submitv2", "/category/submitv2"]);
  assert.deepEqual(Object.fromEntries(forms[0]!.form), {
    uid: "uid-1",
    bookid: "1",
    v: "餐饮",
    t: "0",
    parentid: "170",
    icon: "ic_food",
    fr: "uid-1",
  });
  assert.equal(forms[1]!.form.get("bookid"), "-1");
  assert.equal(forms[1]!.form.get("parentid"), null);
  assert.equal(store.getCatalogCache(account.id, "categories", "1"), undefined);

  for (const [inputs, code] of [
    [[], "INVALID_CATEGORIES"],
    [[{ name: "  ", type: 0 }], "INVALID_CATEGORY_NAME"],
    [[{ bookId: "abc", name: "餐饮", type: 0 }], "INVALID_BOOK_ID"],
    [[{ name: "餐饮", type: 0, parentId: "abc" }], "INVALID_CATEGORY_PARENT"],
  ] as const) {
    await assert.rejects(
      () => service.createCategories(accountId, [...inputs]),
      (error) => error instanceof AppError && error.code === code,
    );
  }

  await assert.rejects(
    () => service.createCategories(accountId, [{ bookId: "2", name: "餐饮", type: 0 }]),
    (error) => error instanceof AppError && error.code === "CROSS_ACCOUNT_RESOURCE",
  );
  assert.equal(forms.some(({ path }) => path === "/book/list"), true);
});

test("服务层批量改名发送 did 与新名称并拒绝重复和非法 ID", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      assert.equal(path, "/category/submitv2");
      return ok({});
    },
  }), () => now);

  const result = await service.updateCategories(accountId, [
    { categoryId: "170", name: " 新名 " },
    { categoryId: "171", name: "改名" },
  ]);
  assert.deepEqual(result, {
    categories: [
      { categoryId: "170", name: "新名" },
      { categoryId: "171", name: "改名" },
    ],
  });
  assert.deepEqual(forms.map(({ form }) => ({ did: form.get("did"), v: form.get("v") })), [
    { did: "170", v: "新名" },
    { did: "171", v: "改名" },
  ]);

  for (const [updates, code] of [
    [[], "INVALID_CATEGORY_UPDATES"],
    [[{ categoryId: "abc", name: "新名" }], "INVALID_CATEGORY_ID"],
    [[{ categoryId: "170", name: "" }], "INVALID_CATEGORY_NAME"],
    [
      [{ categoryId: "170", name: "A" }, { categoryId: "170", name: "B" }],
      "INVALID_CATEGORY_UPDATES",
    ],
  ] as const) {
    await assert.rejects(
      () => service.updateCategories(accountId, [...updates]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层批量删除支持账单转移与连账单删除并拒绝自转移", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      forms.push({ path, form: new URLSearchParams(String(init?.body)) });
      assert.equal(path, "/category/deletev2");
      return ok({});
    },
  }), () => now);

  const result = await service.deleteCategories(accountId, [
    { categoryId: "170", transferTo: "171", deleteBills: true },
    { categoryId: "171" },
  ]);
  assert.deepEqual(result, {
    deleted: [
      { categoryId: "170", transferredTo: "171", billsDeleted: true },
      { categoryId: "171", billsDeleted: false },
    ],
  });
  assert.deepEqual(forms.map(({ form }) => ({
    did: form.get("did"),
    newcateid: form.get("newcateid"),
    deletebills: form.get("deletebills"),
  })), [
    { did: "170", newcateid: "171", deletebills: "1" },
    { did: "171", newcateid: null, deletebills: null },
  ]);

  for (const [deletions, code] of [
    [[], "INVALID_CATEGORY_DELETIONS"],
    [[{ categoryId: "abc" }], "INVALID_CATEGORY_ID"],
    [[{ categoryId: "170", transferTo: "170" }], "INVALID_CATEGORY_TRANSFER"],
    [
      [{ categoryId: "170" }, { categoryId: "170" }],
      "INVALID_CATEGORY_DELETIONS",
    ],
  ] as const) {
    await assert.rejects(
      () => service.deleteCategories(accountId, [...deletions]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层删除前检查是只读操作并返回受影响账单数", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const forms: URLSearchParams[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/category/deletecheckv2");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({ count: 3, other: {} });
    },
  }), () => now);

  const result = await service.checkCategoryDeletion(accountId, "170");
  assert.deepEqual(result, { categoryId: "170", billCount: 3 });
  assert.equal(forms[0]!.get("did"), "170");
  assert.equal(store.getWriteQuota(accountId).used, 0);

  await assert.rejects(
    () => service.checkCategoryDeletion(accountId, "abc"),
    (error) => error instanceof AppError && error.code === "INVALID_CATEGORY_ID",
  );
});

test("服务层移动分类按父 ID 选择移动或层级调整接口", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, form: new URLSearchParams(String(init?.body)) });
      return ok({});
    },
  }), () => now);

  assert.deepEqual(await service.moveCategory(accountId, "170", "-1"), { categoryId: "170", parentId: "-1" });
  assert.equal(requests[0]!.path, "/category/changelevel");
  assert.equal(requests[0]!.form.get("did"), "170");
  assert.equal(requests[0]!.form.get("parentid"), "-1");

  assert.deepEqual(await service.moveCategory(accountId, "170", "171"), { categoryId: "170", parentId: "171" });
  assert.equal(requests[1]!.path, "/category/movesubcate");
  assert.equal(requests[1]!.form.get("parentid"), "171");

  for (const [categoryId, parentId, code] of [
    ["170", "170", "INVALID_CATEGORY_PARENT"],
    ["abc", "171", "INVALID_CATEGORY_ID"],
    ["170", "abc", "INVALID_CATEGORY_PARENT"],
  ] as const) {
    await assert.rejects(
      () => service.moveCategory(accountId, categoryId, parentId),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层重排分类发送保持精度的 ID 数组并失效快照", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  seedBooks(store, account, now, [{ bookid: "1", name: "账本", visible: 1 }]);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "5", name: "旧分类", type: 0, parentid: "-1" }], now);
  const forms: URLSearchParams[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/category/reorder3");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({});
    },
  }), () => now);

  const result = await service.reorderCategories(accountId, ["170", "171"]);
  assert.deepEqual(result, { orderedCategoryIds: ["170", "171"] });
  assert.equal(forms[0]!.get("v"), "[170,171]");
  assert.equal(store.getCatalogCache(account.id, "categories", "1"), undefined);

  for (const [ids, code] of [
    [[], "INVALID_CATEGORY_ORDER"],
    [["170", "170"], "INVALID_CATEGORY_ORDER"],
    [["abc"], "INVALID_CATEGORY_ID"],
  ] as const) {
    await assert.rejects(
      () => service.reorderCategories(accountId, [...ids]),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("服务层读取图标分组不落快照并逐次请求远端", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  let calls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/category/iconlist");
      calls += 1;
      return ok({ list: [{ group: 1, groupname: "常用", icons: [] }] });
    },
  }), () => now);

  const first = await service.listCategoryIcons(accountId);
  assert.deepEqual(first, [{ group: "1", groupName: "常用", groupname: "常用", icons: [] }]);
  await service.listCategoryIcons(accountId);
  assert.equal(calls, 2);
});

test("服务层批量创建子分类发送真实一级分类并解析重复项", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  seedBooks(store, account, now, [{ bookid: "1", name: "账本", visible: 1 }]);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "170", name: "旧分类", type: 0, parentid: "-1" }], now);
  const forms: URLSearchParams[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/category/submitmultiple");
      forms.push(new URLSearchParams(String(init?.body)));
      return ok({
        list: [{ id: 180, name: "A", type: 0, parentid: 170 }],
        repeats: ["B"],
      });
    },
  }), () => now);

  const result = await service.createMultipleCategories(accountId, {
    bookId: "1",
    parentId: "170",
    type: 0,
    names: [" A ", "B"],
  });
  assert.equal(forms[0]!.get("bookid"), "1");
  assert.equal(forms[0]!.get("t"), "0");
  assert.equal(forms[0]!.get("parentid"), "170");
  assert.equal(forms[0]!.get("v"), '[{"name":"A"},{"name":"B"}]');
  assert.deepEqual(result, {
    categories: [{ id: "180", name: "A", type: 0, level: 1, parentId: "170", children: [] }],
    repeats: ["B"],
  });
  assert.equal(store.getCatalogCache(account.id, "categories", "1"), undefined);

  for (const [input, code] of [
    [{ bookId: "abc", parentId: "170", type: 0, names: ["A"] }, "INVALID_BOOK_ID"],
    [{ parentId: "abc", type: 0, names: ["A"] }, "INVALID_CATEGORY_ID"],
    [{ parentId: "170", type: 0, names: [] }, "INVALID_CATEGORY_NAMES"],
    [{ parentId: "170", type: 0, names: [""] }, "INVALID_CATEGORY_NAME"],
  ] as const) {
    await assert.rejects(
      () => service.createMultipleCategories(accountId, { ...input, names: [...input.names] }),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test("无账本上下文的分类写入使全部已缓存账本的分类快照失效", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  seedBooks(store, account, now, [
    { bookid: "1", name: "账本一", visible: 1 },
    { bookid: "-1", name: "默认账本", visible: 1 },
  ]);
  store.setCatalogCache(account.id, "categories", "1", [{ id: "5", name: "支出", type: 0, parentid: "-1" }], now);
  store.setCatalogCache(account.id, "categories", "-1", [{ id: "6", name: "收入", type: 1, parentid: "-1" }], now);
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/category/submitv2");
      return ok({});
    },
  }), () => now);

  await service.updateCategories(accountId, [{ categoryId: "5", name: "新支出" }]);
  assert.equal(store.getCatalogCache(account.id, "categories", "1"), undefined);
  assert.equal(store.getCatalogCache(account.id, "categories", "-1"), undefined);
});

test("分类写入预占并保留非 VIP 每日写入配额，远端失败时释放", async (t) => {
  const { store, accountId, account } = setup();
  t.after(() => store.close());
  const now = Date.UTC(2026, 7, 10, 4);
  seedUser(store, account, now);
  let failNext = false;
  const service = new MoneyTrackService(store, new QianjiClient({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/category/submitv2");
      return failNext ? Response.json({ ec: 500, em: "server failure" }) : ok({});
    },
  }), () => now);

  await service.updateCategories(accountId, [{ categoryId: "170", name: "新名" }]);
  assert.equal(store.getWriteQuota(accountId).used, 1);

  failNext = true;
  await assert.rejects(
    () => service.updateCategories(accountId, [{ categoryId: "171", name: "失败" }]),
    (error) => error instanceof AppError && error.code === "QIANJI_BUSINESS_ERROR",
  );
  assert.equal(store.getWriteQuota(accountId).used, 1);
});

test("normalizeBookId 保留分类操作的默认账本哨兵值", () => {
  assert.equal(normalizeBookId("-1"), "-1");
  assert.throws(() => normalizeBookId("abc"), (error) => error instanceof AppError && error.code === "INVALID_BOOK_ID");
});
