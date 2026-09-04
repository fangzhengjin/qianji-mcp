import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";

import { Client, StreamableHTTPClientTransport, UrlElicitationRequiredError } from "@modelcontextprotocol/client";

import { BindingTicketManager } from "../src/auth.ts";
import { Store, type PatRole } from "../src/data-store.ts";
import { createHttpApplication, createShutdown, loadConfig, type AppConfig } from "../src/http-server.ts";
import { POSITIVE_ID_PATTERN } from "../src/ids.ts";
import { QianjiClient, md5, type QianjiFetch } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import serverInstructions from "../src/server-instructions.md" with { type: "text" };
import test from "./context.ts";

const ADMIN_PAT = `mt_pat_${"a".repeat(43)}`;
const BUSINESS_TOOLS = [
  "create_bills",
  "connect_qianji",
  "create_refund",
  "create_transfer",
  "cancel_reimbursements",
  "delete_bills",
  "delete_reimbursement",
  "delete_refund",
  "disconnect_qianji",
  "get_bill",
  "get_bill_statistics",
  "get_budget",
  "get_user_info",
  "list_assets",
  "list_bills",
  "list_book_members",
  "list_books",
  "list_categories",
  "list_debt_accounts",
  "list_tags",
  "refresh_cache",
  "reimburse_bills",
  "update_bills",
  "update_refund",
  "update_transfer",
].sort();

function setupApp(options: {
  role?: PatRole;
  bound?: boolean;
  fetch?: QianjiFetch;
  bindingNow?: () => number;
} = {}) {
  const role = options.role ?? "user";
  const store = new Store(":memory:");
  store.ensureAdminPat(ADMIN_PAT);
  const token = role === "admin"
    ? ADMIN_PAT
    : store.createPat("测试用户", null).token;
  if (options.bound ?? role === "user") {
    const pat = store.verifyPat(token)!;
    store.bindPat(pat.id, "uid-test", "utoken-test", "DEVICE-TEST");
  }
  const service = new MoneyTrackService(
    store,
    new QianjiClient({ fetch: options.fetch ?? (async () => { throw new Error("unexpected upstream call"); }) }),
  );
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    publicMcpUrl: new URL("http://test.local/mcp"),
    apiServer: new URL("https://api.qianjiapp.com"),
    superadminPat: ADMIN_PAT,
  };
  const bindingTickets = new BindingTicketManager(options.bindingNow);
  const app = createHttpApplication(config, store, service, bindingTickets);
  return { store, app, service, token, bindingTickets };
}

function connectionInitializationResponse(path: string, uid: string): Response | undefined {
  if (path === "/client/init") return Response.json({ ec: 200, data: {
    userinfo: { id: uid, viptype: -1 },
    userconfigs: { basecur: "CNY", mcurrency: 1 },
    books: [],
  } });
  if (path === "/syncv2/pull") return Response.json({ ec: 200, data: {
    changes: [], deletes: [], categories: [], bookid: -1, pageoffset: 0,
    hasmore: 0, pagesign: "", lasttimes: { cursor: 1 },
  } });
  return undefined;
}

function appFetch(
  app: { fetch(request: Request): Promise<Response> },
  observe?: (response: Response) => void,
): QianjiFetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const headers = new Headers(request.headers);
    if (!headers.has("host")) headers.set("host", new URL(request.url).host);
    const response = await app.fetch(new Request(request, { headers }));
    observe?.(response);
    return response;
  };
}

function httpRequest(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", new URL(url).host);
  return new Request(url, { ...init, headers });
}

function transport(
  app: { fetch(request: Request): Promise<Response> },
  token: string,
  observe?: (response: Response) => void,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: appFetch(app, observe),
    authProvider: { token: async () => token },
  });
}

function assertCamelCaseProperties(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
      assert.match(name, /^[a-z][A-Za-z0-9]*$/);
      assertCamelCaseProperties(child);
    }
  }
  if (Array.isArray(record.anyOf)) record.anyOf.forEach(assertCamelCaseProperties);
  if (Array.isArray(record.oneOf)) record.oneOf.forEach(assertCamelCaseProperties);
  if (record.items) assertCamelCaseProperties(record.items);
}

function assertPropertyDescriptions(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const child of Object.values(record.properties as Record<string, unknown>)) {
      assert.equal(typeof (child as Record<string, unknown>).description, "string");
      assertPropertyDescriptions(child);
    }
  }
  if (Array.isArray(record.anyOf)) record.anyOf.forEach(assertPropertyDescriptions);
  if (Array.isArray(record.oneOf)) record.oneOf.forEach(assertPropertyDescriptions);
  if (record.items) assertPropertyDescriptions(record.items);
}

function assertShortDisplayPunctuation(rule: string, path: string): void {
  assert.doesNotMatch(rule, /[。.]\s*$/, `${path} must not end with a full stop`);
  assert.doesNotMatch(rule, /；/, `${path} must not use a semicolon`);
}

function assertInstructionLinePunctuation(rule: string, path: string): void {
  const text = rule.trim();
  if (/^(?:#{1,6}\s|[-*]\s|\d+\.\s)/.test(text)) {
    assert.doesNotMatch(text, /[。.]\s*$/, `${path} short display must not end with a full stop`);
  } else if (!text.endsWith("：")) {
    assert.match(text, /[。！？]$/, `${path} continuous prose must end with sentence punctuation`);
  }
}

function assertDescriptionPunctuation(schema: unknown, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  for (const [name, child] of Object.entries(schema as Record<string, unknown>)) {
    if (name === "description" && typeof child === "string") assertShortDisplayPunctuation(child, `${path}.description`);
    else if (Array.isArray(child)) child.forEach((item, index) => assertDescriptionPunctuation(item, `${path}.${name}[${index}]`));
    else assertDescriptionPunctuation(child, `${path}.${name}`);
  }
}

function assertChoiceDescriptions(schema: unknown, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = record[key];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      if (branch && typeof branch === "object" && !Array.isArray(branch) && Object.hasOwn(branch, "const")) {
        const choice = branch as Record<string, unknown>;
        assert.equal(typeof choice.description, "string", `${path}.${key}[${index}] choice must have a description`);
        assert.doesNotMatch(
          String(choice.description),
          new RegExp(`^${String(choice.const).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|[:：；，、]|$)`),
          `${path}.${key}[${index}] description must not repeat its literal value`,
        );
      }
      assertChoiceDescriptions(branch, `${path}.${key}[${index}]`);
    }
  }
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
      assertChoiceDescriptions(child, `${path}.${name}`);
    }
  }
  if (record.items) assertChoiceDescriptions(record.items, `${path}.items`);
}

function assertUnitDescriptions(schema: unknown, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
      const description = String((child as Record<string, unknown>).description ?? "");
      if (name === "money" || name === "fee" || name === "discount") {
        assert.match(description, /币种主单位.*不使用.*最小货币单位.*CNY.*USD.*JPY/, `${path}.${name} must state the currency unit`);
      } else if (["time", "startTime", "endTime", "createTime", "createStartTime", "createEndTime", "updateTime", "registeredAt", "vipStart", "vipEnd", "expiresAt", "createdAt", "dailyWriteResetsAt"].includes(name)) {
        assert.match(description, /Unix 秒/, `${path}.${name} must state the time unit`);
      } else if (name === "memberCount") {
        assert.match(description, /单位为人/, `${path}.${name} must state the count unit`);
      } else if (["dailyWriteLimit", "dailyWriteUsed", "dailyWriteRemaining"].includes(name)) {
        assert.match(description, /单位为次/, `${path}.${name} must state the quota unit`);
      } else if (["bookCount", "visibleBookCount", "hiddenBookCount", "assetCount", "categoryCount", "tagCount"].includes(name)) {
        assert.match(description, /单位为个/, `${path}.${name} must state the count unit`);
      } else if (name === "billCount" || (name === "limit" && /每页条数/.test(description))) {
        assert.match(description, /单位为条/, `${path}.${name} must state the count unit`);
      }
      assertUnitDescriptions(child, `${path}.${name}`);
    }
  }
  if (Array.isArray(record.anyOf)) record.anyOf.forEach((child, index) => assertUnitDescriptions(child, `${path}.anyOf[${index}]`));
  if (Array.isArray(record.oneOf)) record.oneOf.forEach((child, index) => assertUnitDescriptions(child, `${path}.oneOf[${index}]`));
  if (record.items) assertUnitDescriptions(record.items, `${path}.items`);
}

function assertInputContract(schema: unknown, path = "inputSchema"): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object") {
    assert.equal(Array.isArray(record.required), true, `${path}.required must be an array`);
    const properties = record.properties as Record<string, unknown> | undefined;
    for (const [name, child] of Object.entries(properties ?? {})) {
      const description = (child as Record<string, unknown>).description;
      assert.equal(typeof description, "string", `${path}.${name} must have a description`);
      assert.doesNotMatch(String(description), /^(?:必填|可选)[；，]/, `${path}.${name} must use JSON Schema for requiredness`);
      assertInputContract(child, `${path}.${name}`);
    }
  }
  if (Array.isArray(record.anyOf)) {
    record.anyOf.forEach((child, index) => assertInputContract(child, `${path}.anyOf[${index}]`));
  }
  if (record.items) assertInputContract(record.items, `${path}.items`);
}

function assertQianjiNumericIdInputRanges(schema: unknown, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
      if (/^(?:bookId|categoryId|categoryIds|assetId|assetIds|fromAssetId|targetAssetId|billId|sourceBillId|sourceBillIds|refundBillId|reimbursementBillId)$/.test(name)) {
        const candidate = name.endsWith("Ids") ? (child as Record<string, unknown>).items : child;
        const target = Array.isArray((candidate as Record<string, unknown>)?.anyOf)
          ? ((candidate as Record<string, unknown>).anyOf as Record<string, unknown>[]).find(({ type }) => type === "string")
          : candidate;
        assert.equal((target as Record<string, unknown>)?.maxLength, 19, `${path}.${name} must fit a Java long`);
      }
      assertQianjiNumericIdInputRanges(child, `${path}.${name}`);
    }
  }
  if (Array.isArray(record.anyOf)) record.anyOf.forEach((child, index) => assertQianjiNumericIdInputRanges(child, `${path}.anyOf[${index}]`));
  if (record.items) assertQianjiNumericIdInputRanges(record.items, `${path}.items`);
}

function schemaNode(schema: unknown, ...path: string[]): Record<string, unknown> {
  let node = schema as Record<string, unknown>;
  for (const segment of path) {
    const next = segment === "items"
      ? node.items
      : (node.properties as Record<string, unknown> | undefined)?.[segment];
    assert.equal(typeof next, "object", `Schema path does not exist: ${path.join(".")}`);
    node = next as Record<string, unknown>;
  }
  return node;
}

const connectionDeliveryInstruction = "请只向用户原样返回下方内容，不要省略、改写、重排或补充说明，不要输出本段提示";

function assertConnectionLinkUserMessage(message: string, url: string): void {
  const start = message.indexOf("钱迹绑定链接已生成：");
  assert.notEqual(start, -1);
  const lines = message.slice(start).split("\n");
  assert.deepEqual(lines, [
    `钱迹绑定链接已生成：[点击绑定钱迹](${url})`,
    "",
    lines[2],
    "",
    "若链接被内置浏览器拦截，请复制以下完整地址到系统浏览器：",
    "",
    "```",
    url,
    "```",
  ]);
  assert.match(lines[2] ?? "", /^有效期至 \*\*.+（北京时间）\*\*，只能使用一次！$/);
}

test("服务器级说明同时通过新版 discover 和旧版 initialize 返回", async (t) => {
  const { store, app, token } = setupApp();
  assert.doesNotMatch(serverInstructions, /list_pats|create_pat|delete_pat/);
  for (const [index, line] of serverInstructions.split("\n").entries()) {
    if (line.trim()) assertInstructionLinePunctuation(line, `serverInstructions line ${index + 1}`);
  }
  for (const toolName of BUSINESS_TOOLS) {
    assert.equal(serverInstructions.includes("`" + toolName + "`"), true, `server instructions must cover ${toolName}`);
  }
  assert.match(serverInstructions, /账本.*list_books.*nameKeyword/);
  assert.match(serverInstructions, /预算使用情况.*get_budget.*月份起始日.*includeDailyStatistics=true/);
  assert.match(serverInstructions, /批量判断转账方向.*list_bills.*fromId.*targetId.*一次.*list_assets/s);
  assert.match(serverInstructions, /列表字段无歧义.*不要逐条调用.*get_bill.*重复或近似候选.*关系冲突.*摘要缺失字段.*完整记录.*写入成功后.*完整账单/s);
  assert.doesNotMatch(serverInstructions, /写入后验证/);
  assert.match(serverInstructions, /update_transfer.*同一次修改.*最终场景、金额和双边资产/s);
  assert.match(serverInstructions, /refresh_cache.*全部目录缓存.*币种目录/s);
  assert.match(serverInstructions, /旧版本将不能继续使用报销.*明确同意.*confirmReimbursementUpgrade.*不得预先同意.*只在钱迹明确要求时迁移并只重试一次/s);
  assert.match(serverInstructions, /迁移完成但报销失败.*不得再次迁移/s);
  assert.match(serverInstructions, /删除或取消.*取得用户确认/s);
  assert.match(serverInstructions, /普通收支、待报销支出、转账或还款.*delete_bills/s);
  assert.match(serverInstructions, /取消一笔或多笔源账单的全部报销关系.*cancel_reimbursements.*保留源账单/s);
  assert.match(serverInstructions, /WRITE_PARTIAL.*输入序号.*成功项已经写入.*不得重试/s);
  assert.match(serverInstructions, /汇率.*HALF_UP.*10 位.*换算金额.*HALF_EVEN.*2 位/s);
  const clients = [
    new Client(
      { name: "instructions-modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    ),
    new Client({ name: "instructions-legacy-test", version: "1.0.0" }),
  ];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await app.close();
    store.close();
  });

  for (const client of clients) {
    await client.connect(transport(app, token));
    assert.equal(client.getInstructions(), serverInstructions.trim());
  }
});

test("普通 PAT 使用 2026-07-28 并取得当前业务工具契约", async (t) => {
  const { store, app, token } = setupApp();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "modern-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());

  await client.connect(transport(app, token));
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    BUSINESS_TOOLS,
  );
  assert.equal(tools.every((tool) => Boolean(tool.inputSchema) && Boolean(tool.outputSchema)), true);
  for (const tool of tools) {
    assertShortDisplayPunctuation(tool.description ?? "", `${tool.name}.description`);
    assertDescriptionPunctuation(tool.inputSchema, `${tool.name}.inputSchema`);
    assertDescriptionPunctuation(tool.outputSchema, `${tool.name}.outputSchema`);
    assertCamelCaseProperties(tool.inputSchema);
    assertCamelCaseProperties(tool.outputSchema);
    assertPropertyDescriptions(tool.inputSchema);
    assertPropertyDescriptions(tool.outputSchema);
    assertChoiceDescriptions(tool.inputSchema, `${tool.name}.inputSchema`);
    assertChoiceDescriptions(tool.outputSchema, `${tool.name}.outputSchema`);
    assertUnitDescriptions(tool.inputSchema, `${tool.name}.inputSchema`);
    assertUnitDescriptions(tool.outputSchema, `${tool.name}.outputSchema`);
    assertInputContract(tool.inputSchema, `${tool.name}.inputSchema`);
    assertQianjiNumericIdInputRanges(tool.inputSchema, `${tool.name}.inputSchema`);
  }
  assert.deepEqual(
    schemaNode(tools.find(({ name }) => name === "create_bills")?.inputSchema, "bills", "items").required,
    ["type", "money", "categoryId"],
  );
  const createBillInput = schemaNode(tools.find(({ name }) => name === "create_bills")?.inputSchema, "bills", "items");
  assert.match(
    String(schemaNode(createBillInput, "money").description),
    /默认使用所选资产币种.*currencyConversion\.sourceCurrency.*未选择资产.*钱迹本位币/,
  );
  assert.deepEqual(
    tools.find(({ name }) => name === "create_transfer")?.inputSchema.required,
    ["money", "fromAssetId", "targetAssetId"],
  );
  for (const [name, path] of [["create_bills", ["bills", "items"]], ["create_transfer", []]] as const) {
    const inputSchema = schemaNode(tools.find(({ name: toolName }) => toolName === name)?.inputSchema, ...path);
    assert.equal(schemaNode(inputSchema, "excludeFromIncomeExpense").default, false);
    assert.equal(schemaNode(inputSchema, "excludeFromBudget").default, false);
    assert.equal("flag" in ((inputSchema?.properties ?? {}) as Record<string, unknown>), false);
  }
  for (const [name, path] of [["update_bills", ["updates", "items", "patch"]], ["update_transfer", ["patch"]]] as const) {
    const patch = schemaNode(tools.find(({ name: toolName }) => toolName === name)?.inputSchema, ...path);
    assert.equal(schemaNode(patch, "excludeFromIncomeExpense").default, undefined);
    assert.equal(schemaNode(patch, "excludeFromBudget").default, undefined);
    assert.equal("flag" in (patch.properties as Record<string, unknown>), false);
  }
  assert.equal(schemaNode(tools.find(({ name }) => name === "create_transfer")?.inputSchema, "creditRepayment").default, false);
  const billOutput = schemaNode(tools.find(({ name }) => name === "get_bill")?.outputSchema, "bill");
  assert.match(String(schemaNode(billOutput, "money").description), /普通支出、转账或信用卡还款.*APP 主金额输入框/);
  assert.match(String(schemaNode(billOutput, "fee").description), /转账或信用卡还款.*包含在 money/);
  assert.match(String(schemaNode(billOutput, "discount").description), /普通支出、转账或信用卡还款.*money - discount/);
  assert.equal(schemaNode(billOutput, "excludeFromIncomeExpense").type, "boolean");
  assert.equal(schemaNode(billOutput, "excludeFromBudget").type, "boolean");
  for (const field of ["flag", "includeIncomeExpense", "includeBudget"]) {
    assert.equal(field in (billOutput.properties as Record<string, unknown>), false);
  }
  for (const name of ["list_books", "list_book_members", "list_assets", "list_categories", "list_tags", "get_user_info", "refresh_cache", "list_bills"]) {
    assert.deepEqual(tools.find((tool) => tool.name === name)?.inputSchema.required, []);
  }
  for (const tool of tools.filter(({ name }) => name.startsWith("list_"))) {
    assert.equal("results" in (tool.outputSchema!.properties as Record<string, unknown>), true, `${tool.name} must return results`);
  }
  for (const tool of tools) {
    assert.doesNotMatch(tool.description ?? "", /仅当用户|调用前|重试|nextCursor|不要逐条|type\s*-?\d|reimbursable=|cascadeRelatedBills/);
  }
  for (const name of ["list_books", "list_assets"]) {
    const tool = tools.find(({ name: toolName }) => toolName === name)!;
    assert.match(tool.description ?? "", /查询当前钱迹账号/);
    assert.equal(String(schemaNode(tool.inputSchema, "includeHidden").description), name === "list_books" ? "是否包含隐藏账本" : "是否包含已隐藏资产");
  }
  const listBooksInput = tools.find(({ name }) => name === "list_books")!.inputSchema;
  assert.equal(schemaNode(listBooksInput, "nameKeyword").minLength, 1);
  assert.equal(schemaNode(listBooksInput, "nameKeyword").maxLength, 42);
  assert.match(String(schemaNode(listBooksInput, "nameKeyword").description), /匹配账本名称.*不区分大小写.*字面子串/);
  const listAssetsInput = tools.find(({ name }) => name === "list_assets")!.inputSchema;
  assert.equal(schemaNode(listAssetsInput, "includeBalances").default, false);
  assert.equal(String(schemaNode(listAssetsInput, "includeBalances").description), "是否返回资产当前余额和信用额度");
  assert.equal(schemaNode(listAssetsInput, "nameKeyword").minLength, 1);
  assert.equal(schemaNode(listAssetsInput, "nameKeyword").maxLength, undefined);
  assert.match(String(schemaNode(listAssetsInput, "nameKeyword").description), /匹配资产名称.*不区分大小写.*字面子串.*不匹配分组名、机构字段或别名/);
  assert.equal(String(schemaNode(tools.find(({ name }) => name === "list_bills")?.inputSchema, "allBooks").description), "是否查询全部账本，启用时忽略 bookId");
  assert.equal(schemaNode(tools.find(({ name }) => name === "list_bills")?.inputSchema, "remarkKeyword").maxLength, 42);
  assert.match(String(schemaNode(tools.find(({ name }) => name === "list_bills")?.inputSchema, "remarkKeyword").description), /匹配账单备注.*不区分大小写.*字面子串/);
  const listBillsTool = tools.find(({ name }) => name === "list_bills")!;
  const getBillTool = tools.find(({ name }) => name === "get_bill")!;
  assert.equal(listBillsTool.description, "分页查询当前钱迹账号的账单摘要");
  assert.equal(getBillTool.description, "按账单 ID 返回完整账单详情");
  for (const [toolName, path] of [
    ["create_bills", ["bills", "items", "tagIds"]],
    ["update_bills", ["updates", "items", "patch", "tagIds"]],
    ["create_transfer", ["tagIds"]],
    ["update_transfer", ["patch", "tagIds"]],
    ["create_refund", ["tagIds"]],
    ["update_refund", ["patch", "tagIds"]],
    ["reimburse_bills", ["tagIds"]],
  ] as const) {
    const field = schemaNode(tools.find(({ name }) => name === toolName)?.inputSchema, ...path);
    assert.equal(field.maxItems, 8);
    assert.equal(field.uniqueItems, true);
    assert.equal((field.items as Record<string, unknown>).maxLength, undefined);
    assert.doesNotMatch(String(field.description), /8|VIP|get_user_info|最多/);
  }
  assert.equal(schemaNode(listBillsTool.inputSchema, "tagIds").maxItems, 100);
  assert.equal((schemaNode(listBillsTool.inputSchema, "tagIds").items as Record<string, unknown>).maxLength, undefined);
  assert.equal((schemaNode(listBillsTool.inputSchema, "memberIds").items as Record<string, unknown>).maxLength, undefined);
  assert.equal(schemaNode(listBillsTool.inputSchema, "currency").pattern, undefined);
  assert.equal(schemaNode(listBillsTool.inputSchema, "currency").minLength, 1);
  const createBills = tools.find(({ name }) => name === "create_bills")!;
  const createBillItem = schemaNode(createBills.inputSchema, "bills", "items");
  const createMoney = schemaNode(createBillItem, "money");
  assert.equal(createMoney.maximum, 9_999_999_999.99);
  assert.equal(createMoney.multipleOf, undefined);
  assert.doesNotMatch(String(createMoney.description), /最多|不超过|两位小数/);
  assert.equal(schemaNode(createBills.inputSchema, "bills").maxItems, 100);
  assert.doesNotMatch(String(schemaNode(createBills.inputSchema, "bills").description), /100|最多/);
  assert.equal(schemaNode(createBillItem, "remark").maxLength, 500);
  assert.doesNotMatch(String(schemaNode(createBillItem, "remark").description), /500|最多/);
  assert.equal(listBillsTool.annotations?.readOnlyHint, true);
  assert.equal(getBillTool.annotations?.readOnlyHint, true);
  const updateBillBookId = schemaNode(tools.find(({ name }) => name === "update_bills")?.inputSchema, "updates", "items", "patch", "bookId");
  assert.equal(updateBillBookId.default, undefined);
  assert.equal(String(updateBillBookId.description), "新的账本 ID");
  assert.equal(String(schemaNode(tools.find(({ name }) => name === "update_transfer")?.inputSchema, "patch", "bookId").description), "新的账本 ID");
  const updateBillsTool = tools.find(({ name }) => name === "update_bills")!;
  const updateBillPatch = schemaNode(updateBillsTool.inputSchema, "updates", "items", "patch");
  assert.equal("type" in (updateBillPatch.properties as Record<string, unknown>), false);
  assert.equal(updateBillsTool.description, "批量修改普通支出、收入或待报销支出账单");
  const tagStatus = schemaNode(tools.find(({ name }) => name === "list_tags")?.inputSchema, "status");
  assert.equal(tagStatus.default, 1);
  assert.equal(String(tagStatus.description), "标签状态范围");
  assert.deepEqual(
    (tagStatus.anyOf as Array<{ const: number; description: string }>).map(({ const: value, description }) => [value, description]),
    [[-1, "全部标签"], [1, "正常标签"], [2, "归档标签"]],
  );
  assert.equal(
    String(schemaNode(tools.find(({ name }) => name === "create_bills")?.inputSchema, "bills", "items", "reimbursable").description),
    "是否将支出标记为待报销",
  );
  assert.equal(
    String(schemaNode(tools.find(({ name }) => name === "update_bills")?.inputSchema, "updates", "items", "patch", "reimbursable").description),
    "新的待报销状态",
  );
  for (const [toolName, path] of [
    ["create_bills", ["bills", "items", "money"]],
    ["update_bills", ["updates", "items", "patch", "money"]],
  ] as const) {
    assert.match(
      String(schemaNode(tools.find(({ name }) => name === toolName)?.inputSchema, ...path).description),
      /APP 主金额输入框.*普通支出实际扣款为 money - discount/,
    );
  }
  const categoryType = schemaNode(tools.find(({ name }) => name === "list_categories")?.inputSchema, "type");
  assert.deepEqual((categoryType.anyOf as Array<{ const: number }>).map((branch) => branch.const), [-1, 0, 1]);
  assert.deepEqual(
    (categoryType.anyOf as Array<{ description: string }>).map((branch) => branch.description),
    ["全部分类", "支出分类", "收入分类"],
  );
  const billType = schemaNode(tools.find(({ name }) => name === "list_bills")?.inputSchema, "type");
  assert.deepEqual(
    (billType.anyOf as Array<{ const: number; description: string }>).map(({ const: value, description }) => [value, description]),
    [
      [0, "支出"],
      [1, "收入"],
      [2, "转账"],
      [3, "信用卡还款"],
      [4, "收回借出款"],
      [5, "待报销支出（报销源账单）"],
      [6, "新增借入"],
      [7, "新增借出"],
      [9, "偿还借入款"],
      [10, "借入利息支出"],
      [11, "借出利息收入"],
      [20, "退款子账单"],
      [21, "报销入账子账单"],
      [22, "报销批次汇总记录（由客户端构造用于合并展示，不是单笔报销入账）"],
    ],
  );
  assert.equal(String(billType.description), "账单类型筛选");
  for (const branch of billType.anyOf as Array<{ const: number; description: string }>) {
    assert.equal(branch.description.startsWith(`${branch.const}`), false);
  }
  const bookItem = schemaNode(tools.find(({ name }) => name === "list_books")?.outputSchema, "results", "items");
  assert.equal(String(schemaNode(bookItem, "type").description), "钱迹动态下发的账本模板类型代码");
  const assetItem = schemaNode(tools.find(({ name }) => name === "list_assets")?.outputSchema, "results", "items", "children", "items");
  assert.equal((assetItem.required as string[]).includes("money"), false);
  assert.equal(schemaNode(assetItem, "currency").pattern, undefined);
  assert.equal(schemaNode(assetItem, "currency").minLength, 1);
  assert.match(String(schemaNode(assetItem, "currency").description), /资产币种标识.*原始值为空.*本位币/);
  assert.match(String(schemaNode(assetItem, "type").description), /5 债务记录.*6 债务汇总.*7 社会保障.*动态目录/);
  assert.match(String(schemaNode(assetItem, "subtype").description), /51 借入.*52 借出.*61 借入汇总.*62 借出汇总.*动态目录/);
  assert.deepEqual(
    (schemaNode(assetItem, "status").anyOf as Array<{ const: number; description: string }>).map(({ const: value, description }) => [value, description]),
    [[-1, "无状态"], [0, "正常"], [1, "债务或借贷已结束"], [2, "已隐藏"]],
  );
  assert.match(String(schemaNode(billOutput, "assetId").description), /主关联资产 ID.*收支、退款、报销入账和借贷资金账户.*null/);
  assert.match(String(schemaNode(billOutput, "fromId").description), /来源关联资产 ID.*转账、信用卡还款和部分借贷流水/);
  assert.match(String(schemaNode(billOutput, "targetId").description), /目标关联资产 ID.*转账、信用卡还款和部分借贷流水/);
  assert.match(String(schemaNode(billOutput, "refundProgress", "totalAmount").description), /累计退款金额.*源账单币种.*超额退款/);
  assert.match(String(schemaNode(billOutput, "refundProgress", "remainingAmount").description), /剩余可退款金额.*超额退款后为 0/);
  assert.match(String(schemaNode(billOutput, "reimbursementProgress", "remainingAmount").description), /扣除退款和报销.*超额报销后为 0/);
  const billSummary = schemaNode(tools.find(({ name }) => name === "list_bills")?.outputSchema, "results", "items");
  assert.match(String(schemaNode(billSummary, "fromId").description), /来源关联资产 ID.*上游未返回.*省略/);
  assert.match(String(schemaNode(billSummary, "targetId").description), /目标关联资产 ID.*上游未返回.*省略/);
  assert.equal(tools.find(({ name }) => name === "create_bills")?.description, "批量创建普通支出、收入或待报销支出账单");
  assert.equal(tools.find(({ name }) => name === "update_bills")?.description, "批量修改普通支出、收入或待报销支出账单");
  assert.equal(tools.find(({ name }) => name === "delete_bills")?.description, "批量永久删除普通收支、待报销支出、转账或信用卡还款账单");
  assert.equal(tools.find(({ name }) => name === "list_debt_accounts")?.description, "独立查询当前钱迹账号的借入或借出详情");
  const debtItem = schemaNode(tools.find(({ name }) => name === "list_debt_accounts")?.outputSchema, "results", "items");
  assert.equal((debtItem.required as string[]).includes("finishedAt"), false);
  assert.equal(schemaNode(debtItem, "principal").minimum, 0);
  assert.equal(schemaNode(debtItem, "balance").minimum, 0);
  assert.equal(schemaNode(debtItem, "totalPaid").minimum, 0);
  assert.match(String(schemaNode(debtItem, "endDate").description), /计划还款或收款日期.*status.*无直接关系/);
  assert.match(String(schemaNode(debtItem, "finishedAt").description), /实际结束时间.*Unix 秒.*仅 status=ended/);
  const statisticsTool = tools.find(({ name }) => name === "get_bill_statistics")!;
  assert.equal(
    statisticsTool.description,
    "聚合本地账单并返回固定统计结果，金额统计采用钱迹 APK 已确认的主报表规则，日均分母只计已经完整结束的日历日",
  );
  assert.match(
    String(schemaNode(statisticsTool.outputSchema, "statistics", "average", "periodCount").description),
    /unit=day.*完整结束的日历日.*不超过 365 天.*自定义范围.*startTime.*endTime 后一秒.*自然日零点.*86400 秒.*无账单.*当天不计入.*有账单.*0.*unit=month\/year.*有账单期间.*超过 365 天.*year/,
  );
  const statisticsSummary = schemaNode(statisticsTool.outputSchema, "statistics", "summary");
  assert.match(String(schemaNode(statisticsSummary, "pureIncome").description), /收入.*借出利息收入.*关联退款.*正数部分/);
  assert.match(String(schemaNode(statisticsSummary, "pureSpend").description), /支出.*借入利息支出.*关联退款.*正数部分/);
  assert.match(String(schemaNode(statisticsSummary, "reimbursementIncome").description), /已报销金额.*报销基数.*总收入/);
  assert.match(String(schemaNode(statisticsSummary, "refundSpend").description), /收入.*借出利息收入.*关联退款.*源金额.*总支出/);
  assert.match(String(schemaNode(statisticsTool.outputSchema, "statistics", "categoryBreakdown", "spend").description), /支出.*借入利息支出.*待报销支出.*不含手续费和退款支出/);
  assert.match(String(schemaNode(statisticsTool.outputSchema, "statistics", "categoryBreakdown").description), /totalSpend.*totalIncome.*比例合计小于 100%/);
  const budgetTool = tools.find(({ name }) => name === "get_budget")!;
  assert.equal(budgetTool.description, "查询账本指定月份或年份的预算使用情况");
  assert.equal(schemaNode(budgetTool.inputSchema, "includeDailyStatistics").default, false);
  assert.match(String(schemaNode(budgetTool.inputSchema, "period").description), /省略.*账本月份起始日.*当前月/);
  const budgetOutput = schemaNode(budgetTool.outputSchema, "budget");
  assert.match(String(schemaNode(budgetOutput, "configured").description), /false.*summary.*null.*categories.*空数组/);
  assert.match(String(schemaNode(budgetOutput, "categories", "items", "billCount").description), /零消耗.*不计预算.*仍计入/);
  assert.match(String(schemaNode(budgetOutput, "dailyStatistics").description), /includeDailyStatistics=true.*每个日历日/);
  const userSchema = schemaNode(tools.find(({ name }) => name === "get_user_info")?.outputSchema, "user");
  const userBranches = userSchema.oneOf as Record<string, unknown>[];
  assert.equal(userBranches.length, 2);
  const vipBranch = userBranches.find((branch) => schemaNode(branch, "isVip").const === true)!;
  const nonVipBranch = userBranches.find((branch) => schemaNode(branch, "isVip").const === false)!;
  assert.equal("dailyWriteLimit" in (vipBranch.properties as Record<string, unknown>), false);
  assert.equal("platform" in (vipBranch.properties as Record<string, unknown>), false);
  assert.equal("registrationMethod" in (vipBranch.properties as Record<string, unknown>), true);
  assert.deepEqual(schemaNode(vipBranch, "registrationMethod").enum, ["手机号", "微博", "QQ", "邮箱", "微信", "Apple ID", "华为账号"]);
  assert.equal(schemaNode(vipBranch, "registrationMethod").anyOf, undefined);
  assert.deepEqual(nonVipBranch.required, [
    "id", "name", "avatar", "registeredAt", "vipType", "vipStart", "vipEnd", "baseCurrency", "isVip",
    "dailyWriteLimit", "dailyWriteUsed", "dailyWriteRemaining", "dailyWriteResetsAt",
  ]);
  assert.deepEqual(
    schemaNode(tools.find(({ name }) => name === "update_bills")?.inputSchema, "updates", "items", "patch").required,
    [],
  );
  for (const name of ["update_transfer", "update_refund"]) {
    assert.deepEqual(schemaNode(tools.find(({ name: toolName }) => toolName === name)?.inputSchema, "patch").required, []);
  }
  const reimbursementTool = tools.find(({ name }) => name === "reimburse_bills")!;
  assert.deepEqual(reimbursementTool.inputSchema.required, ["sourceBillIds", "money"]);
  assert.match(String(schemaNode(reimbursementTool.inputSchema, "sourceBillIds").description), /内部.*APK.*分摊/);
  for (const [toolName, path] of [
    ["create_bills", ["bills", "items", "currencyConversion"]],
    ["update_bills", ["updates", "items", "patch", "currencyConversion"]],
    ["create_transfer", ["currencyConversion"]],
    ["update_transfer", ["patch", "currencyConversion"]],
    ["create_refund", ["currencyConversion"]],
    ["update_refund", ["patch", "currencyConversion"]],
    ["reimburse_bills", ["currencyConversion"]],
  ] as const) {
    assert.match(String(schemaNode(tools.find(({ name }) => name === toolName)?.inputSchema, ...path).description), /跨币种|换算/);
  }
  assert.equal(String(schemaNode(reimbursementTool.inputSchema, "currencyConversion").description), "整批跨币种报销的目标和本位币总金额");
  const confirmReimbursementUpgrade = schemaNode(reimbursementTool.inputSchema, "confirmReimbursementUpgrade");
  assert.equal(confirmReimbursementUpgrade.default, false);
  assert.equal(String(confirmReimbursementUpgrade.description), "是否允许在钱迹要求时迁移到新版报销");
  assert.equal(reimbursementTool.description, "按总金额报销所选待报销支出并返回钱迹生成的关联账单");
  for (const name of ["list_categories", "list_bills", "create_transfer"]) {
    assert.equal(schemaNode(tools.find(({ name: toolName }) => toolName === name)?.inputSchema, "bookId").default, "-1");
  }
  assert.equal(schemaNode(tools.find(({ name }) => name === "create_bills")?.inputSchema, "bills", "items", "bookId").default, "-1");
  for (const [toolName, side, path] of [
    ["list_categories", "inputSchema", ["bookId"]],
    ["list_bills", "inputSchema", ["bookId"]],
    ["list_bills", "inputSchema", ["categoryId"]],
    ["list_bills", "inputSchema", ["tagId"]],
    ["list_bills", "inputSchema", ["assetId"]],
    ["list_bills", "inputSchema", ["fromAssetId"]],
    ["list_bills", "inputSchema", ["targetAssetId"]],
    ["get_bill", "inputSchema", ["billId"]],
    ["create_bills", "inputSchema", ["bills", "items", "bookId"]],
    ["create_bills", "inputSchema", ["bills", "items", "categoryId"]],
    ["create_bills", "inputSchema", ["bills", "items", "tagIds", "items"]],
    ["update_bills", "inputSchema", ["updates", "items", "billId"]],
    ["update_bills", "inputSchema", ["updates", "items", "patch", "bookId"]],
    ["update_bills", "inputSchema", ["updates", "items", "patch", "categoryId"]],
    ["update_bills", "inputSchema", ["updates", "items", "patch", "tagIds", "items"]],
    ["delete_bills", "inputSchema", ["deletions", "items", "billId"]],
    ["create_transfer", "inputSchema", ["bookId"]],
    ["create_transfer", "inputSchema", ["fromAssetId"]],
    ["create_transfer", "inputSchema", ["targetAssetId"]],
    ["update_transfer", "inputSchema", ["billId"]],
    ["update_transfer", "inputSchema", ["patch", "fromAssetId"]],
    ["update_transfer", "inputSchema", ["patch", "targetAssetId"]],
    ["create_refund", "inputSchema", ["sourceBillId"]],
    ["update_refund", "inputSchema", ["refundBillId"]],
    ["delete_refund", "inputSchema", ["refundBillId"]],
    ["reimburse_bills", "inputSchema", ["sourceBillIds", "items"]],
    ["delete_reimbursement", "inputSchema", ["reimbursementBillId"]],
    ["cancel_reimbursements", "inputSchema", ["sourceBillIds", "items"]],
    ["list_book_members", "inputSchema", ["bookId"]],
    ["list_book_members", "outputSchema", ["results", "items", "userId"]],
    ["list_books", "outputSchema", ["results", "items", "bookId"]],
    ["list_assets", "outputSchema", ["results", "items", "name"]],
    ["list_assets", "outputSchema", ["results", "items", "children", "items", "id"]],
    ["list_categories", "outputSchema", ["results", "items", "id"]],
    ["list_categories", "outputSchema", ["results", "items", "parentId"]],
    ["list_categories", "outputSchema", ["results", "items", "children", "items", "id"]],
    ["list_categories", "outputSchema", ["results", "items", "children", "items", "parentId"]],
    ["list_tags", "outputSchema", ["results", "items", "groupId"]],
    ["list_tags", "outputSchema", ["results", "items", "children", "items", "id"]],
    ["list_bills", "outputSchema", ["results", "items", "id"]],
    ["list_bills", "outputSchema", ["results", "items", "bookId"]],
    ["list_bills", "outputSchema", ["results", "items", "fromId"]],
    ["list_bills", "outputSchema", ["results", "items", "targetId"]],
    ["list_bills", "outputSchema", ["results", "items", "tagIds", "items"]],
    ["get_bill", "outputSchema", ["bill", "id"]],
    ["get_bill", "outputSchema", ["bill", "bookId"]],
    ["get_bill", "outputSchema", ["bill", "fromId"]],
    ["get_bill", "outputSchema", ["bill", "targetId"]],
    ["get_bill", "outputSchema", ["bill", "tagIds", "items"]],
    ["delete_bills", "outputSchema", ["deleted", "items", "billId"]],
    ["delete_reimbursement", "outputSchema", ["reimbursementBillId"]],
  ] as const) {
    const tool = tools.find(({ name }) => name === toolName);
    const node = schemaNode(tool?.[side], ...path);
    assert.equal(node.type, "string", `${toolName}.${side}.${path.join(".")} must be a string`);
    assert.equal(node.anyOf, undefined, `${toolName}.${side}.${path.join(".")} must not accept numbers`);
  }
  const discoveredIdPattern = new RegExp(String(schemaNode(
    tools.find(({ name }) => name === "get_bill")?.inputSchema,
    "billId",
  ).pattern));
  assert.equal(discoveredIdPattern.test("9223372036854775807"), true);
  assert.equal(discoveredIdPattern.test("9223372036854775808"), false);
  for (const [toolName, side, path] of [
    ["create_bills", "inputSchema", ["bills", "items", "assetId"]],
    ["update_bills", "inputSchema", ["updates", "items", "patch", "assetId"]],
    ["create_refund", "inputSchema", ["assetId"]],
    ["update_refund", "inputSchema", ["patch", "assetId"]],
    ["reimburse_bills", "inputSchema", ["assetId"]],
    ["list_bills", "outputSchema", ["results", "items", "assetId"]],
    ["get_bill", "outputSchema", ["bill", "assetId"]],
  ] as const) {
    const node = schemaNode(tools.find(({ name }) => name === toolName)?.[side], ...path);
    assert.deepEqual((node.anyOf as Array<{ type: string }>).map(({ type }) => type).sort(), ["null", "string"]);
    assert.equal((node.anyOf as Array<{ type: string; pattern?: string }>).find(({ type }) => type === "string")?.pattern, POSITIVE_ID_PATTERN.source);
  }
  for (const [toolName, side, path] of [
    ["create_bills", "inputSchema", ["bills", "items", "discount"]],
    ["update_bills", "inputSchema", ["updates", "items", "patch", "discount"]],
    ["create_transfer", "inputSchema", ["fee"]],
    ["create_transfer", "inputSchema", ["discount"]],
    ["update_transfer", "inputSchema", ["patch", "fee"]],
    ["update_transfer", "inputSchema", ["patch", "discount"]],
    ["list_bills", "outputSchema", ["results", "items", "fee"]],
    ["list_bills", "outputSchema", ["results", "items", "discount"]],
    ["get_bill", "outputSchema", ["bill", "fee"]],
    ["get_bill", "outputSchema", ["bill", "discount"]],
  ] as const) {
    assert.equal(schemaNode(tools.find(({ name }) => name === toolName)?.[side], ...path).type, "number");
  }
  assert.equal("fee" in (schemaNode(tools.find(({ name }) => name === "create_bills")?.inputSchema, "bills", "items").properties as Record<string, unknown>), false);
  assert.equal("fee" in (schemaNode(tools.find(({ name }) => name === "update_bills")?.inputSchema, "updates", "items", "patch").properties as Record<string, unknown>), false);
  assert.equal(
    String(schemaNode(tools.find(({ name }) => name === "create_transfer")?.inputSchema, "creditRepayment").description),
    "是否将本次操作记为信用卡还款",
  );
  const updateTransferTool = tools.find(({ name }) => name === "update_transfer")!;
  assert.equal(updateTransferTool.description, "修改资产转账或信用卡还款账单");
  assert.equal(String(schemaNode(updateTransferTool.inputSchema, "patch", "targetAssetId").description), "新的转入资产 ID");
  assert.equal(String(schemaNode(updateTransferTool.inputSchema, "patch", "creditRepayment").description), "新的信用卡还款标记");
  for (const [toolName, path] of [
    ["create_transfer", ["money"]],
    ["update_transfer", ["patch", "money"]],
  ] as const) {
    const description = String(schemaNode(tools.find(({ name }) => name === toolName)?.inputSchema, ...path).description);
    assert.match(description, /APP 主金额输入框.*转账手续费场景转出 money.*转入 money - fee/);
  }
  const getBillOutput = tools.find(({ name }) => name === "get_bill")?.outputSchema as {
    properties: { bill: { properties: Record<string, { pattern?: string }> } };
  };
  for (const field of ["fromId", "targetId"]) {
    assert.equal(getBillOutput.properties.bill.properties[field]?.pattern, POSITIVE_ID_PATTERN.source);
  }
  for (const [toolName, path] of [
    ["list_bills", ["results", "items", "categoryId"]],
    ["get_bill", ["bill", "categoryId"]],
  ] as const) {
    const categoryId = schemaNode(tools.find(({ name }) => name === toolName)?.outputSchema, ...path);
    assert.deepEqual((categoryId.anyOf as Array<{ type: string }>).map(({ type }) => type).sort(), ["null", "string"]);
  }
  const refreshCacheTool = tools.find(({ name }) => name === "refresh_cache")!;
  assert.equal(refreshCacheTool.annotations?.readOnlyHint, false);
  assert.match(refreshCacheTool.description ?? "", /币种目录/);
  for (const field of ["fee", "discount"]) {
    assert.match(
      String(schemaNode(tools.find(({ name }) => name === "update_transfer")?.inputSchema, "patch", field).description),
      /传 0.*清除手续费和优惠.*传正值.*清除原/,
    );
  }
  for (const name of ["delete_bills", "delete_refund", "delete_reimbursement", "cancel_reimbursements", "disconnect_qianji"]) {
    const tool = tools.find(({ name: toolName }) => toolName === name);
    assert.equal(tool?.annotations?.destructiveHint, true);
    assert.doesNotMatch(tool?.description ?? "", /确认|调用前/);
  }
});

test("get_budget 通过 MCP 返回已校验的只读预算结构", async (t) => {
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/budget/list") return Response.json({ ec: 200, data: { list: [
        { bookid: 1, flag: 1, cateid: -1, money: 100 },
      ] } });
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const accountId = store.verifyPat(token)!.accountId!;
  const now = Date.now();
  store.setUserCache(accountId, { id: "uid-test", viptype: -1, __baseCurrency: "CNY" }, now);
  store.setCatalogCache(accountId, "books", "", [{ bookid: "1", name: "账本", visible: 1 }], now);
  store.setCatalogCache(accountId, "categories", "1", [{ id: "2", name: "餐饮", parentid: "-1" }], now);
  store.setSyncState(accountId, { cursor: 1 });
  const client = new Client(
    { name: "budget-tool-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({
    name: "get_budget",
    arguments: { bookId: "1", period: { kind: "year", year: 2026 } },
  });

  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(result.structuredContent, {
    budget: {
      period: {
        kind: "year",
        year: 2026,
        startTime: Math.floor(Date.UTC(2026, 0, 1, -8) / 1000),
        endTime: Math.floor(Date.UTC(2027, 0, 1, -8) / 1000) - 1,
        timezoneOffsetSeconds: 28_800,
      },
      currency: "CNY",
      configured: true,
      summary: {
        spendingScope: "allExpenses",
        limit: 100,
        used: 0,
        remaining: 100,
        excludedFromBudgetAmount: 0,
        dailyAverageBudget: 100 / 365,
      },
      categories: [],
    },
  });
});

test("普通 PAT 默认 legacy 可协商 2025-11-25", async (t) => {
  const { store, app, token } = setupApp();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  t.after(() => client.close());

  await client.connect(transport(app, token));
  assert.equal(client.getProtocolEra(), "legacy");
  assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
  assert.equal((await client.listTools()).tools.length, 25);
});

test("MCP 输入 schema 接受边界并在进入业务逻辑前拒绝越界字段", async (t) => {
  const { store, app, token } = setupApp();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "input-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const accountId = store.verifyPat(token)!.accountId!;
  store.setSyncState(accountId, { bills: "0" });
  for (const length of [41, 42]) {
    const result = await client.callTool({ name: "list_bills", arguments: { allBooks: true, remarkKeyword: "账".repeat(length) } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
  }
  for (const filters of [
    { allBooks: true, categoryId: "9223372036854775807" },
    { allBooks: true, assetId: "9223372036854775807" },
    { allBooks: true, tagId: "t".repeat(26) },
  ]) {
    const result = await client.callTool({ name: "list_bills", arguments: filters });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
  }

  for (const request of [
    { name: "list_books", arguments: { include_hidden: true } },
    { name: "list_books", arguments: { nameKeyword: "" } },
    { name: "list_books", arguments: { nameKeyword: "   " } },
    { name: "list_books", arguments: { nameKeyword: "账".repeat(43) } },
    { name: "list_assets", arguments: { nameKeyword: "" } },
    { name: "list_categories", arguments: { bookId: -1 } },
    { name: "get_budget", arguments: { period: { kind: "month", year: 2026, month: 13 } } },
    { name: "get_budget", arguments: { period: { kind: "year", year: 1969 } } },
    { name: "get_budget", arguments: { period: { kind: "year", year: 2026, month: 1 } } },
    { name: "list_bills", arguments: { bookId: -1, categoryId: -1 } },
    { name: "list_bills", arguments: { allBooks: true, assetId: "-1" } },
    { name: "get_bill", arguments: { billId: 1 } },
    { name: "create_bills", arguments: { bills: [{ bookId: "1", type: 2, money: 0, categoryId: "2" }] } },
    { name: "create_bills", arguments: { bills: [{ bookId: "1", type: 0, money: 1, categoryId: "2", assetId: 0 }] } },
    { name: "create_bills", arguments: { bills: [{ bookId: "1", type: 0, money: 1, categoryId: "2", assetId: "-1" }] } },
    { name: "create_bills", arguments: { bills: [{ bookId: "1", type: 0, money: 1, fee: 1, discount: 1, categoryId: "2" }] } },
    { name: "create_bills", arguments: { bills: [{ bookId: "1", type: 0, money: 1, discount: 2, categoryId: "2" }] } },
    { name: "create_bills", arguments: { bills: [{ bookId: "1", type: 0, money: 10_000_000_000, categoryId: "2" }] } },
    { name: "create_transfer", arguments: { money: 1, fromAssetId: "3", targetAssetId: "4", fee: 1, discount: 1 } },
    { name: "create_transfer", arguments: { money: 1, fromAssetId: "3", targetAssetId: "4", discount: 2 } },
    { name: "create_transfer", arguments: { money: 1, fromAssetId: "3", targetAssetId: "4", fee: 2 } },
    { name: "update_bills", arguments: { updates: [{ billId: "1770000000000123456", patch: { userId: "injected" } }] } },
    { name: "update_bills", arguments: { updates: [{ billId: "1770000000000123456", patch: { type: 1 } }] } },
    { name: "update_bills", arguments: { updates: [{ billId: "1770000000000123456", patch: { bookId: 0 } }] } },
    { name: "update_bills", arguments: { updates: [{ billId: "1770000000000123456", patch: { assetId: 0 } }] } },
    { name: "update_bills", arguments: { updates: [{ billId: "1770000000000123456", patch: { assetId: "-1" } }] } },
    { name: "update_bills", arguments: { updates: [{ billId: "1770000000000123456", patch: { fee: 1, discount: 1 } }] } },
    { name: "update_transfer", arguments: { billId: "1770000000000123456", patch: { bookId: 1 } } },
    { name: "create_refund", arguments: { sourceBillId: "1770000000000123456", money: 1, assetId: "-1" } },
    { name: "reimburse_bills", arguments: { allocations: [{ billId: "1770000000000123456", money: 1 }] } },
    { name: "delete_bills", arguments: { deletions: [{ billId: 1 }] } },
    { name: "list_bills", arguments: { startTime: 2, endTime: 1, limit: 101 } },
    { name: "list_bills", arguments: { createStartTime: 2, createEndTime: 1 } },
    { name: "list_bills", arguments: { remarkKeyword: "" } },
    { name: "list_bills", arguments: { remarkKeyword: "   " } },
    { name: "list_bills", arguments: { remarkKeyword: "账".repeat(43) } },
    { name: "list_categories", arguments: { bookId: "9223372036854775808" } },
    { name: "get_bill", arguments: { billId: "9223372036854775808" } },
    { name: "list_bills", arguments: { assetId: "9223372036854775808" } },
    { name: "create_bills", arguments: { bills: [{ type: 0, money: 1, categoryId: "2", tagIds: ["tag-1", "tag-1"] }] } },
    { name: "list_bills", arguments: { assetId: 0 } },
    { name: "refresh_cache", arguments: { scope: "books" } },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Input validation error/);
  }
});

test("get_user_info 只返回最小资料、缓存期 VIP 和额度字段", async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/client/init");
      return Response.json({ ec: 200, data: {
        userinfo: {
          id: "uid-test",
          name: "模型可见名称",
          avatar: "https://example.invalid/avatar.png",
          platform: 6,
          time: now - 100,
          viptype: 100,
          vipstart: now - 1,
          vipend: now + 60,
          email: "private@example.invalid",
          phone: "13800000000",
        },
        userconfigs: { basecur: "CNY", mcurrency: 1 },
        books: [{ bookid: -1, name: "默认账本" }],
      } });
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "user-info", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({ name: "get_user_info", arguments: {} });
  const user = (result.structuredContent as { user: Record<string, unknown> }).user;
  assert.deepEqual(user, {
    id: "uid-test",
    name: "模型可见名称",
    avatar: "https://example.invalid/avatar.png",
    registrationMethod: "邮箱",
    registeredAt: now - 100,
    vipType: "终身VIP",
    vipStart: now - 1,
    vipEnd: now + 60,
    baseCurrency: "CNY",
    isVip: true,
  });
  assert.equal("platform" in user, false);
  assert.equal("loginMethod" in user, false);
  assert.equal("email" in user, false);
  assert.equal("phone" in user, false);
});

test("get_user_info 将未开通 VIP 的官方时间哨兵返回为 null", async (t) => {
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/client/init");
      return Response.json({ ec: 200, data: {
        userinfo: { id: "uid-test", viptype: -1, vipstart: -1, vipend: -1 },
        userconfigs: {},
        books: [],
      } });
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "non-vip-info", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({ name: "get_user_info", arguments: {} });
  const user = (result.structuredContent as { user: Record<string, unknown> }).user;
  assert.equal(user.vipStart, null);
  assert.equal(user.vipEnd, null);
  assert.equal(user.baseCurrency, "CNY");
  assert.equal(user.isVip, false);
});

test("refresh_cache 立即刷新全部目录缓存并返回数量", async (t) => {
  const calls: Array<{ path: string; body: URLSearchParams }> = [];
  const { store, app, token } = setupApp({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = new URLSearchParams(String(init?.body));
      calls.push({ path, body });
      if (path === "/client/init") return Response.json({ ec: 200, data: {
        userinfo: { id: "uid-test", name: "测试用户", viptype: -1 },
        userconfigs: { basecur: "CNY", mcurrency: 1 },
        books: [{ bookid: 1, name: "日常" }, { bookid: 2, name: "旅行" }],
      } });
      if (path === "/syncv2/pull") return Response.json({ ec: 200, data: {
        changes: [],
        deletes: [],
        categories: [],
        bookid: -1,
        pageoffset: 0,
        hasmore: 0,
        pagesign: "",
        lasttimes: { cursor: 1 },
      } });
      if (path === "/book/list") return Response.json({ ec: 200, data: { list: [
        { bookid: 1, name: "日常", visible: 1 },
        { bookid: 2, name: "旅行", visible: 0 },
      ] } });
      if (path === "/asset/list") return Response.json({ ec: 200, data: { list: [
        { id: body.get("status") === "0" ? 3 : 4, name: "资产", groupid: -1 },
      ] } });
      if (path === "/tag/list") return Response.json({ ec: 200, data: { list: [
        { id: "", name: "默认组", tags: [{ id: "tag.alpha", name: "标签" }] },
      ] } });
      if (path === "/category/listv2") return Response.json({ ec: 200, data: { list: [
        {
          id: body.get("bookid") === "1" ? 6 : 7,
          name: "分类",
          parentid: -1,
          sublist: body.get("bookid") === "1" ? [{ id: 8, name: "子分类", parentid: 6 }] : [],
        },
      ] } });
      if (path === "/currency/listv2") return Response.json({ ec: 200, data: { list: [], hasmore: 0 } });
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  const accountId = store.verifyPat(token)!.accountId!;
  store.setSyncState(accountId, { cursor: 7 });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "refresh-cache", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({ name: "refresh_cache", arguments: {} });

  assert.deepEqual(result.structuredContent, {
    userRefreshed: true,
    bookCount: 2,
    visibleBookCount: 1,
    hiddenBookCount: 1,
    assetCount: 2,
    categoryCount: 3,
    tagCount: 1,
    billCount: 0,
  });
  assert.deepEqual(
    calls.map(({ path }) => path).sort(),
    [
      "/asset/list",
      "/asset/list",
      "/book/list",
      "/category/listv2",
      "/category/listv2",
      "/client/init",
      "/currency/listv2",
      "/syncv2/pull",
      "/tag/list",
    ].sort(),
  );
  assert.equal(calls.find(({ path }) => path === "/syncv2/pull")?.body.get("lasttimes"), '{"cursor":7}');
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM catalog_cache").get() as { count: bigint }).count, 6n);
});

test("64 位 bookId 在列表、分类和账单同步中精确往返", async (t) => {
  const bookId = "16435204029937364";
  const billId = "1770000000000123456";
  const upstreamBookIds: string[] = [];
  const { store, app, token } = setupApp({
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const form = new URLSearchParams(String(init?.body));
      if (path === "/book/list") {
        return new Response(
          `{"ec":200,"data":{"list":[{"bookid":${bookId},"name":"Large","visible":1,"type":7,"membercount":1}]}}`,
        );
      }
      if (path === "/category/listv2") {
        upstreamBookIds.push(String(form.get("bookid")));
        return Response.json({ ec: 200, data: { list: [] } });
      }
      if (path === "/syncv2/pull") {
        upstreamBookIds.push(String(form.get("bookid")));
        return new Response(
          `{"ec":200,"data":{"changes":[{"id":${billId},"userid":"uid-test","bookid":${bookId},"time":1770000000,"type":0,"money":1,"remark":"","status":2,"cateid":2,"assetid":-1,"createtime":1770000000,"updatetime":1770000000}],"deletes":[],"categories":[],"bookid":${bookId},"pageoffset":0,"hasmore":0,"count":1,"pagesign":"","lasttimes":{"cursor":1}}}`,
        );
      }
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "large-book-id", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const books = await client.callTool({ name: "list_books", arguments: { nameKeyword: "large" } });
  assert.equal((books.structuredContent as { results: Array<{ bookId: string }> }).results[0]?.bookId, bookId);
  const categories = await client.callTool({ name: "list_categories", arguments: { bookId, type: -1 } });
  assert.deepEqual(categories.structuredContent, { results: [] });
  const bills = await client.callTool({ name: "list_bills", arguments: { bookId } });
  assert.equal((bills.structuredContent as { results: Array<{ bookId: string }> }).results[0]?.bookId, bookId);
  assert.deepEqual(upstreamBookIds, [bookId, "-1"]);
});

test("账单金额按币种主单位原值输出，不按最小货币单位缩放", async (t) => {
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/book/list") {
        return Response.json({ ec: 200, data: { list: [{ bookid: -1, name: "默认账本", visible: 1, type: 0, membercount: 1 }] } });
      }
      assert.equal(path, "/syncv2/pull");
      return Response.json({
        ec: 200,
        data: {
          changes: [
            { id: "1770000000000123456", bookid: -1, time: 1_775_000_000, type: 20, money: 8100, cateid: -1, assetid: -1, createtime: 1_775_000_000 },
            { id: "1770000000000123457", bookid: -1, time: 1_775_000_001, type: 20, money: 6300, cateid: -1, assetid: -1, createtime: 1_775_000_001 },
          ],
          deletes: [], categories: [], bookid: -1, pageoffset: 0, hasmore: 0, count: 2, pagesign: "", lasttimes: { cursor: 1 },
        },
      });
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "refund-money-unit", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({ name: "list_bills", arguments: {} });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const bills = (result.structuredContent as { results: Array<{ money: number }> }).results;
  assert.deepEqual(bills.map(({ money }) => money), [6300, 8100]);
});

test("64 位资产和分类 ID 以及非数字 groupId 精确往返", async (t) => {
  const bookId = "16435204029937364";
  const categoryId = "16435204029937365";
  const childCategoryId = "16435204029937367";
  const assetId = "16435204029937366";
  const billId = "1770000000000123456";
  const tagId = "17700000000001234567890";
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/book/list") {
        return new Response(
          `{"ec":200,"data":{"list":[{"bookid":${bookId},"name":"Large","visible":1,"type":7,"membercount":1}]}}`,
        );
      }
      if (path === "/asset/list") {
        return new Response(
          `{"ec":200,"data":{"groups":[{"groupid":"legacy-group","name":"常用","sort":1}],"list":[{"id":${assetId},"name":"Asset","money":0,"currency":"CNY","type":1,"stype":0,"status":0,"incount":1,"groupid":"legacy-group"}]}}`,
        );
      }
      if (path === "/category/listv2") {
        return new Response(
          `{"ec":200,"data":{"list":[{"id":${categoryId},"name":"Category","type":0,"level":1,"parentid":-1,"sublist":[{"id":${childCategoryId},"name":"Child","type":0,"level":2,"parentid":${categoryId}}]}]}}`,
        );
      }
      if (path === "/tag/list") {
        return Response.json({ ec: 200, data: { list: [
          { id: "group.alpha", name: "项目", tags: [{ id: "tag.alpha", name: "Alpha", status: 1 }] },
        ] } });
      }
      if (path === "/syncv2/pull") {
        return new Response(
          `{"ec":200,"data":{"changes":[{"id":${billId},"userid":"uid-test","bookid":${bookId},"time":1770000000,"type":0,"money":1,"remark":"","status":2,"cateid":${categoryId},"assetid":${assetId},"fromid":-1,"targetid":${assetId},"createtime":1770000000,"updatetime":1770000000,"extra":{"tags":[${tagId}]}}],"deletes":[],"categories":[],"bookid":${bookId},"pageoffset":0,"hasmore":0,"count":1,"pagesign":"","lasttimes":{"cursor":1}}}`,
        );
      }
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "large-reference-ids", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const assets = await client.callTool({ name: "list_assets", arguments: {} });
  assert.deepEqual(assets.structuredContent, {
    results: [{
      name: "常用",
      children: [{
        id: assetId,
        name: "Asset",
        currency: "CNY",
        type: 1,
        subtype: 0,
        status: 0,
        inCount: 1,
      }],
    }],
  });
  const assetsWithBalances = await client.callTool({ name: "list_assets", arguments: { includeBalances: true } });
  assert.equal((assetsWithBalances.structuredContent as { results: Array<{ children: Array<{ money?: number }> }> }).results[0]!.children[0]!.money, 0);
  const categories = await client.callTool({
    name: "list_categories",
    arguments: { bookId, type: -1 },
  });
  assert.deepEqual(categories.structuredContent, {
    results: [{
      id: categoryId,
      name: "Category",
      type: 0,
      level: 1,
      parentId: "-1",
      children: [{ id: childCategoryId, name: "Child", type: 0, level: 2, parentId: categoryId }],
    }],
  });
  const tags = await client.callTool({ name: "list_tags", arguments: {} });
  assert.deepEqual(tags.structuredContent, {
    results: [{
      groupId: "group.alpha",
      name: "项目",
      children: [{ id: "tag.alpha", name: "Alpha", status: 1 }],
    }],
  });
  const bills = await client.callTool({
    name: "list_bills",
    arguments: { bookId, categoryId },
  });
  assert.equal((bills.structuredContent as { results: Array<{ categoryId: string; assetId: string }> }).results[0]?.categoryId, categoryId);
  assert.equal((bills.structuredContent as { results: Array<{ categoryId: string; assetId: string }> }).results[0]?.assetId, assetId);
  assert.deepEqual((bills.structuredContent as { results: Array<{ tagIds: string[] }> }).results[0]?.tagIds, [tagId]);
  const bill = await client.callTool({ name: "get_bill", arguments: { billId } });
  const billContent = (bill.structuredContent as { bill: { fromId?: string; targetId: string } }).bill;
  assert.equal("fromId" in billContent, false);
  assert.equal(billContent.targetId, assetId);
  assert.deepEqual((bill.structuredContent as { bill: { tagIds: string[] } }).bill.tagIds, [tagId]);
});

test("旧缓存中的数字引用 ID 按新契约输出字符串", async (t) => {
  const billId = "1770000000000123456";
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/syncv2/pull") {
        return Response.json({
          ec: 200,
          data: {
            changes: [],
            deletes: [],
            categories: [],
            bookid: 1,
            pageoffset: 0,
            hasmore: 0,
            count: 0,
            pagesign: "",
            lasttimes: { cursor: 1 },
          },
        });
      }
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const accountId = store.verifyPat(token)!.accountId!;
  store.upsertBill(accountId, {
    id: billId,
    userid: "uid-test",
    bookid: 1,
    time: 1_770_000_000,
    type: 0,
    money: 1,
    remark: "",
    status: 2,
    cateid: 2,
    assetid: -1,
    fromid: -1,
    targetid: -1,
    extra: { tags: [123] },
    createtime: 1_770_000_000,
    updatetime: 1_770_000_000,
  });
  const client = new Client(
    { name: "legacy-reference-id-cache", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({ name: "get_bill", arguments: { billId } });
  const returnedBill = (result.structuredContent as { bill: Record<string, unknown> }).bill;
  assert.equal(returnedBill.categoryId, "2");
  assert.equal(returnedBill.assetId, null);
  assert.equal("fromId" in returnedBill, false);
  assert.equal("targetId" in returnedBill, false);
  assert.deepEqual(
    (result.structuredContent as { bill: { tagIds: string[] } }).bill.tagIds,
    ["123"],
  );
});

test("get_bill 兼容上游省略 remark、assetId 和 updateTime", async (t) => {
  const billId = "1770000000000123456";
  const { store, app, token } = setupApp({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/syncv2/pull") {
        return Response.json({
          ec: 200,
          data: {
            changes: [{
              id: billId,
              userid: "uid-test",
              bookid: 1,
              time: 1_770_000_000,
              type: 0,
              money: 1,
              status: 2,
              cateid: 2,
              createtime: 1_770_000_000,
            }],
            deletes: [],
            categories: [],
            bookid: -1,
            pageoffset: 0,
            hasmore: 0,
            count: 1,
            pagesign: "",
            lasttimes: { cursor: 1 },
          },
        });
      }
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "sparse-upstream-bill", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport(app, token));

  const result = await client.callTool({ name: "get_bill", arguments: { billId } });

  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const returned = (result.structuredContent as { bill: Record<string, unknown> }).bill;
  assert.equal(returned.remark, "");
  assert.equal(returned.assetId, null);
  assert.equal("updateTime" in returned, false);
});

test("超级管理员 PAT 取得 25 个业务工具和 3 个 PAT 管理工具", async (t) => {
  const { store, app, token } = setupApp({
    role: "admin",
    bound: true,
    fetch: async () => Response.json({ ec: 200, data: { list: [] } }),
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const client = new Client(
    { name: "admin-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  const cacheHeaders: Array<string | null> = [];
  await client.connect(transport(app, token, (response) => cacheHeaders.push(response.headers.get("cache-control"))));

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [...BUSINESS_TOOLS, "create_pat", "delete_pat", "list_pats"].sort(),
  );
  for (const tool of tools) {
    assertShortDisplayPunctuation(tool.description ?? "", `${tool.name}.description`);
    assertDescriptionPunctuation(tool.inputSchema, `${tool.name}.inputSchema`);
    assertDescriptionPunctuation(tool.outputSchema, `${tool.name}.outputSchema`);
    assertCamelCaseProperties(tool.inputSchema);
    assertCamelCaseProperties(tool.outputSchema);
    assertPropertyDescriptions(tool.inputSchema);
    assertPropertyDescriptions(tool.outputSchema);
    assertChoiceDescriptions(tool.inputSchema, `${tool.name}.inputSchema`);
    assertChoiceDescriptions(tool.outputSchema, `${tool.name}.outputSchema`);
  }
  const createPatTool = tools.find(({ name }) => name === "create_pat")!;
  const deletePatTool = tools.find(({ name }) => name === "delete_pat")!;
  const createPatProperties = createPatTool.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(tools.find(({ name }) => name === "list_pats")?.inputSchema.required, []);
  assert.equal(schemaNode(tools.find(({ name }) => name === "list_pats")?.outputSchema, "results", "items", "id").type, "integer");
  assert.equal("scopes" in createPatProperties, false);
  const createPatAccountId = schemaNode(createPatTool.inputSchema, "accountId");
  const createPatExpiresAt = schemaNode(createPatTool.inputSchema, "expiresAt");
  assert.equal(String(createPatAccountId.description), "要关联的已有钱迹账号内部标识，null 表示暂不绑定");
  for (const field of [createPatAccountId, createPatExpiresAt]) {
    assert.deepEqual((field.anyOf as Array<{ type: string }>).map(({ type }) => type).sort(), ["integer", "null"]);
    assert.equal("nullable" in field, false);
  }
  assert.equal(createPatTool.description, "创建可选关联已有钱迹账号的普通用户 PAT");
  assert.equal(String(schemaNode(createPatTool.outputSchema, "pat", "token").description), "新创建且仅本次返回的完整明文 PAT");
  assert.equal(String(schemaNode(createPatTool.outputSchema, "message").description), "新 PAT 的用户交付模板");
  assert.equal(deletePatTool.annotations?.destructiveHint, true);
  assert.equal(deletePatTool.description, "永久删除普通用户 PAT，并在关联账号不再被其他 PAT 使用时删除其本地数据");
  const booksResult = await client.callTool({ name: "list_books", arguments: {} });
  assert.deepEqual(booksResult.structuredContent, { results: [] });
  const createdResult = await client.callTool({
    name: "create_pat",
    arguments: { remark: "张三的电脑" },
  });
  assert.equal(createdResult.isError, undefined);
  const created = createdResult.structuredContent as {
    pat: { id: number; token: string; remark: string };
    message: string;
  };
  assert.match(created.pat.token, /^mt_pat_[0-9a-f]{64}$/);
  assert.equal(created.pat.remark, "张三的电脑");
  assert.equal(
    created.message,
    "请将 pat.token 原样填入下方模板的代码块后，只向用户返回填入后的内容，不要省略、改写、重排或补充说明，不要输出本段提示\n\n钱迹 PAT 已生成，请立即保存，完整 PAT 仅显示一次\n\n```\n{pat.token}\n```",
  );
  assert.equal(created.message.includes(created.pat.token), false);
  assert.deepEqual(
    JSON.parse(createdResult.content[0]?.type === "text" ? createdResult.content[0].text : "null"),
    created,
  );

  const listedResult = await client.callTool({ name: "list_pats", arguments: {} });
  const listed = listedResult.structuredContent as { results: Array<Record<string, unknown>> };
  assert.equal(listed.results.some(({ id }) => id === created.pat.id), true);
  assert.equal(listed.results.every((pat) => !("token" in pat)), true);
  assert.equal(cacheHeaders.every((value) => value === "no-store"), true);

  const deletedResult = await client.callTool({ name: "delete_pat", arguments: { id: created.pat.id } });
  assert.deepEqual(deletedResult.structuredContent, { deleted: true, id: created.pat.id, accountDataDeleted: false });
  assert.equal(store.verifyPat(created.pat.token), undefined);

  const lastPat = store.createPat("最后关联账号", null);
  store.bindPat(lastPat.id, "delete-pat-account", "delete-pat-token", "delete-pat-device");
  const lastAccountId = store.verifyPat(lastPat.token)!.accountId!;
  const lastDeletedResult = await client.callTool({ name: "delete_pat", arguments: { id: lastPat.id } });
  assert.deepEqual(lastDeletedResult.structuredContent, {
    deleted: true,
    id: lastPat.id,
    accountDataDeleted: true,
  });
  assert.throws(() => store.requireAccount(lastAccountId));
});

test("未认证请求返回 PAT 错误且不提供认证元数据", async (t) => {
  const { store, app } = setupApp();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const unauthenticated = await app.fetch(httpRequest("http://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await unauthenticated.json(), {
    error: { code: "MCP_UNAUTHENTICATED", message: "PAT 无效或已过期" },
  });

  const metadata = await app.fetch(httpRequest("http://test.local/.well-known/oauth-protected-resource/mcp"));
  assert.equal(metadata.status, 404);
});

test("绑定页 GET 和未知路径不做 Host 与 Origin 白名单限制", async (t) => {
  const { store, app } = setupApp();
  t.after(async () => {
    await app.close();
    store.close();
  });

  const page = await app.fetch(httpRequest("http://arbitrary.internal/connect"));
  assert.equal(page.status, 200);
  const unknown = await app.fetch(httpRequest("http://arbitrary.internal/not-found", {
    headers: { origin: "https://arbitrary-origin.example" },
  }));
  assert.equal(unknown.status, 404);
});

test("连接页只显示账号密码，隐藏一次性凭证并显著反馈成功或失败", async (t) => {
  const { store, app, token, bindingTickets } = setupApp();
  t.after(async () => {
    await app.close();
    store.close();
  });
  const { token: ticket } = bindingTickets.issue(store.verifyPat(token)!.id);
  const page = await app.fetch(httpRequest(`http://test.local/connect?ticket=${ticket}`));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /placeholder="邮箱或手机号"/);
  assert.match(pageHtml, /<form id="binding" hidden>/);
  assert.match(pageHtml, /const initialState=\{"status":"valid","mode":"initial","expiresAtMs":\d+,"remainingMs":\d+\}/);
  assert.match(pageHtml, /登录后即可在原对话中查询和管理钱迹数据/);
  assert.match(pageHtml, />登录并连接</);
  assert.match(pageHtml, /登录账号用于后续重新登录，密码和密码摘要不会保存/);
  assert.match(pageHtml, /<dialog id="success-dialog"/);
  assert.match(pageHtml, /aria-live="polite"/);
  assert.match(pageHtml, /body\{min-height:100vh;min-height:100dvh/);
  assert.match(pageHtml, /@media \(max-width:28rem\) and \(max-height:48rem\)\{body\{padding-block:\.75rem\}/);
  assert.match(pageHtml, /input\{min-height:3rem/);
  assert.match(pageHtml, /button\{min-height:3\.1rem/);
  assert.doesNotMatch(pageHtml, /body\{place-items:start center\}/);
  assert.doesNotMatch(pageHtml, /body\{[^}]*overflow:hidden/);
  assert.doesNotMatch(pageHtml, /id="token"|>PAT</);
  assert.doesNotMatch(pageHtml, /<script[^>]+src=|<link[^>]+href=/);
  assert.equal(pageHtml.includes(ticket), false);
  assert.equal(pageHtml.includes(token), false);

  type EventHandler = (event: { preventDefault(): void }) => Promise<void> | void;
  let submitHandler: EventHandler | undefined;
  let submittedBody = "";
  let submittedAuthorization = "";
  let responseOk = false;
  let replacedUrl = "";
  let dialogShown = 0;
  const loginInput = { value: "browser-user", disabled: false, focus() {}, select() {} };
  const passwordInput = { value: "正确密码🔐", disabled: false, focus() {}, select() {} };
  const submitLabel = { textContent: "登录并连接" };
  const submitButton = {
    disabled: false,
    querySelector: () => submitLabel,
    setAttribute() {},
    removeAttribute() {},
  };
  const form = {
    hidden: true,
    addEventListener: (_type: string, handler: EventHandler) => { submitHandler = handler; },
  };
  const resultOutput = { textContent: "", dataset: {} as Record<string, string>, setAttribute() {} };
  const linkNote = { textContent: "", hidden: true };
  const successDialog = {
    dataset: {} as Record<string, string>,
    open: false,
    addEventListener() {},
    showModal: () => { dialogShown += 1; successDialog.open = true; },
    setAttribute() {},
    removeAttribute() {},
    close() {},
  };
  const closeButton = { addEventListener() {}, focus() {} };
  const dialogTitle = { textContent: "" };
  const dialogMessage = { textContent: "" };
  const successFallback = { hidden: true, focus() {} };
  const elements: Record<string, unknown> = {
    "#binding": form,
    "#login": loginInput,
    "#password": passwordInput,
    "#submit": submitButton,
    "#result": resultOutput,
    "#link-note": linkNote,
    "#success-dialog": successDialog,
    "#success-title": dialogTitle,
    "#success-message": dialogMessage,
    "#close-page": closeButton,
    "#success-fallback": successFallback,
  };
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(pageHtml)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    TextEncoder,
    URLSearchParams,
    location: { pathname: "/connect", search: `?ticket=${ticket}` },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { replacedUrl = url; } },
    document: { hidden: false, querySelector: (selector: string) => elements[selector] },
    window: { close() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (_url: string, init: { body?: unknown; headers?: Record<string, string> }) => {
      submittedBody = String(init.body);
      submittedAuthorization = init.headers?.authorization ?? "";
      return {
        ok: responseOk,
        json: async () => responseOk ? { bound: true } : { error: { code: "TEST_ERROR", message: "测试失败" } },
      };
    },
  });
  assert.equal(replacedUrl, "/connect");
  assert.match(linkNote.textContent, /^链接有效至 .+/);
  assert.equal(linkNote.hidden, false);
  assert.equal(form.hidden, false);
  assert.ok(submitHandler);
  await submitHandler({ preventDefault() {} });
  assert.equal(submittedAuthorization, `Bearer ${ticket}`);
  assert.deepEqual(JSON.parse(submittedBody), { login: "browser-user", password: md5("正确密码🔐") });
  assert.equal(submittedBody.includes("正确密码🔐"), false);
  assert.equal(resultOutput.textContent, "连接失败，测试失败");
  assert.equal(loginInput.value, "browser-user");
  assert.equal(passwordInput.value, "正确密码🔐");
  assert.equal(dialogShown, 0);

  responseOk = true;
  await submitHandler({ preventDefault() {} });
  assert.equal(passwordInput.value, "");
  assert.equal(form.hidden, true);
  assert.equal(dialogShown, 1);
  assert.equal(dialogTitle.textContent, "连接成功");
  assert.equal(dialogMessage.textContent, "账单正在同步，请稍后返回原对话使用账单功能");

  await bindingTickets.redeem(httpRequest("http://test.local/connect", {
    headers: { authorization: `Bearer ${ticket}` },
  }), async () => undefined);
  const reopened = await app.fetch(httpRequest(`http://test.local/connect?ticket=${ticket}`));
  const reopenedHtml = await reopened.text();
  assert.match(reopenedHtml, /const initialState=\{"status":"invalid"\}/);
  assert.equal(reopenedHtml.includes(ticket), false);
  const reopenedScript = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(reopenedHtml)?.[1];
  assert.ok(reopenedScript);

  let invalidCloseHandler: (() => void) | undefined;
  let invalidDialogShown = 0;
  let windowCloseCount = 0;
  let historyBackCount = 0;
  const invalidForm = { hidden: false, addEventListener() {} };
  const invalidLogin = { value: "", disabled: false, focus() {}, select() {} };
  const invalidPassword = { value: "", disabled: false, focus() {}, select() {} };
  const invalidSubmitLabel = { textContent: "登录并连接" };
  const invalidSubmit = { disabled: false, querySelector: () => invalidSubmitLabel, setAttribute() {}, removeAttribute() {} };
  const invalidResult = { textContent: "", dataset: {} as Record<string, string>, setAttribute() {} };
  const invalidDialog = {
    dataset: {} as Record<string, string>,
    open: false,
    addEventListener() {},
    showModal: () => { invalidDialogShown += 1; invalidDialog.open = true; },
    setAttribute() {},
    removeAttribute() {},
    close: () => { invalidDialog.open = false; },
  };
  const invalidTitle = { textContent: "" };
  const invalidMessage = { textContent: "" };
  const invalidClose = {
    textContent: "",
    focus() {},
    addEventListener: (type: string, handler: () => void) => { if (type === "click") invalidCloseHandler = handler; },
  };
  const invalidFallback = { textContent: "", hidden: true, focus() {} };
  const invalidElements: Record<string, unknown> = {
    "#binding": invalidForm,
    "#login": invalidLogin,
    "#password": invalidPassword,
    "#submit": invalidSubmit,
    "#result": invalidResult,
    "#link-note": { textContent: "", hidden: true },
    "#success-dialog": invalidDialog,
    "#success-title": invalidTitle,
    "#success-message": invalidMessage,
    "#close-page": invalidClose,
    "#success-fallback": invalidFallback,
  };
  runInNewContext(reopenedScript, {
    TextEncoder,
    URLSearchParams,
    location: { pathname: "/connect", search: `?ticket=${ticket}` },
    history: { length: 2, replaceState() {}, back: () => { historyBackCount += 1; } },
    document: { hidden: false, querySelector: (selector: string) => invalidElements[selector] },
    window: { close: () => { windowCloseCount += 1; } },
    setTimeout: (handler: () => void) => { handler(); return 1; },
    clearTimeout() {},
    fetch: async () => { throw new Error("invalid page must not submit"); },
  });
  assert.equal(invalidForm.hidden, true);
  assert.equal(invalidLogin.disabled, true);
  assert.equal(invalidPassword.disabled, true);
  assert.equal(invalidDialogShown, 1);
  assert.equal(invalidTitle.textContent, "链接已失效");
  assert.equal(invalidMessage.textContent, "请返回原对话重新获取链接");
  assert.equal(invalidClose.textContent, "关闭页面");
  assert.ok(invalidCloseHandler);
  invalidCloseHandler();
  assert.equal(windowCloseCount, 1);
  assert.equal(historyBackCount, 1);
  assert.equal(invalidFallback.hidden, false);
  assert.equal(invalidFallback.textContent, "浏览器未能自动关闭，请手动关闭本页并返回原对话重新获取链接");
});

test("绑定 POST 校验公开来源，兼容代理和无来源头客户端且拒绝请求不消耗票据", async (t) => {
  let loginCalls = 0;
  const { store, app, token, bindingTickets } = setupApp({
    bound: false,
    fetch: async () => {
      loginCalls += 1;
      return Response.json({ ec: 400, em: "账号密码不匹配" });
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const { token: ticket } = bindingTickets.issue(store.verifyPat(token)!.id);
  const cases: Array<{ headers: Record<string, string>; allowed: boolean }> = [
    { headers: { origin: "https://evil.example" }, allowed: false },
    { headers: { origin: "null" }, allowed: false },
    { headers: { origin: "" }, allowed: false },
    { headers: { origin: "http://test.local.evil.example" }, allowed: false },
    { headers: { origin: "https://test.local" }, allowed: false },
    { headers: { origin: "http://test.local:3000" }, allowed: false },
    { headers: { origin: "http://test.local/path" }, allowed: false },
    { headers: { origin: "http://internal:3000" }, allowed: false },
    { headers: { origin: "https://evil.example", referer: "http://test.local/connect" }, allowed: false },
    { headers: { referer: "https://evil.example/connect" }, allowed: false },
    { headers: { referer: "invalid" }, allowed: false },
    { headers: { referer: "" }, allowed: false },
    { headers: { origin: "http://test.local", "sec-fetch-site": "cross-site" }, allowed: false },
    { headers: { "sec-fetch-site": "same-site" }, allowed: false },
    { headers: { origin: "http://test.local" }, allowed: true },
    { headers: { origin: "http://test.local", "sec-fetch-site": "same-origin" }, allowed: true },
    { headers: { referer: "http://test.local/connect?ignored=1" }, allowed: true },
    { headers: { "sec-fetch-site": "same-origin" }, allowed: true },
    { headers: { "sec-fetch-site": "none" }, allowed: true },
    { headers: {}, allowed: true },
  ];
  for (const { headers, allowed } of cases) {
    const before = loginCalls;
    const response = await app.fetch(httpRequest("http://internal:3000/connect", {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ login: "test@example.com", password: md5("test-password") }),
    }));
    const label = JSON.stringify(headers);
    assert.equal(response.status, allowed ? 401 : 403, label);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      allowed ? "QIANJI_LOGIN_REJECTED" : "INVALID_ORIGIN", label);
    assert.equal(loginCalls, before + Number(allowed), label);
    assert.ok(bindingTickets.inspect(ticket), label);
  }
});

test("一次性绑定链接拒绝长期 PAT、跨站、过期和成功后的全部复用", async (t) => {
  let now = 1_000;
  const { store, app, token, bindingTickets } = setupApp({
    bound: false,
    bindingNow: () => now,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") return Response.json({ ec: 200, data: { user: { id: "bound-uid" }, token: "bound-utoken" } });
      const response = connectionInitializationResponse(path, "bound-uid");
      if (response) return response;
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const patId = store.verifyPat(token)!.id;
  const { token: ticket } = bindingTickets.issue(patId);
  const { token: siblingTicket } = bindingTickets.issue(patId);
  const body = JSON.stringify({ login: "x", password: md5("y") });

  const invalidPassword = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ login: "x", password: "y" }),
  }));
  assert.equal(invalidPassword.status, 400);
  const directPat = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  }));
  assert.equal(directPat.status, 401);
  const crossSite = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ticket}`,
      "content-type": "application/json",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    body,
  }));
  assert.equal(crossSite.status, 403);

  const bound = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body,
  }));
  assert.equal(bound.status, 200);
  assert.equal(store.verifyPat(token)?.uid, "bound-uid");
  for (const used of [ticket, siblingTicket]) {
    const reopened = await app.fetch(httpRequest(`http://test.local/connect?ticket=${used}`));
    assert.match(await reopened.text(), /const initialState=\{"status":"invalid"\}/);
    const replay = await app.fetch(httpRequest("http://test.local/connect", {
      method: "POST",
      headers: { authorization: `Bearer ${used}`, "content-type": "application/json" },
      body,
    }));
    assert.equal(replay.status, 401);
  }

  const { token: expiredTicket } = bindingTickets.issue(patId);
  now += 10 * 60 * 1000;
  const expiredPage = await app.fetch(httpRequest(`http://test.local/connect?ticket=${expiredTicket}`));
  assert.match(await expiredPage.text(), /const initialState=\{"status":"invalid"\}/);
  const expired = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${expiredTicket}`, "content-type": "application/json" },
    body,
  }));
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), {
    error: { code: "BINDING_LINK_INVALID", message: "连接链接无效或已过期，请返回原对话重新获取" },
  });
  assert.equal((await app.fetch(httpRequest("http://test.local/bind"))).status, 404);
});

test("绑定返回后账单工具在后台同步完成前立即提示稍后重试", async (t) => {
  let releasePull = (): void => {};
  let markPullStarted!: () => void;
  const pullStarted = new Promise<void>((resolve) => { markPullStarted = resolve; });
  const pendingPull = new Promise<Response>((resolve) => {
    releasePull = () => resolve(connectionInitializationResponse("/syncv2/pull", "syncing-uid")!);
  });
  const { store, app, service, token, bindingTickets } = setupApp({
    bound: false,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") return Response.json({ ec: 200, data: { user: { id: "syncing-uid" }, token: "syncing-token" } });
      if (path === "/client/init") return connectionInitializationResponse(path, "syncing-uid")!;
      if (path === "/syncv2/pull") {
        markPullStarted();
        return pendingPull;
      }
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  const client = new Client({ name: "initial-sync-gate", version: "1.0.0" });
  t.after(async () => {
    releasePull();
    await client.close();
    await app.close();
    store.close();
  });

  const ticket = bindingTickets.issue(store.verifyPat(token)!.id).token;
  const bound = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ login: "x", password: md5("y") }),
  }));
  assert.equal(bound.status, 200);
  await pullStarted;
  await client.connect(transport(app, token));

  const syncing = await client.callTool({ name: "list_bills", arguments: { allBooks: true } });
  assert.equal(syncing.isError, true);
  assert.deepEqual(
    JSON.parse(syncing.content[0]?.type === "text" ? syncing.content[0].text : "null"),
    { error: { code: "QIANJI_DATA_SYNCING", message: "钱迹账单正在同步，请稍后再试" } },
  );

  releasePull();
  await service.close();
  const ready = await client.callTool({ name: "list_bills", arguments: { allBooks: true } });
  assert.equal(ready.isError, undefined, JSON.stringify(ready.content));
});

test("钱迹登录失败保留一次性链接供有效期内重试", async (t) => {
  let calls = 0;
  const { store, app, token, bindingTickets } = setupApp({
    bound: false,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") {
        calls += 1;
        return calls === 1
          ? Response.json({ ec: 8888, em: '{"msg":"登录失败！账号和密码不匹配-1"}', data: {} })
          : Response.json({ ec: 200, data: { user: { id: "retry-uid" }, token: "retry-utoken" } });
      }
      const response = connectionInitializationResponse(path, "retry-uid");
      if (response) return response;
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const { token: ticket } = bindingTickets.issue(store.verifyPat(token)!.id);
  const passwordMd5 = md5("distinct-password");
  const request = () => app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ login: "distinct-login", password: passwordMd5 }),
  }));

  const rejected = await request();
  const rejectedBody = await rejected.json() as { error: { code: string; message: string } };
  assert.equal(rejected.status, 401);
  assert.deepEqual(rejectedBody.error, {
    code: "QIANJI_LOGIN_REJECTED",
    message: "钱迹登录失败：账号和密码不匹配",
  });
  assert.equal(JSON.stringify(rejectedBody).includes("distinct-login"), false);
  assert.equal(JSON.stringify(rejectedBody).includes(passwordMd5), false);
  assert.equal((await request()).status, 200);
  assert.equal(store.verifyPat(token)?.uid, "retry-uid");
});

test("重复登录只显示脱敏账号、只提交密码并拒绝切换钱迹 UID", async (t) => {
  let loginCalls = 0;
  let returnedUid = "relogin-uid";
  const loginForms: URLSearchParams[] = [];
  const loginDeviceIds: string[] = [];
  const { store, app, service, token, bindingTickets } = setupApp({
    bound: false,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") {
        loginCalls += 1;
        loginForms.push(new URLSearchParams(String(init?.body)));
        loginDeviceIds.push(new Headers(init?.headers).get("devid") ?? "");
        return Response.json({ ec: 200, data: { user: { id: returnedUid }, token: `token-${loginCalls}` } });
      }
      const response = connectionInitializationResponse(path, returnedUid);
      if (response) return response;
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const patId = store.verifyPat(token)!.id;
  const login = "person@example.com";
  const firstTicket = bindingTickets.issue(patId).token;
  const first = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${firstTicket}`, "content-type": "application/json" },
    body: JSON.stringify({ login, password: md5("first") }),
  }));
  assert.equal(first.status, 200);
  assert.equal(store.getPatConnection(patId)?.loginIdentifier, login);

  const reloginTicket = bindingTickets.issue(patId).token;
  const page = await app.fetch(httpRequest(`http://test.local/connect?ticket=${reloginTicket}`));
  const html = await page.text();
  assert.match(html, /const initialState=\{"status":"valid","mode":"relogin","expiresAtMs":\d+,"remainingMs":\d+,"maskedLogin":"p\*\*\*@example.com"\}/);
  assert.match(html, />当前账号</);
  assert.match(html, /lead\.hidden=true/);
  assert.doesNotMatch(html, /账号已锁定/);
  assert.equal(html.includes(login), false);
  const relogin = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${reloginTicket}`, "content-type": "application/json" },
    body: JSON.stringify({ password: md5("second") }),
  }));
  assert.equal(relogin.status, 200);
  assert.equal(loginForms[1]?.get("v"), login);
  assert.equal(loginDeviceIds[1], loginDeviceIds[0]);
  await service.close();

  const lockedTicket = bindingTickets.issue(patId).token;
  const switchedLogin = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${lockedTicket}`, "content-type": "application/json" },
    body: JSON.stringify({ login: "other@example.com", password: md5("third") }),
  }));
  assert.equal(switchedLogin.status, 400);
  assert.equal((await switchedLogin.json() as { error: { code: string } }).error.code, "QIANJI_LOGIN_ACCOUNT_LOCKED");
  assert.equal(loginCalls, 2);

  returnedUid = "different-uid";
  const switchedUid = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${lockedTicket}`, "content-type": "application/json" },
    body: JSON.stringify({ password: md5("fourth") }),
  }));
  assert.equal(switchedUid.status, 400);
  assert.equal((await switchedUid.json() as { error: { code: string } }).error.code, "QIANJI_ACCOUNT_MISMATCH");
  assert.equal(store.verifyPat(token)?.uid, "relogin-uid");
  assert.match(await (await app.fetch(httpRequest(`http://test.local/connect?ticket=${lockedTicket}`))).text(), /"mode":"relogin"/);

  const previousDeviceId = store.requireAccount(store.verifyPat(token)!.accountId!).devid;
  await service.unbindAccount(patId, store.verifyPat(token)!.accountId!);
  returnedUid = "relogin-uid";
  const reboundTicket = bindingTickets.issue(patId).token;
  const rebound = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${reboundTicket}`, "content-type": "application/json" },
    body: JSON.stringify({ login, password: md5("fifth") }),
  }));
  assert.equal(rebound.status, 200);
  await service.close();
  assert.notEqual(loginDeviceIds[3], previousDeviceId);
  assert.equal(store.requireAccount(store.verifyPat(token)!.accountId!).devid, loginDeviceIds[3]);
});

test("主动连接工具签发链接，解绑仅在最后一个 PAT 时级联本地数据", async (t) => {
  const { store, app, token, bindingTickets } = setupApp();
  const first = store.verifyPat(token)!;
  const accountId = first.accountId!;
  const second = store.createPat("共享账号", null);
  store.bindPat(second.id, first.uid!, "shared-token", "shared-device");
  store.saveConfirmedBills(accountId, [{
    id: "1770000000000888001",
    userid: first.uid,
    bookid: -1,
    time: 1_770_000_000,
    type: 0,
    money: 1,
    cateid: 2,
    assetid: -1,
    remark: "解绑级联验证",
  }]);
  const pendingTicket = bindingTickets.issue(first.id).token;
  const clients = [
    new Client({ name: "disconnect-first", version: "1.0.0" }),
    new Client({ name: "disconnect-second", version: "1.0.0" }),
  ];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await app.close();
    store.close();
  });
  await clients[0]!.connect(transport(app, token));
  await clients[1]!.connect(transport(app, second.token));

  const link = await clients[0]!.callTool({ name: "connect_qianji", arguments: {} });
  const linkOutput = link.structuredContent as { url: string; expiresAt: number; message: string };
  assert.match(new URL(linkOutput.url).searchParams.get("ticket") ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    linkOutput.message.slice(0, linkOutput.message.indexOf("钱迹绑定链接已生成：")),
    `${connectionDeliveryInstruction}\n\n`,
  );
  assertConnectionLinkUserMessage(linkOutput.message, linkOutput.url);
  assert.deepEqual(JSON.parse(link.content[0]?.type === "text" ? link.content[0].text : "null"), linkOutput);
  assert.equal(linkOutput.expiresAt > Math.floor(Date.now() / 1000), true);

  const retained = await clients[0]!.callTool({ name: "disconnect_qianji", arguments: {} });
  assert.deepEqual(retained.structuredContent, { disconnected: true, accountDataDeleted: false });
  assert.equal(store.verifyPat(token)?.accountId, null);
  assert.equal(store.countBills(accountId), 1);
  assert.match(await (await app.fetch(httpRequest(`http://test.local/connect?ticket=${pendingTicket}`))).text(), /"status":"invalid"/);

  const deleted = await clients[1]!.callTool({ name: "disconnect_qianji", arguments: {} });
  assert.deepEqual(deleted.structuredContent, { disconnected: true, accountDataDeleted: true });
  assert.equal(store.verifyPat(second.token)?.accountId, null);
  assert.equal(store.countBills(accountId), 0);
  const repeated = await clients[1]!.callTool({ name: "disconnect_qianji", arguments: {} });
  assert.deepEqual(repeated.structuredContent, { disconnected: true, accountDataDeleted: false });
});

test("超级管理员 PAT 使用相同的一次性连接流程", async (t) => {
  const { store, app, token, bindingTickets } = setupApp({
    role: "admin",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/login") return Response.json({ ec: 200, data: { user: { id: "admin-uid" }, token: "admin-utoken" } });
      const response = connectionInitializationResponse(path, "admin-uid");
      if (response) return response;
      throw new Error(`unexpected upstream path: ${path}`);
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const { token: ticket } = bindingTickets.issue(store.verifyPat(token)!.id);
  const response = await app.fetch(httpRequest("http://test.local/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ login: "x", password: md5("y") }),
  }));

  assert.equal(response.status, 200);
  assert.equal(store.verifyPat(token)?.uid, "admin-uid");
});

test("同一 PAT 的并发绑定只允许一个请求进入上游", async () => {
  const manager = new BindingTicketManager();
  const { token: firstTicket } = manager.issue(7);
  const { token: secondTicket } = manager.issue(7);
  assert.match(firstTicket, /^[a-f0-9]{64}$/);
  assert.match(secondTicket, /^[a-f0-9]{64}$/);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const request = (ticket: string) => httpRequest("http://test.local/connect", {
    headers: { authorization: `Bearer ${ticket}` },
  });
  const first = manager.redeem(request(firstTicket), async () => pending);
  assert.equal(manager.isPatActive(7), true);
  await assert.rejects(
    () => manager.redeem(request(secondTicket), async () => undefined),
    (error: unknown) => (error as { code?: string }).code === "BINDING_LINK_IN_USE",
  );
  release();
  await first;
  assert.equal(manager.isPatActive(7), false);
  await assert.rejects(
    () => manager.redeem(request(secondTicket), async () => undefined),
    (error: unknown) => (error as { code?: string }).code === "BINDING_LINK_INVALID",
  );
});

for (const protocol of ["2026-07-28", "2025-11-25"] as const) {
  for (const scenario of [
    { name: "未绑定 PAT", bound: false, tokenExpired: false },
    { name: "钱迹 Token 失效", bound: true, tokenExpired: true },
  ] as const) {
    test(`${scenario.name}，在 ${protocol} 下通过 URL Elicitation 连接后继续业务调用`, async (t) => {
      let bookCalls = 0;
      const { store, app, token } = setupApp({
        bound: scenario.bound,
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname;
          if (path === "/account/login") {
            return Response.json({ ec: 200, data: { user: { id: scenario.bound ? "uid-test" : "elicited-uid" }, token: "elicited-utoken" } });
          }
          const initialization = connectionInitializationResponse(path, scenario.bound ? "uid-test" : "elicited-uid");
          if (initialization) return initialization;
          if (path === "/book/list") {
            bookCalls += 1;
            if (scenario.tokenExpired && bookCalls === 1) {
              return Response.json({ ec: 401, em: "登录状态已过期" });
            }
            return Response.json({ ec: 200, data: { list: [] } });
          }
          throw new Error(`unexpected upstream path: ${path}`);
        },
      });
      t.after(async () => {
        await app.close();
        store.close();
      });
      const client = new Client(
        { name: `elicitation-${protocol}-${scenario.tokenExpired ? "expired" : "unbound"}`, version: "1.0.0" },
        {
          capabilities: { elicitation: { url: {} } },
          ...(protocol === "2026-07-28" ? { versionNegotiation: { mode: { pin: protocol } } } : {}),
        },
      );
      t.after(() => client.close());
      let elicitationCount = 0;
      const connectAccount = async (url: string): Promise<void> => {
        const connectUrl = new URL(url);
        assert.equal(connectUrl.origin + connectUrl.pathname, "http://test.local/connect");
        assert.equal(url.includes(token), false);
        assert.equal(connectUrl.hash, "");
        const ticket = connectUrl.searchParams.get("ticket") ?? "";
        assert.match(ticket, /^[a-f0-9]{64}$/);
        assert.deepEqual([...connectUrl.searchParams.keys()], ["ticket"]);
        const page = await app.fetch(httpRequest(connectUrl.href));
        const pageHtml = await page.text();
        assert.match(pageHtml, /const initialState=\{"status":"valid","mode":"initial","expiresAtMs":\d+,"remainingMs":\d+\}/);
        assert.equal(pageHtml.includes(ticket), false);
        connectUrl.search = "";
        const response = await app.fetch(httpRequest(connectUrl.href, {
          method: "POST",
          headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
          body: JSON.stringify({ login: "x", password: md5("y") }),
        }));
        assert.equal(response.status, 200);
      };
      client.setRequestHandler("elicitation/create", async (request) => {
        elicitationCount += 1;
        assert.equal(request.params.mode, "url");
        assert.match(request.params.message, scenario.tokenExpired ? /登录状态已失效/ : /连接钱迹账号/);
        assert.equal(request.params.message.includes(connectionDeliveryInstruction), false);
        assertConnectionLinkUserMessage(request.params.message, request.params.url);
        await connectAccount(request.params.url);
        return { action: "accept" };
      });

      await client.connect(transport(app, token));
      if (protocol === "2025-11-25") {
        let connectUrl = "";
        await assert.rejects(
          () => client.callTool({ name: "list_books", arguments: {} }),
          (error: unknown) => {
            assert.equal(error instanceof UrlElicitationRequiredError, true);
            if (!(error instanceof UrlElicitationRequiredError)) return false;
            connectUrl = error.elicitations[0]?.url ?? "";
            assert.match(error.message, /http:\/\/test\.local\/connect/);
            assert.match(
              error.elicitations[0]?.message ?? "",
              scenario.tokenExpired ? /登录状态已失效/ : /连接钱迹账号/,
            );
            assert.equal((error.elicitations[0]?.message ?? "").includes(connectionDeliveryInstruction), false);
            assert.equal(error.message.includes(connectionDeliveryInstruction), false);
            assertConnectionLinkUserMessage(error.elicitations[0]?.message ?? "", connectUrl);
            assertConnectionLinkUserMessage(error.message, connectUrl);
            return true;
          },
        );
        await connectAccount(connectUrl);
      }
      const result = await client.callTool({ name: "list_books", arguments: {} });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, { results: [] });
      assert.equal(elicitationCount, protocol === "2026-07-28" ? 1 : 0);
      assert.equal(store.verifyPat(token)?.uid, scenario.bound ? "uid-test" : "elicited-uid");
      assert.equal(bookCalls, scenario.tokenExpired ? 2 : 1);
    });
  }
}

test("配置统一使用 QIANJI_MCP 前缀，允许 HTTP 并拒绝关闭上游 TLS 校验", () => {
  const env: NodeJS.ProcessEnv = {
    QIANJI_MCP_PUBLIC_URL: "http://mcp.example",
    QIANJI_MCP_ADMIN_PAT: ADMIN_PAT,
    QIANJI_MCP_HOST: "0.0.0.0",
    QIANJI_MCP_PORT: "4321",
    QIANJI_MCP_DATABASE_PATH: "/tmp/qianji-test.db",
    QIANJI_MCP_DATABASE_URL: "postgres://qianji:secret@db.example/qianji",
    QIANJI_MCP_DEBUG_LOG_PATH: "/tmp/qianji-debug.jsonl",
    QIANJI_MCP_API_SERVER: "http://qianji.internal:8080",
  };
  const config = loadConfig(env);
  assert.equal(config.publicMcpUrl.href, "http://mcp.example/mcp");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4321);
  assert.equal(config.databasePath, "/tmp/qianji-test.db");
  assert.equal(config.databaseUrl?.href, "postgres://qianji:secret@db.example/qianji");
  assert.equal(config.debugLogPath, "/tmp/qianji-debug.jsonl");
  assert.equal(config.apiServer.href, "http://qianji.internal:8080/");
  assert.throws(() => loadConfig({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /forbidden/);
  assert.throws(() => loadConfig({ QIANJI_MCP_PUBLIC_URL: "http://127.0.0.1:3000" }), /QIANJI_MCP_ADMIN_PAT is required/);
  assert.throws(() => loadConfig({ QIANJI_MCP_ADMIN_PAT: "weak" }), /QIANJI_MCP_ADMIN_PAT/);
  assert.throws(() => loadConfig({ SUPERADMIN_PAT: ADMIN_PAT }), /QIANJI_MCP_ADMIN_PAT is required/);
  assert.throws(() => loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_PUBLIC_URL: "ftp://mcp.example" }), /HTTP or HTTPS/);
  assert.throws(() => loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_PUBLIC_URL: "http://mcp.example/mcp" }), /only scheme, host/);
  assert.throws(() => loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_API_SERVER: "ftp://qianji.example" }), /HTTP or HTTPS/);
  assert.throws(() => loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_API_SERVER: "https://qianji.example/api" }), /only scheme, host/);
  assert.throws(() => loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_DATABASE_URL: "sqlite:///tmp/qianji.db" }), /postgres or mysql/);
  assert.equal(loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_DATABASE_URL: "postgresql://db.example/qianji" }).databaseUrl?.protocol, "postgresql:");
  assert.equal(loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT, QIANJI_MCP_DATABASE_URL: "mysql://db.example/qianji" }).databaseUrl?.protocol, "mysql:");

  const derived = loadConfig({
    QIANJI_MCP_ADMIN_PAT: ADMIN_PAT,
    QIANJI_MCP_HOST: "192.0.2.10",
    QIANJI_MCP_PORT: "4321",
  });
  assert.equal(derived.publicMcpUrl.href, "http://192.0.2.10:4321/mcp");

  const defaults = loadConfig({ QIANJI_MCP_ADMIN_PAT: ADMIN_PAT });
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.databasePath, "data/qianji.db");
  assert.equal(defaults.databaseUrl, undefined);
  assert.equal(defaults.publicMcpUrl.href, "http://127.0.0.1:3000/mcp");
  assert.equal(defaults.apiServer.href, "https://api.qianjiapp.com/");
  assert.equal(defaults.debugLogPath, undefined);
});

test("优雅停机只执行一次并按 HTTP、MCP、数据库顺序关闭", async () => {
  const calls: string[] = [];
  let finishResponse: (() => void) | undefined;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const server = createServer((_request, response) => {
    calls.push("request");
    finishResponse = () => {
      calls.push("response");
      response.end("ok");
    };
    requestStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  if (!address || typeof address === "string") throw new Error("测试服务器没有 TCP 地址");
  const response = fetch(`http://127.0.0.1:${address.port}`);
  await started;

  const shutdown = createShutdown(Promise.resolve({
    server: {
      close(callback: (error?: Error) => void) {
        calls.push("http");
        return server.close(callback);
      },
    },
    app: { close: async () => { calls.push("mcp"); } },
    store: { close: () => { calls.push("database"); } },
  }));

  const stopped = Promise.all([shutdown(), shutdown()]);
  await Bun.sleep(0);
  assert.deepEqual(calls, ["request", "http"]);
  finishResponse?.();
  assert.equal((await response).status, 200);
  await stopped;

  assert.deepEqual(calls, ["request", "http", "response", "mcp", "database"]);
});

test("启动失败日志保留原始错误", () => {
  const result = spawnSync(process.execPath, ["src/http-server.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      QIANJI_MCP_ADMIN_PAT: ADMIN_PAT,
      QIANJI_MCP_PUBLIC_URL: "http://127.0.0.1:3000/mcp",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Qianji MCP failed to start:/);
  assert.match(result.stderr, /QIANJI_MCP_PUBLIC_URL must contain only scheme, host, and optional port/);
});
