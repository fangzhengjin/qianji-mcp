import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { AppError } from "./errors.ts";
import {
  isCurrencySymbol,
  isOptionalPositiveLongId,
  isParentLongId,
  isPositiveLongId,
} from "./ids.ts";
import type { QianjiAccount } from "./data-store.ts";

const CLIENT_PROFILE = {
  clang: "zh",
  cregion: "CN",
  timezoneoffset: "28800",
  os: "1",
  osvs: "36",
  pkg: "com.mutangtech.qianji",
  vs: "1207",
  vsn: "4.5.1b3",
  mk: "beta",
  devbrand: "MCP",
  devname: "MCP",
} as const;

const REQID_SECRET = "free20170908&x_*1127";
const TOK_SECRET = "michaeljackson";

export interface LoginResult {
  uid: string;
  utoken: string;
  user: Record<string, unknown>;
  books: Record<string, unknown>[];
}

export interface ClientInitResult {
  user: Record<string, unknown>;
  books: Record<string, unknown>[];
  userConfig: {
    baseCurrency?: string;
    multiCurrencyEnabled?: boolean;
  };
}

export interface PullPage {
  changes: Record<string, unknown>[];
  deletes: string[];
  categories: Record<string, unknown>[];
  bookid: string;
  pageoffset: number;
  hasmore: 0 | 1;
  pagesign: string;
  lasttimes: unknown;
}

export interface SyncBillResult {
  new_ids: string[];
  update_ids: string[];
  del_ids: string[];
  conf_ids: string[];
  has_failed: boolean;
}

export type BudgetPeriod =
  | { kind: "month"; year: number; month: number }
  | { kind: "year"; year: number };

export type QianjiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface QianjiClientOptions {
  baseUrl?: URL;
  fetch?: QianjiFetch;
  now?: () => number;
  /** 可选的上游诊断 JSONL 文件，名称包含 token 的字段会被脱敏。 */
  debugLogPath?: string;
}

interface Envelope {
  ec: number;
  em?: string;
  data?: unknown;
}

interface JsonSourceContext {
  source?: string;
}

interface RawJsonNumber {
  rawJSON: string;
}

interface JsonWithRaw extends JSON {
  /** 将已校验的数字文本作为原始 JSON token 输出。 */
  rawJSON(text: string): RawJsonNumber;
  /** 判断值是否为原始 JSON token。 */
  isRawJSON(value: unknown): value is RawJsonNumber;
}

/** 为钱迹旧协议计算小写 MD5。 */
export function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/** 从钱迹 API 路径提取两个签名组成部分。 */
export function extractCtrlAct(path: string): { ctrl: string; act: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new AppError("QIANJI_SIGNATURE_ERROR", "钱迹接口路径无法签名", 500);
  }
  return { ctrl: parts[0]!, act: parts[1]! };
}

/** 按 Android 4.5.1b3 实际请求算法计算路径对应的 `tok`。 */
export function createTok(reqidv2: string, ctrl: string, act: string): string {
  const encReqid = md5(reqidv2 + TOK_SECRET);
  return md5(reqidv2 + "1172020" + ctrl + encReqid + act);
}

/** 按 Android 4.5.1b3 实际请求算法计算 `reqidv2`，时间可注入以支持确定性测试。 */
export function createReqidv2(ctrl: string, act: string, epochMs = Date.now()): string {
  const shiftedMs = epochMs + Number(CLIENT_PROFILE.vs) + 9_081_127;
  return md5(CLIENT_PROFILE.pkg + String(shiftedMs) + ctrl + act + REQID_SECRET);
}

/** 解析 JSON，并将超出安全范围的整数字面量保留为原始 JSON 数字。 */
export function parseQianjiJson(text: string): unknown {
  const json = JSON as JsonWithRaw;
  const parse = JSON.parse as unknown as (
    source: string,
    reviver: (key: string, value: unknown, context: JsonSourceContext) => unknown,
  ) => unknown;
  return parse(text, (_key, value, context) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context.source !== undefined &&
      /^-?\d+$/.test(context.source)
    ) {
      return json.rawJSON(context.source);
    }
    return value;
  });
}

/** 判断值是否为保留下来的不安全原始 JSON 整数。 */
export function isRawJsonNumber(value: unknown): boolean {
  return (JSON as JsonWithRaw).isRawJSON(value);
}

/** 将钱迹数字业务 ID 序列化为 JSON token，避免 JavaScript 数字精度丢失。 */
export function stringifyQianjiPayload(payload: Record<string, unknown>): string {
  const json = JSON as JsonWithRaw;
  const bills = payload.bills && typeof payload.bills === "object" && !Array.isArray(payload.bills)
    ? payload.bills as Record<string, unknown>
    : {};
  const changes = Array.isArray(bills.changelist) ? bills.changelist : [];
  const deletes = Array.isArray(bills.dellist) ? bills.dellist : [];
  return JSON.stringify(payload, function (this: unknown, key, value: unknown) {
    // replacer 的 this 指向父容器，删除列表元素没有字段名，因此通过数组引用识别其 ID。
    // 仅对已知协议位置转换原始数字，避免把备注等普通字符串误写为数字 token。
    const accepts = changes.includes(this)
      ? key === "id"
        ? isPositiveLongId
        : ["bookid", "cateid", "assetid", "fromid", "targetid"].includes(key)
          ? isOptionalPositiveLongId
          : undefined
      : this === deletes
        ? isPositiveLongId
        : key === "billid"
          ? isPositiveLongId
          : key === "assetid"
            ? isOptionalPositiveLongId
            : undefined;
    if (!accepts) return value;
    const text = typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
    if (!accepts(text)) throw new AppError("QIANJI_PAYLOAD_INVALID", `钱迹账单 ${key || "id"} 无效`);
    return typeof value === "string" ? json.rawJSON(value) : value;
  });
}

/** 将账单 ID 列表序列化为保持精度的 JSON 数字数组。 */
function stringifyQianjiIdList(ids: string[]): string {
  const json = JSON as JsonWithRaw;
  return JSON.stringify(ids.map((id) => {
    if (!isPositiveLongId(id)) throw new AppError("QIANJI_PAYLOAD_INVALID", "钱迹账单 ID 无效");
    return json.rawJSON(id);
  }));
}

/** 钱迹私有 API 共用的表单编码 HTTP 客户端。 */
export class QianjiClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: QianjiFetch;
  private readonly now: () => number;
  private readonly debugLogPath?: string;
  private readonly lastRequestMsByRoute = new Map<string, number>();

  /** 创建钱迹客户端，并按需初始化权限受限的诊断日志文件。 */
  constructor(options: QianjiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? new URL("https://api.qianjiapp.com/");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.debugLogPath = options.debugLogPath;
    if (this.debugLogPath) {
      mkdirSync(dirname(this.debugLogPath), { recursive: true, mode: 0o700 });
      appendFileSync(this.debugLogPath, "", { mode: 0o600 });
      chmodSync(this.debugLogPath, 0o600);
    }
  }

  /** 使用浏览器计算的 MD5 摘要登录，且不在请求结束后保留摘要。 */
  async login(account: string, passwordMd5: string, devid: string): Promise<LoginResult> {
    const data = await this.post("/account/login", { v: account, pwd: passwordMd5 }, { devid });
    const object = asObject(data);
    const user = object.user && typeof object.user === "object" && !Array.isArray(object.user)
      ? object.user as Record<string, unknown>
      : {};
    const uid = numericText(user.id);
    const utoken = typeof object.token === "string" ? object.token : "";
    const missing = [!uid && "user.id", !utoken && "token"].filter(Boolean);
    if (missing.length > 0) throw new AppError(
      "QIANJI_RESPONSE_INVALID",
      `钱迹返回登录成功状态，但缺少 ${missing.join("、")}`,
      502,
    );
    return {
      uid,
      utoken,
      user: { ...user, id: uid },
      books: object.books === undefined ? [] : asObjectArray(object.books).map(normalizeBook),
    };
  }

  /** 通过 APK 客户端初始化接口刷新用户和账本数据。 */
  async initialize(account: QianjiAccount, currentIsVip: boolean): Promise<ClientInitResult> {
    const data = asObject(await this.authPost(account, "/client/init", {
      v: 0,
      vvmark: currentIsVip ? 1 : 0,
      newinstall: 0,
      upgradealert: 0,
    }));
    const user = asObject(data.userinfo);
    const userConfig = data.userconfigs && typeof data.userconfigs === "object" && !Array.isArray(data.userconfigs)
      ? data.userconfigs as Record<string, unknown>
      : {};
    const configuredBaseCurrency = typeof userConfig.basecur === "string" ? userConfig.basecur.trim() : "";
    const baseCurrency = configuredBaseCurrency || "CNY";
    const multiCurrencyEnabled = userConfig.mcurrency === undefined
      ? false
      : userConfig.mcurrency === true || Number(userConfig.mcurrency) === 1;
    return {
      user: { ...user, id: opaqueIdText(user.id, "用户") },
      books: data.books === undefined ? [] : asObjectArray(data.books).map(normalizeBook),
      userConfig: {
        ...(isCurrencySymbol(baseCurrency) ? { baseCurrency } : {}),
        multiCurrencyEnabled,
      },
    };
  }

  /** 通过统一认证传输读取可见或全部账本。 */
  async listBooks(account: QianjiAccount, includeHidden: boolean): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/book/list", { t: includeHidden ? -1 : 1 }));
    return asObjectArray(data.list).map(normalizeBook);
  }

  /** 读取指定账本的成员候选。 */
  async listBookMembers(account: QianjiAccount, bookId: string): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/book/members", { bookid: bookId }));
    return asObjectArray(data.list).map((member) => ({
      userId: opaqueIdText(member.id, "账本成员"),
      name: String(member.name ?? ""),
    }));
  }

  /** 通过统一认证传输读取正常或全部资产。 */
  async listAssets(account: QianjiAccount, includeHidden: boolean): Promise<Record<string, unknown>[]> {
    const statuses = includeHidden ? [0, 2] : [0];
    const responses = await Promise.all(
      statuses.map(async (status) => asObject(await this.authPost(account, "/asset/list", { status }))),
    );
    const groups = new Map(responses.flatMap((response) =>
      response.groups === undefined ? [] : asObjectArray(response.groups)
    ).map((group, index) => [
      opaqueIdText(group.groupid, "资产组"),
      { name: String(group.name ?? ""), order: index },
    ]));
    const assets = responses.flatMap((response) => asObjectArray(response.list)).map((asset) => {
      const groupid = opaqueIdText(asset.groupid ?? -1, "资产组");
      const group = groups.get(groupid);
      return {
        ...asset,
        id: positiveIdText(asset.id, "资产"),
        groupid,
        ...(group ? { groupName: group.name, groupOrder: group.order } : {}),
      };
    });
    return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
  }

  /** 按借入/借出方向和状态读取独立详情列表。 */
  async listDebtAccounts(
    account: QianjiAccount,
    direction: 51 | 52,
    status: 0 | 1,
  ): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/asset/listloan", { t: direction, status }));
    return asObjectArray(data.list).map((asset) => ({ ...asset, id: positiveIdText(asset.id, "借入或借出记录") }));
  }

  /** 读取跨币种写入所需的币种标识、价格和价格时间。 */
  async listCurrencies(account: QianjiAccount): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/currency/listv2", {}));
    return asObjectArray(data.list).map((currency) => ({
      symbol: String(currency.symbol ?? "").trim(),
      baseprice: Number(currency.baseprice),
      pricetime: Number(currency.pricetime ?? 0),
    }));
  }

  /** 读取指定账本和账单类型的分类。 */
  async listCategories(account: QianjiAccount, bookId: string, type: -1 | 0 | 1): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/category/listv2", { bookid: bookId, t: type }));
    return asObjectArray(data.list).map(normalizeCategory);
  }

  /** 读取指定账本和月份或年份的预算定义。 */
  async listBudgets(
    account: QianjiAccount,
    bookId: string,
    period: BudgetPeriod,
    range?: string,
  ): Promise<Record<string, unknown>[]> {
    const filter = period.kind === "month"
      ? { month: `${period.year},${period.month}` }
      : { year: String(period.year) };
    const body: Record<string, string> = { bookid: bookId, flts: JSON.stringify(filter) };
    if (range) body.range = range;
    const data = asObject(await this.authPost(account, "/budget/list", body));
    return asObjectArray(data.list).map((budget) => {
      const normalized: Record<string, unknown> = {
        ...budget,
        bookid: optionalPositiveIdText(budget.bookid ?? bookId, "账本"),
      };
      if (budget.cateid !== undefined && budget.cateid !== null) {
        normalized.cateid = referenceIdText(budget.cateid, "预算分类");
      }
      if (budget.category !== undefined && budget.category !== null) {
        normalized.category = normalizeCategory(asObject(budget.category));
      }
      return normalized;
    });
  }

  /** 读取正常及归档标签组，并展开其中的嵌套标签。 */
  async listTags(account: QianjiAccount, status: -1 | 1 | 2, lastTime = 0): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/tag/list", { status, lasttime: lastTime }, true));
    return asObjectArray(data.list).flatMap((group) => {
      const groupId = tagGroupIdText(group.id);
      const groupName = String(group.name ?? "");
      return asObjectArray(group.tags).map((tag) => ({
        ...tag,
        id: opaqueIdText(tag.id, "标签"),
        groupId,
        groupName,
      }));
    });
  }

  /** 从钱迹增量同步协议读取一页数据。 */
  async pullBills(
    account: QianjiAccount,
    request: {
      bookid: string;
      pageoffset: number;
      pagesign: string;
      lasttimes?: unknown;
    },
  ): Promise<PullPage> {
    const body: Record<string, string | number> = {
      bookid: request.bookid,
      pageoffset: request.pageoffset,
      pagesign: request.pagesign,
    };
    if (request.lasttimes !== undefined) body.lasttimes = JSON.stringify(request.lasttimes);
    const data = asObject(await this.authPost(account, "/syncv2/pull", body, true));
    const hasmore = Number(data.hasmore);
    const bookid = optionalPositiveIdText(data.bookid, "账本");
    const pageoffset = Number(data.pageoffset);
    if (
      (hasmore !== 0 && hasmore !== 1) ||
      !Number.isInteger(pageoffset) ||
      pageoffset < 0 ||
      typeof data.pagesign !== "string"
    ) {
      throw new AppError("SYNC_CURSOR_INVALID", "钱迹同步游标无效", 502);
    }
    return {
      changes: asObjectArray(data.changes).map(normalizeBillIds),
      deletes: asArray(data.deletes).map((id) => positiveIdText(id, "账单")),
      categories: data.categories === undefined ? [] : asObjectArray(data.categories).map(normalizePullCategory),
      bookid,
      pageoffset,
      hasmore,
      pagesign: data.pagesign,
      lasttimes: data.lasttimes,
    };
  }

  /** 发送兼容钱迹账单创建、更新和删除结构的同步载荷。 */
  async syncBills(account: QianjiAccount, payload: Record<string, unknown>): Promise<SyncBillResult> {
    const data = asObject(
      await this.authPost(account, "/bill/syncall", { v: stringifyQianjiPayload(payload) }, true),
    );
    const result = asObject(asObject(data.sync_result).bill);
    return {
      new_ids: asArray(result.new_ids).map((id) => positiveIdText(id, "新建账单")),
      update_ids: asArray(result.update_ids).map((id) => positiveIdText(id, "修改账单")),
      del_ids: asArray(result.del_ids).map((id) => positiveIdText(id, "删除账单")),
      conf_ids: asArray(result.conf_ids).map((id) => positiveIdText(id, "冲突账单")),
      has_failed: result.has_failed === true || result.has_failed === 1,
    };
  }

  /** 创建或更新退款，并返回钱迹解析 `data.list` 得到的完整账单组。 */
  async refundBill(
    account: QianjiAccount,
    sourceBillId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const data = asObject(await this.authPost(account, "/bill/refund2", {
      did: sourceBillId,
      v: stringifyQianjiPayload(payload),
    }));
    return asObjectArray(data.list).map(normalizeBillIds);
  }

  /** 通过 APK 接口报销源账单，并返回全部变更账单及相关资产。 */
  async reimburseBills(
    account: QianjiAccount,
    input: {
      allocations: Record<string, { money: number } | { curr: Record<string, unknown> }>;
      assetId?: string;
      time?: number;
      remark?: string;
      tagIds?: string[];
    },
  ): Promise<{ asset?: Record<string, unknown>; bills: Record<string, unknown>[] }> {
    const body: Record<string, string | number> = {
      v: stringifyQianjiPayload(input.allocations),
    };
    if (input.assetId !== undefined && input.assetId !== "-1") body.did = input.assetId;
    if (input.time !== undefined) body.bxtime = input.time;
    if (input.remark) body.remark = input.remark;
    if (input.tagIds && input.tagIds.length > 0) body.tags = JSON.stringify(input.tagIds);
    const data = asObject(await this.authPost(account, "/baoxiao/baoxiao", body));
    const asset = data.asset === undefined ? undefined : asObject(data.asset);
    return {
      asset: asset && { ...asset, id: positiveIdText(asset.id, "资产") },
      bills: data.bills === undefined ? [] : asObjectArray(data.bills).map(normalizeBillIds),
    };
  }

  /** 按 APK 的一次性账号迁移接口启用新版报销，且只接受明确的成功值 1。 */
  async upgradeReimbursement(account: QianjiAccount): Promise<void> {
    const data = await this.authPost(account, "/baoxiao/upgradev2", {});
    const value = data && typeof data === "object" && !Array.isArray(data) &&
        Object.keys(data as Record<string, unknown>).length === 1 && "v" in data
      ? (data as Record<string, unknown>).v
      : data;
    if (value !== 1) {
      throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹新版报销迁移未返回成功状态", 502);
    }
  }

  /** 按 APK 契约使用源账单 ID 取消报销关系。 */
  async cancelReimbursement(account: QianjiAccount, sourceBillIds: string[]): Promise<void> {
    await this.authPost(account, "/baoxiao/cancelbaoxiao", {
      v: stringifyQianjiIdList(sourceBillIds),
    });
  }

  /** 为已绑定账号补充认证字段后发送 POST 请求。 */
  private async authPost(
    account: QianjiAccount,
    path: string,
    body: Record<string, string | number>,
    htoken = false,
  ): Promise<unknown> {
    return this.post(
      path,
      { uid: account.uid, ...body, fr: account.uid },
      { devid: account.devid, utoken: account.utoken, htoken },
    );
  }

  /** 构造签名、执行表单请求并将钱迹响应转换为稳定错误或业务数据。 */
  private async post(
    path: string,
    body: Record<string, string | number>,
    auth: { devid: string; utoken?: string; htoken?: boolean },
  ): Promise<unknown> {
    const { ctrl, act } = extractCtrlAct(path);
    const route = `${ctrl}/${act}`;
    const now = this.now();
    // 钱迹会拒绝同一路径同一毫秒产生的重复 reqidv2。
    const requestMs = Math.max(now, (this.lastRequestMsByRoute.get(route) ?? now - 1) + 1);
    this.lastRequestMsByRoute.set(route, requestMs);
    const reqidv2 = createReqidv2(ctrl, act, requestMs);
    const headers = new Headers({
      ...CLIENT_PROFILE,
      ctrl,
      act,
      reqidv2,
      tok: createTok(reqidv2, ctrl, act),
      devid: auth.devid,
      "content-type": "application/x-www-form-urlencoded",
    });
    if (auth.utoken) headers.set("utoken", auth.utoken);
    if (auth.htoken) headers.set("htoken", "1");

    const url = new URL(path, this.baseUrl);
    const requestBody = new URLSearchParams(
      Object.entries(body).map(([key, value]) => [key, String(value)]),
    ).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      this.writeDebugLog(url, requestBody, null, null);
      throw new AppError("QIANJI_HTTP_ERROR", "无法连接钱迹服务", 502);
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      this.writeDebugLog(url, requestBody, response.status, null);
      throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹服务返回了无效响应", 502);
    }
    this.writeDebugLog(url, requestBody, response.status, responseBody);
    if (response.status === 401 || response.status === 403) {
      if (path === "/account/login") {
        throw new AppError("QIANJI_LOGIN_REJECTED", "钱迹拒绝登录", 401);
      }
      throw new AppError("QIANJI_TOKEN_INVALID", "钱迹登录状态已失效", 401);
    }
    if (!response.ok) {
      throw new AppError("QIANJI_HTTP_ERROR", "钱迹服务返回 HTTP 错误", 502);
    }

    let envelope: Envelope;
    try {
      envelope = asObject(parseQianjiJson(responseBody)) as unknown as Envelope;
    } catch {
      throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹服务返回了无效响应", 502);
    }
    if (envelope.ec !== 200) {
      const hint = qianjiErrorMessage(envelope.em).toLowerCase();
      if (path === "/account/login") {
        if (/账号.*密码.*不匹配/.test(hint)) {
          throw new AppError("QIANJI_LOGIN_REJECTED", "钱迹登录失败：账号和密码不匹配", 401);
        }
        throw new AppError("QIANJI_LOGIN_REJECTED", `钱迹拒绝登录（ec=${envelope.ec}）`, 401);
      }
      if (/utoken|token|登录|过期/.test(hint)) {
        throw new AppError("QIANJI_TOKEN_INVALID", "钱迹登录状态已失效", 401);
      }
      if (/\btok\b|sign|签名/.test(hint)) {
        throw new AppError("QIANJI_SIGNATURE_REJECTED", "钱迹请求签名被拒绝", 502);
      }
      if (path.startsWith("/baoxiao/") && /升级.*公测版本|报销.*升级/.test(hint)) {
        throw new AppError(
          "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED",
          "钱迹账号尚未迁移到新版报销",
          409,
        );
      }
      throw new AppError("QIANJI_BUSINESS_ERROR", `钱迹业务请求失败（ec=${envelope.ec}）`, 502);
    }
    return envelope.data;
  }

  /** 以脱敏 JSONL 追加可选诊断记录，日志失败不影响业务请求。 */
  private writeDebugLog(url: URL, requestBody: string, status: number | null, responseBody: string | null): void {
    if (!this.debugLogPath) return;
    try {
      // ponytail: 可选诊断采用同步追加已足够，吞吐成为实际问题时再接入部署日志管道。
      appendFileSync(this.debugLogPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        method: "POST",
        url: url.href,
        requestBody: url.pathname === "/account/login" ? "[REDACTED]" : redactFormBody(requestBody),
        status,
        responseBody: responseBody === null
          ? null
          : url.pathname === "/account/login" ? "[REDACTED]" : redactJsonText(responseBody),
      })}\n`);
    } catch {
      console.error("Qianji debug log write failed");
    }
  }
}

/** 脱敏表单中名称包含 token 的字段及嵌套 JSON。 */
function redactFormBody(body: string): string {
  const form = new URLSearchParams(body);
  for (const [key, value] of form) {
    form.set(key, /token/i.test(key) ? "[REDACTED]" : redactJsonText(value));
  }
  return form.toString();
}

/** 尝试脱敏 JSON 文本，非 JSON 内容保持原文。 */
function redactJsonText(text: string): string {
  try {
    const value = parseQianjiJson(text);
    if (!value || typeof value !== "object") return text;
    return JSON.stringify(redactTokenFields(value));
  } catch {
    return text;
  }
}

/** 递归脱敏对象中名称包含 token 的字段。 */
function redactTokenFields(value: unknown): unknown {
  if (isRawJsonNumber(value)) return value;
  if (Array.isArray(value)) return value.map(redactTokenFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, /token/i.test(key) ? "[REDACTED]" : redactTokenFields(item)]),
  );
}

/** 从钱迹 JSON 或纯文本错误中提取可用于分类的消息。 */
function qianjiErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).msg === "string") {
      return (parsed as Record<string, unknown>).msg as string;
    }
  } catch {
    // 钱迹也可能直接返回纯文本错误消息。
  }
  return value;
}

/** 要求上游值为非数组对象。 */
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹服务返回了无效数据", 502);
  }
  return value as Record<string, unknown>;
}

/** 要求上游值为数组。 */
function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", "钱迹服务返回了无效列表", 502);
  }
  return value;
}

/** 将普通数字或原始 JSON 数字转换为精确文本。 */
function numericText(value: unknown): string {
  const json = JSON as JsonWithRaw;
  if (json.isRawJSON(value)) return value.rawJSON;
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** 校验并转换正整数资源 ID。 */
function positiveIdText(value: unknown, resource: string): string {
  const text = numericText(value);
  if (!isPositiveLongId(text)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹返回了无效${resource} ID`, 502);
  }
  return text;
}

/** 校验并转换允许父分类哨兵值的引用 ID。 */
function referenceIdText(value: unknown, resource: string): string {
  const text = numericText(value);
  if (!isParentLongId(text)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹返回了无效${resource} ID`, 502);
  }
  return text;
}

/** 校验并转换允许 `-1` 的资源 ID。 */
function optionalPositiveIdText(value: unknown, resource: string): string {
  const text = numericText(value);
  if (!isOptionalPositiveLongId(text)) {
    throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹返回了无效${resource} ID`, 502);
  }
  return text;
}

/** 将不透明资源 ID 转换为非空文本。 */
function opaqueIdText(value: unknown, resource: string): string {
  const text = numericText(value);
  if (!text) throw new AppError("QIANJI_RESPONSE_INVALID", `钱迹返回了无效${resource} ID`, 502);
  return text;
}

/** 转换标签组 ID，并保留空字符串表示默认组。 */
function tagGroupIdText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return opaqueIdText(value, "标签组");
}

/** 规范化钱迹账本对象中的账本 ID。 */
function normalizeBook(book: Record<string, unknown>): Record<string, unknown> {
  return { ...book, bookid: optionalPositiveIdText(book.bookid, "账本") };
}

/** 规范化完整钱迹账单中的全部业务 ID。 */
function normalizeBillIds(bill: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...bill,
    id: positiveIdText(bill.id, "账单"),
    bookid: optionalPositiveIdText(bill.bookid, "账本"),
  };
  if (bill.cateid !== undefined && bill.cateid !== null) normalized.cateid = optionalPositiveIdText(bill.cateid, "分类");
  for (const [field, resource] of [["assetid", "资产"], ["fromid", "来源资产"], ["targetid", "目标资产"]] as const) {
    if (bill[field] !== undefined && bill[field] !== null) normalized[field] = optionalPositiveIdText(bill[field], resource);
  }
  if (bill.extra && typeof bill.extra === "object" && !Array.isArray(bill.extra)) {
    const extra = bill.extra as Record<string, unknown>;
    const normalizedExtra = { ...extra };
    if (Array.isArray(extra.tags)) {
      normalizedExtra.tags = extra.tags.map((tag) => opaqueIdText(tag, "标签"));
    }
    for (const field of ["refundsid", "bxsid"] as const) {
      if (extra[field] !== undefined && extra[field] !== null) {
        normalizedExtra[field] = positiveIdText(extra[field], "关联账单");
      }
    }
    normalized.extra = normalizedExtra;
  }
  return normalized;
}

/** 规范化同步分页中携带的分类 ID 和账本 ID。 */
function normalizePullCategory(category: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...category,
    id: positiveIdText(category.id ?? category.cateid, "分类"),
  };
  if (category.bookid !== undefined && category.bookid !== null) {
    normalized.bookid = optionalPositiveIdText(category.bookid, "账本");
  }
  return normalized;
}

/** 规范化分类及其直属子分类中的 ID。 */
function normalizeCategory(category: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...category,
    id: positiveIdText(category.id ?? category.cateid, "分类"),
    parentid: referenceIdText(category.parentid ?? -1, "父分类"),
  };
  if (category.sublist !== undefined && category.sublist !== null) {
    normalized.sublist = asObjectArray(category.sublist).map((child) => ({
      ...child,
      id: positiveIdText(child.id ?? child.cateid, "分类"),
      parentid: referenceIdText(child.parentid ?? normalized.id, "父分类"),
    }));
  }
  return normalized;
}

/** 要求上游值为对象数组。 */
function asObjectArray(value: unknown): Record<string, unknown>[] {
  return asArray(value).map(asObject);
}
