import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QianjiClient,
  createReqidv2,
  createTok,
  extractCtrlAct,
  md5,
  parseQianjiJson,
  stringifyQianjiPayload,
} from "../src/qianji-client.ts";
import test from "./context.ts";
import type { QianjiAccount } from "../src/data-store.ts";
import { AppError } from "../src/errors.ts";

test("Android 4.5.1b3 tok 确定性向量保持不变", () => {
  assert.equal(
    createTok("76ac66badd5fbfd7a7f8257469436710", "category", "listv2"),
    "d1ec8f1ff0b4dcd9e6e962de9eb5f033",
  );
});

test("ctrl/act 只接受两段接口路径", () => {
  assert.deepEqual(extractCtrlAct("/category/listv2"), { ctrl: "category", act: "listv2" });
  assert.throws(() => extractCtrlAct("/category"), { message: "钱迹接口路径无法签名" });
  assert.throws(() => extractCtrlAct("/a/b/c"), { message: "钱迹接口路径无法签名" });
});

test("已确认的 reqidv2 算法可用固定时钟复现", () => {
  assert.equal(createReqidv2("category", "listv2", 1_770_000_000_000), "a49200e153e3e61720772d44f8fba407");
});

test("JSON 解析和序列化不丢失 64 位业务 ID", () => {
  const source = '{"id":1770000000000123456,"server_only":1770000000000999999}';
  const bookId = "16435204029937364";
  const categoryId = "16435204029937365";
  const assetId = "16435204029937366";
  const parsed = parseQianjiJson(source) as { id: { rawJSON: string } };
  assert.equal(JSON.stringify(parsed), source);
  assert.equal(parsed.id.rawJSON, "1770000000000123456");
  assert.equal(
    stringifyQianjiPayload({
      bills: {
        changelist: [{
          id: parsed.id.rawJSON,
          bookid: bookId,
          cateid: categoryId,
          assetid: assetId,
          fromid: "-1",
          targetid: assetId,
          unknown: { id: "00123" },
        }],
        dellist: [parsed.id.rawJSON],
      },
    }),
    '{"bills":{"changelist":[{"id":1770000000000123456,"bookid":16435204029937364,"cateid":16435204029937365,"assetid":16435204029937366,"fromid":-1,"targetid":16435204029937366,"unknown":{"id":"00123"}}],"dellist":[1770000000000123456]}}',
  );
  assert.doesNotThrow(() => stringifyQianjiPayload({ bills: { dellist: ["9223372036854775807"] } }));
  assert.throws(
    () => stringifyQianjiPayload({ bills: { dellist: ["9223372036854775808"] } }),
    (error) => error instanceof AppError && error.code === "QIANJI_PAYLOAD_INVALID",
  );
});

test("钱迹账单的 assetId、fromId 和 targetId 拒绝 0", async () => {
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };
  for (const field of ["assetid", "fromid", "targetid"] as const) {
    const change = {
      id: 1,
      bookid: 1,
      cateid: 2,
      assetid: -1,
      fromid: -1,
      targetid: -1,
      [field]: 0,
    };
    const client = new QianjiClient({
      fetch: async () => Response.json({
        ec: 200,
        data: {
          changes: [change],
          deletes: [],
          categories: [],
          bookid: -1,
          pageoffset: 0,
          hasmore: 0,
          count: 1,
          pagesign: "",
          lasttimes: {},
        },
      }),
    });

    await assert.rejects(
      () => client.pullBills(account, { bookid: "-1", pageoffset: 0, pagesign: "" }),
      (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
    );
  }

  for (const field of ["assetid", "fromid", "targetid"] as const) {
    assert.throws(
      () => stringifyQianjiPayload({
        bills: { changelist: [{ id: "1", bookid: "1", cateid: "2", [field]: 0 }] },
      }),
      (error) => error instanceof AppError && error.code === "QIANJI_PAYLOAD_INVALID",
    );
  }
});

test("统一 Client 使用 Android 4.5.1b3 公共头并直接转发登录密码 MD5", async () => {
  let captured: { url: string; headers: Headers; body: URLSearchParams; redirect?: RequestRedirect } | undefined;
  const passwordMd5 = md5("plain-password");
  const client = new QianjiClient({
    now: () => 1_770_000_000_000,
    fetch: async (input, init) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: new URLSearchParams(String(init?.body)),
        redirect: init?.redirect,
      };
      return Response.json({ ec: 200, em: "", data: {
        user: { id: "uid-1", name: "测试用户" },
        books: [{ bookid: 1, name: "默认账本" }],
        token: "secret-token",
      } });
    },
  });

  assert.deepEqual(await client.login("user@example.com", passwordMd5, "DEVICE-ID"), {
    uid: "uid-1",
    utoken: "secret-token",
    user: { id: "uid-1", name: "测试用户" },
    books: [{ bookid: "1", name: "默认账本" }],
  });
  assert.equal(captured?.url, "https://api.qianjiapp.com/account/login");
  assert.equal(captured?.headers.get("devbrand"), "MCP");
  assert.equal(captured?.headers.get("devname"), "MCP");
  assert.equal(captured?.headers.get("os"), "1");
  assert.equal(captured?.headers.get("pkg"), "com.mutangtech.qianji");
  assert.equal(captured?.headers.get("vs"), "1207");
  assert.equal(captured?.headers.get("vsn"), "4.5.1b3");
  assert.equal(captured?.headers.get("mk"), "beta");
  assert.equal(captured?.headers.get("ctrl"), "account");
  assert.equal(captured?.headers.get("act"), "login");
  assert.equal(captured?.headers.get("devid"), "DEVICE-ID");
  assert.equal(captured?.headers.get("utoken"), null);
  assert.equal(captured?.redirect, "error");
  assert.equal(captured?.body.get("v"), "user@example.com");
  assert.equal(captured?.body.get("pwd"), passwordMd5);
  assert.equal(captured?.body.toString().includes("plain-password"), false);
});

test("同一路径同一毫秒的请求使用不同 reqidv2", async () => {
  const reqids: string[] = [];
  const client = new QianjiClient({
    now: () => 1_770_000_000_000,
    fetch: async (_input, init) => {
      reqids.push(new Headers(init?.headers).get("reqidv2") ?? "");
      return Response.json({ ec: 200, data: { list: [] } });
    },
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  await client.listAssets(account, true);

  assert.equal(reqids.length, 2);
  assert.notEqual(reqids[0], reqids[1]);
});

test("资产列表保留上游自定义分组元数据", async () => {
  const client = new QianjiClient({
    fetch: async () => Response.json({ ec: 200, data: {
      groups: [{ groupid: "group-1", name: "常用", sort: 2 }],
      list: [
        { id: 1, name: "现金", type: 1, status: 0, groupid: "group-1" },
        { id: 2, name: "银行卡", type: 1, status: 0 },
      ],
    } }),
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  assert.deepEqual(await client.listAssets(account, false), [
    { id: "1", name: "现金", type: 1, status: 0, groupid: "group-1", groupName: "常用", groupOrder: 0 },
    { id: "2", name: "银行卡", type: 1, status: 0, groupid: "-1" },
  ]);
});

test("分类 parentId 的上游 0 兼容值输出为字符串", async () => {
  const client = new QianjiClient({
    fetch: async () => Response.json({
      ec: 200,
      data: { list: [{ id: 1, name: "root", type: 0, level: 1, parentid: 0 }] },
    }),
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  const categories = await client.listCategories(account, "1", 0);

  assert.equal(categories[0]?.parentid, "0");
});

test("预算列表按 APK 月年筛选格式请求并规范化业务 ID", async () => {
  const forms: URLSearchParams[] = [];
  const client = new QianjiClient({
    fetch: async (_input, init) => {
      forms.push(new URLSearchParams(String(init?.body)));
      return Response.json({ ec: 200, data: { list: [
        { bookid: 1, flag: 1, cateid: -1, money: 1000 },
        { bookid: 1, flag: 2, cateid: 2, money: 300, category: { id: 2, parentid: 0, name: "餐饮" } },
      ] } });
    },
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  const monthly = await client.listBudgets(account, "1", { kind: "month", year: 2026, month: 8 }, "m15");
  await client.listBudgets(account, "1", { kind: "year", year: 2026 });

  assert.deepEqual(monthly, [
    { bookid: "1", flag: 1, cateid: "-1", money: 1000 },
    { bookid: "1", flag: 2, cateid: "2", money: 300, category: { id: "2", parentid: "0", name: "餐饮" } },
  ]);
  assert.equal(forms[0]?.get("flts"), '{"month":"2026,8"}');
  assert.equal(forms[0]?.get("range"), "m15");
  assert.equal(forms[1]?.get("flts"), '{"year":"2026"}');
  assert.equal(forms[1]?.has("range"), false);
});

test("账本成员查询按独立接口返回筛选所需字段", async () => {
  let path = "";
  let form: URLSearchParams | undefined;
  const client = new QianjiClient({
    fetch: async (input, init) => {
      path = new URL(String(input)).pathname;
      form = new URLSearchParams(String(init?.body));
      return new Response('{"ec":200,"data":{"list":[{"id":1770000000000000001,"name":"成员","avatar":"ignored"}]}}');
    },
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  assert.deepEqual(await client.listBookMembers(account, "1"), [
    { userId: "1770000000000000001", name: "成员" },
  ]);
  assert.equal(path, "/book/members");
  assert.equal(form?.get("bookid"), "1");
});

test("标签按 TagGroup 展平并保留非数字 ID、默认组和组名", async () => {
  const forms: URLSearchParams[] = [];
  const client = new QianjiClient({
    fetch: async (_input, init) => {
      forms.push(new URLSearchParams(String(init?.body)));
      return Response.json({ ec: 200, data: { list: [
        { id: "", name: "默认组", tags: [{ id: "tag.alpha", name: "Alpha", status: 1 }] },
        { id: "group-2", name: "项目", tags: [{ id: "tag-2", name: "Alpha", status: 2 }] },
      ] } });
    },
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  assert.deepEqual(await client.listTags(account, -1, 123), [
    { id: "tag.alpha", name: "Alpha", status: 1, groupId: "", groupName: "默认组" },
    { id: "tag-2", name: "Alpha", status: 2, groupId: "group-2", groupName: "项目" },
  ]);
  assert.equal(forms[0]?.get("lasttime"), "123");
});

test("币种目录保留 APK 返回的字符串标识", async () => {
  const client = new QianjiClient({
    fetch: async () => Response.json({ ec: 200, data: {
      list: [{ symbol: "usdt", baseprice: 7.1, pricetime: 1_770_000_000 }],
    } }),
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  assert.deepEqual(await client.listCurrencies(account), [
    { symbol: "usdt", baseprice: 7.1, pricetime: 1_770_000_000 },
  ]);
});

test("client/init 使用 APK 已确认参数，并为省略的币种配置应用 APK 默认值", async () => {
  let form: URLSearchParams | undefined;
  const client = new QianjiClient({
    fetch: async (_input, init) => {
      form = new URLSearchParams(String(init?.body));
      return Response.json({ ec: 200, data: {
        userinfo: { id: "uid-1", viptype: 4, vipstart: 100, vipend: 200 },
        userconfigs: { basecur: "usdt", mcurrency: 1, private_setting: "ignored" },
        books: [{ bookid: -1, name: "默认账本" }],
      } });
    },
  });
  const account: QianjiAccount = { id: 1, uid: "uid-1", utoken: "t", devid: "d" };

  const result = await (client as unknown as {
    initialize(account: QianjiAccount, currentIsVip: boolean): Promise<unknown>;
  }).initialize(account, true);

  assert.deepEqual(Object.fromEntries(form!), {
    uid: "uid-1",
    v: "0",
    vvmark: "1",
    newinstall: "0",
    upgradealert: "0",
    fr: "uid-1",
  });
  assert.deepEqual(result, {
    user: { id: "uid-1", viptype: 4, vipstart: 100, vipend: 200 },
    books: [{ bookid: "-1", name: "默认账本" }],
    userConfig: { baseCurrency: "usdt", multiCurrencyEnabled: true },
  });

  const withoutBooks = new QianjiClient({
    fetch: async () => Response.json({ ec: 200, data: { userinfo: { id: "uid-1" } } }),
  });
  assert.deepEqual(await withoutBooks.initialize(account, false), {
    user: { id: "uid-1" },
    books: [],
    userConfig: { baseCurrency: "CNY", multiCurrencyEnabled: false },
  });
});

test("pull 保留分类失效信号和复杂账单关系 ID", async () => {
  const sourceId = "1770000000000300000";
  const refundId = "1770000000000300020";
  const client = new QianjiClient({
    fetch: async () => new Response(
      `{"ec":200,"data":{"changes":[{"id":${refundId},"bookid":1,"time":1770000000,"type":20,"money":1,"extra":{"refundsid":${sourceId}}}],"deletes":[],"categories":[{"id":2,"bookid":1}],"bookid":1,"pageoffset":0,"hasmore":0,"pagesign":"","lasttimes":{"cursor":1}}}`,
    ),
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  const page = await client.pullBills(account, { bookid: "-1", pageoffset: 0, pagesign: "" });
  assert.deepEqual(page.categories, [{ id: "2", bookid: "1" }]);
  assert.equal((page.changes[0]?.extra as Record<string, unknown>).refundsid, sourceId);
});

test("调试日志记录上游原始内容并递归脱敏 token 字段", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "qianji-debug-"));
  const logDirectory = join(root, "private");
  const logPath = join(logDirectory, "upstream.jsonl");
  const passwordMd5 = md5("debug-password");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const client = new QianjiClient({
    debugLogPath: logPath,
    fetch: async () => new Response(
      '{"ec":200,"data":{"user":{"id":"debug-uid"},"token":"response-token","nested":{"refreshToken":"nested-token"}}}',
      { status: 200 },
    ),
  });
  await client.login("debug@example.com", passwordMd5, "HEADER-DEVID");

  const line = readFileSync(logPath, "utf8").trim();
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(entry), ["timestamp", "method", "url", "requestBody", "status", "responseBody"]);
  assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.method, "POST");
  assert.equal(entry.url, "https://api.qianjiapp.com/account/login");
  assert.equal(entry.requestBody, "[REDACTED]");
  assert.equal(entry.status, 200);
  assert.equal(entry.responseBody, "[REDACTED]");
  assert.equal(line.includes("debug@example.com"), false);
  assert.equal(line.includes(passwordMd5), false);
  assert.equal(line.includes("debug-uid"), false);
  assert.equal(line.includes("response-token"), false);
  assert.equal(line.includes("nested-token"), false);
  assert.equal(line.includes("HEADER-DEVID"), false);
  assert.equal(statSync(logDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("登录失败区分账号密码不匹配和成功响应字段缺失", async () => {
  const cases = [
    {
      response: { ec: 8888, em: '{"msg":"登录失败！账号和密码不匹配-1"}', data: {} },
      code: "QIANJI_LOGIN_REJECTED",
      message: "钱迹登录失败：账号和密码不匹配",
      status: 401,
    },
    {
      response: { ec: 200, em: "", data: { user: { id: "uid-1" } } },
      code: "QIANJI_RESPONSE_INVALID",
      message: "钱迹返回登录成功状态，但缺少 token",
      status: 502,
    },
    {
      response: { ec: 200, em: "", data: { user: { userid: "legacy-uid" }, token: "secret-token" } },
      code: "QIANJI_RESPONSE_INVALID",
      message: "钱迹返回登录成功状态，但缺少 user.id",
      status: 502,
    },
  ];

  for (const expected of cases) {
    const client = new QianjiClient({ fetch: async () => Response.json(expected.response) });
    await assert.rejects(
      () => client.login("login-name", md5("password"), "DEVICE-ID"),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        if (!(error instanceof AppError)) return false;
        assert.equal(error.code, expected.code);
        assert.equal(error.message, expected.message);
        assert.equal(error.httpStatus, expected.status);
        return true;
      },
    );
  }
});

test("新版报销未迁移时返回可识别的账号迁移错误", async () => {
  const client = new QianjiClient({
    fetch: async () => Response.json({
      ec: 8888,
      em: '{"msg":"请升级到最新的公测版本"}',
      data: {},
    }),
  });
  await assert.rejects(
    () => client.reimburseBills(
      { id: 1, uid: "u", utoken: "t", devid: "d" },
      { allocations: { "1770000000000000001": { money: 1 } } },
    ),
    (error: unknown) => error instanceof AppError &&
      error.code === "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED" &&
      error.httpStatus === 409 &&
      error.message.includes("尚未迁移到新版报销"),
  );
});

test("创建、修改、删除 syncall 请求结构 fixture 保持精确", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; form: URLSearchParams }> = [];
  const client = new QianjiClient({
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: String(init?.method),
        headers: new Headers(init?.headers),
        form: new URLSearchParams(String(init?.body)),
      });
      return Response.json({
        ec: 200,
        data: {
          sync_result: {
            bill: { new_ids: [], update_ids: [], del_ids: [], conf_ids: [], has_failed: false },
          },
        },
      });
    },
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };
  const id = "1770000000000123456";
  const fullBill = {
    id,
    userid: "u",
    bookid: 1,
    time: 1_770_000_000,
    type: 0,
    money: 25.8,
    remark: "create",
    status: 2,
    cateid: 2,
    assetid: -1,
    fromid: -1,
    targetid: -1,
    createtime: 1_770_000_000,
    updatetime: 1_770_000_000,
    platform: 0,
    images: [],
  };

  await client.syncBills(account, { bills: { changelist: [fullBill] } });
  await client.syncBills(account, { bills: { changelist: [{ ...fullBill, remark: "update", unknown: true }] } });
  await client.syncBills(account, { bills: { dellist: [id] } });

  assert.deepEqual(requests.map(({ form }) => form.get("v")), [
    '{"bills":{"changelist":[{"id":1770000000000123456,"userid":"u","bookid":1,"time":1770000000,"type":0,"money":25.8,"remark":"create","status":2,"cateid":2,"assetid":-1,"fromid":-1,"targetid":-1,"createtime":1770000000,"updatetime":1770000000,"platform":0,"images":[]}]}}',
    '{"bills":{"changelist":[{"id":1770000000000123456,"userid":"u","bookid":1,"time":1770000000,"type":0,"money":25.8,"remark":"update","status":2,"cateid":2,"assetid":-1,"fromid":-1,"targetid":-1,"createtime":1770000000,"updatetime":1770000000,"platform":0,"images":[],"unknown":true}]}}',
    '{"bills":{"dellist":[1770000000000123456]}}',
  ]);
  for (const { url, method, headers, form } of requests) {
    assert.equal(url, "https://api.qianjiapp.com/bill/syncall");
    assert.equal(method, "POST");
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(headers.get("ctrl"), "bill");
    assert.equal(headers.get("act"), "syncall");
    assert.equal(headers.get("devid"), "d");
    assert.equal(headers.get("utoken"), "t");
    assert.equal(headers.get("htoken"), "1");
    assert.equal(form.get("uid"), "u");
    assert.equal(form.get("fr"), "u");
  }
});

test("退款、报销迁移、报销和取消报销请求结构与 APK 证据一致", async () => {
  const requests: Array<{ path: string; headers: Headers; form: URLSearchParams }> = [];
  const sourceId = "1770000000000123456";
  const refundId = "1770000000000123457";
  const client = new QianjiClient({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        headers: new Headers(init?.headers),
        form: new URLSearchParams(String(init?.body)),
      });
      if (path === "/bill/refund2") {
        return Response.json({
          ec: 200,
          data: {
            list: [
              { id: sourceId, bookid: -1, type: 0, time: 1, money: 10, extra: { rfds: { [refundId]: 3 } } },
              { id: refundId, bookid: -1, type: 20, time: 2, money: 3, extra: { refundsid: sourceId } },
            ],
          },
        });
      }
      if (path === "/baoxiao/baoxiao") {
        return Response.json({
          ec: 200,
          data: {
            asset: { id: 3 },
            bills: [{ id: sourceId, bookid: -1, type: 5, time: 1, money: 10 }],
          },
        });
      }
      if (path === "/baoxiao/upgradev2") return Response.json({ ec: 200, data: { v: 1 } });
      return Response.json({ ec: 200, data: {} });
    },
  });
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  const refund = await client.refundBill(account, sourceId, {
    money: 3,
    time: 1_770_000_000,
    assetid: "3",
    remark: "退款",
    tags: ["tag-1"],
  });
  const reimbursement = await client.reimburseBills(account, {
    allocations: {
      [sourceId]: { curr: { ss: "USD", sv: 4, ts: "CNY", tv: 28, bs: "CNY", bv: 28 } },
    },
    assetId: "3",
    time: 1_770_000_100,
    remark: "报销",
    tagIds: ["tag-1"],
  });
  await client.upgradeReimbursement(account);
  await client.cancelReimbursement(account, [sourceId]);

  assert.equal(refund[1]?.id, refundId);
  assert.equal((refund[1]?.extra as Record<string, unknown>).refundsid, sourceId);
  assert.equal(reimbursement.asset?.id, "3");
  assert.equal(reimbursement.bills[0]?.id, sourceId);
  assert.deepEqual(requests.map(({ path }) => path), [
    "/bill/refund2",
    "/baoxiao/baoxiao",
    "/baoxiao/upgradev2",
    "/baoxiao/cancelbaoxiao",
  ]);
  assert.deepEqual(requests.map(({ form }) => Object.fromEntries(form)), [
    {
      uid: "u",
      did: sourceId,
      v: `{"money":3,"time":1770000000,"assetid":3,"remark":"退款","tags":["tag-1"]}`,
      fr: "u",
    },
    {
      uid: "u",
      v: `{"${sourceId}":{"curr":{"ss":"USD","sv":4,"ts":"CNY","tv":28,"bs":"CNY","bv":28}}}`,
      did: "3",
      bxtime: "1770000100",
      remark: "报销",
      tags: `["tag-1"]`,
      fr: "u",
    },
    { uid: "u", fr: "u" },
    { uid: "u", v: `[${sourceId}]`, fr: "u" },
  ]);
  for (const { headers } of requests) {
    assert.equal(headers.get("utoken"), "t");
    assert.equal(headers.get("htoken"), null);
  }
});

test("新版报销迁移只接受 APK 的成功值 1", async () => {
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };
  for (const data of [0, { v: 0 }, { v: 1, extra: true }]) {
    const client = new QianjiClient({ fetch: async () => Response.json({ ec: 200, data }) });
    await assert.rejects(
      client.upgradeReimbursement(account),
      (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
    );
  }
});

test("退款响应缺少 APK 要求的 data.list 数组时拒绝", async () => {
  const account: QianjiAccount = { id: 1, uid: "u", utoken: "t", devid: "d" };

  for (const data of [{}, { list: {} }]) {
    const client = new QianjiClient({ fetch: async () => Response.json({ ec: 200, data }) });
    await assert.rejects(
      client.refundBill(account, "1770000000000123456", { money: 1, time: 1 }),
      (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
    );
  }
  const invalidEnvelope = new QianjiClient({ fetch: async () => new Response("not-json") });
  await assert.rejects(
    invalidEnvelope.refundBill(account, "1770000000000123456", { money: 1, time: 1 }),
    (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID",
  );
});
