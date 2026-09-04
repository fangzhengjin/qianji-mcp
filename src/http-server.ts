import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  authenticatePat,
  BindingTicketManager,
  type AuthenticatedPat,
} from "./auth.ts";
import { connectionPage } from "./bind-page.ts";
import type { DataStore } from "./data-store.ts";
import { AppError, safeError } from "./errors.ts";
import { createMoneyTrackMcp } from "./mcp-server.ts";
import { QianjiClient } from "./qianji-client.ts";
import { MoneyTrackService } from "./qianji-service.ts";
import { createDataStore } from "./server-store.ts";

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  databaseUrl?: URL;
  publicMcpUrl: URL;
  apiServer: URL;
  superadminPat: string;
  debugLogPath?: string;
}

export interface HttpApplication {
  /** 处理一个标准 Web Request。 */
  fetch(request: Request): Promise<Response>;
  /** 关闭 MCP 处理器并释放其资源。 */
  close(): Promise<void>;
}

const connectInput = z.strictObject({
  login: z.string().trim().min(1).max(320).optional(),
  password: z.string().regex(/^[a-f0-9]{32}$/),
});
/** 加载命名空间配置，并拒绝不安全的上游 TLS 设置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden");
  }
  const host = env.QIANJI_MCP_HOST ?? "127.0.0.1";
  const port = parseInteger(env.QIANJI_MCP_PORT ?? "3000", "QIANJI_MCP_PORT");
  const publicUrl = new URL(env.QIANJI_MCP_PUBLIC_URL ?? `http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
    throw new Error("QIANJI_MCP_PUBLIC_URL must use HTTP or HTTPS");
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error("QIANJI_MCP_PUBLIC_URL must contain only scheme, host, and optional port");
  }
  const publicMcpUrl = new URL("/mcp", publicUrl);
  const apiServer = new URL(env.QIANJI_MCP_API_SERVER ?? "https://api.qianjiapp.com");
  if (apiServer.protocol !== "http:" && apiServer.protocol !== "https:") {
    throw new Error("QIANJI_MCP_API_SERVER must use HTTP or HTTPS");
  }
  if (apiServer.pathname !== "/" || apiServer.search || apiServer.hash || apiServer.username || apiServer.password) {
    throw new Error("QIANJI_MCP_API_SERVER must contain only scheme, host, and optional port");
  }

  const superadminPat = requireEnv(env, "QIANJI_MCP_ADMIN_PAT");
  if (!/^mt_pat_[A-Za-z0-9_-]{32,}$/.test(superadminPat)) {
    throw new Error("QIANJI_MCP_ADMIN_PAT must start with mt_pat_ and contain at least 32 random characters");
  }
  const databaseUrl = parseDatabaseUrl(env.QIANJI_MCP_DATABASE_URL);
  return {
    host,
    port,
    databasePath: env.QIANJI_MCP_DATABASE_PATH ?? "data/qianji.db",
    databaseUrl,
    publicMcpUrl,
    apiServer,
    superadminPat,
    debugLogPath: env.QIANJI_MCP_DEBUG_LOG_PATH,
  };
}

/** 围绕官方双版本 MCP 处理器组合 HTTP 路由。 */
export function createHttpApplication(
  config: AppConfig,
  store: DataStore,
  service: MoneyTrackService,
  bindingTickets = new BindingTicketManager(),
): HttpApplication {
  // MCP 工厂在 fetch 期间执行，请求本地存储用于隔离并发请求的 PAT 身份。
  const authentication = new AsyncLocalStorage<AuthenticatedPat>();
  const mcp = createMcpHandler(() => {
    const principal = authentication.getStore();
    if (!principal) throw new Error("MCP request authentication context is missing");
    return createMoneyTrackMcp(service, store, principal, bindingTickets);
  }, {
    legacy: "stateless",
    onerror: (error: unknown) => console.error("MCP handler error:", error),
  });

  return {
    /** 处理绑定页面、账号绑定和 MCP 请求。 */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/connect") {
        return connectPageResponse(url.searchParams.get("ticket"), bindingTickets, store);
      }

      if (url.pathname === "/connect" && request.method === "POST") {
        return handleConnect(request, bindingTickets, service, config.publicMcpUrl.origin);
      }
      if (url.pathname === "/mcp") {
        const principal = await authenticatePat(request, store, config.publicMcpUrl);
        if (!principal) return unauthorizedResponse();
        const response = await authentication.run(principal, () => mcp.fetch(request));
        response.headers.set("cache-control", "no-store");
        return response;
      }
      return jsonResponse(404, { error: { code: "NOT_FOUND", message: "路径不存在" } });
    },
    close: async () => {
      bindingTickets.close();
      await mcp.close();
      await service.close();
    },
  };
}

/** 启动远程 HTTP 服务，可选 TLS 终止由上游反向代理负责。 */
export async function startServer(config = loadConfig()): Promise<{
  server: HttpServer;
  store: DataStore;
  app: HttpApplication;
}> {
  const store = await createDataStore(config.databasePath, config.databaseUrl);
  try {
    await store.ensureAdminPat(config.superadminPat);
    const service = new MoneyTrackService(store, new QianjiClient({
      baseUrl: config.apiServer,
      debugLogPath: config.debugLogPath,
    }));
    const app = createHttpApplication(config, store, service);
    const nodeHandler = toNodeHandler(app, { onerror: (error: unknown) => console.error("HTTP adapter error:", error) });
    const server = createServer((request, response) => {
      void nodeHandler(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolve());
    });
    console.log(`Qianji MCP listening on ${config.host}:${config.port}`);
    return { server, store, app };
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** 返回幂等关闭函数，先停止接收 HTTP 请求，再关闭 MCP 和存储。 */
export function createShutdown(resources: Promise<{
  server: { close(callback: (error?: Error) => void): unknown };
  store: Pick<DataStore, "close">;
  app: Pick<HttpApplication, "close">;
}>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= resources.then(async ({ server, app, store }) => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await app.close();
    await store.close();
  });
}

/** 校验同站来源和一次性凭证后执行钱迹账号绑定。 */
async function handleConnect(
  request: Request,
  bindingTickets: BindingTicketManager,
  service: MoneyTrackService,
  publicOrigin: string,
): Promise<Response> {
  if (!sameSiteRequest(request, publicOrigin)) return jsonResponse(403, { error: { code: "INVALID_ORIGIN", message: "拒绝跨站绑定请求" } });
  try {
    const input = connectInput.parse(await readJson(request));
    await bindingTickets.redeem(request, (patId) => service.bindAccount(patId, input.login, input.password));
    return jsonResponse(200, { bound: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 构造带 Bearer 质询头的未认证响应。 */
function unauthorizedResponse(): Response {
  const response = jsonResponse(401, {
    error: { code: "MCP_UNAUTHENTICATED", message: "PAT 无效或已过期" },
  });
  response.headers.set("www-authenticate", "Bearer");
  return response;
}

/** 在 32 KiB 上限内读取并解析 JSON 请求体。 */
async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("INVALID_JSON", "请求体不能为空");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32_768) throw new AppError("REQUEST_TOO_LARGE", "请求体过大", 413);
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "请求体不是有效 JSON");
  }
}

/** 由后端校验一次性票据，并构造带随机 CSP nonce 的连接页面。 */
async function connectPageResponse(
  ticket: string | null,
  bindingTickets: BindingTicketManager,
  store: DataStore,
): Promise<Response> {
  const nonce = randomBytes(18).toString("base64url");
  const inspection = ticket ? bindingTickets.inspect(ticket) : undefined;
  const connection = inspection ? await store.getPatConnection(inspection.patId) : undefined;
  const pageState = inspection && connection
    ? connection.accountId !== null && connection.loginIdentifier
      ? {
          status: "valid" as const,
          mode: "relogin" as const,
          expiresAtMs: inspection.expiresAtMs,
          remainingMs: inspection.remainingMs,
          maskedLogin: maskLoginIdentifier(connection.loginIdentifier),
        }
      : {
          status: "valid" as const,
          mode: "initial" as const,
          expiresAtMs: inspection.expiresAtMs,
          remainingMs: inspection.remainingMs,
        }
    : { status: "invalid" as const };
  return new Response(connectionPage(nonce, pageState), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/** 只向连接页暴露足以识别账号的脱敏摘要。 */
function maskLoginIdentifier(login: string): string {
  const at = login.indexOf("@");
  if (at > 0) return `${login.slice(0, 1)}***${login.slice(at)}`;
  if (/^\+?\d{7,}$/.test(login)) return `${login.slice(0, 3)}****${login.slice(-4)}`;
  if (login.length <= 2) return "**";
  return `${login.slice(0, 2)}***${login.slice(-2)}`;
}

/** 按公开地址校验浏览器来源，无来源头客户端仍须通过一次性票据认证。 */
function sameSiteRequest(request: Request, publicOrigin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === publicOrigin;
  const referer = request.headers.get("referer");
  if (referer === null) return true;
  try {
    return new URL(referer).origin === publicOrigin;
  } catch {
    return false;
  }
}

/** 将参数错误和应用错误转换为统一 JSON 响应。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return jsonResponse(400, { error: { code: "INVALID_INPUT", message: "输入参数无效" } });
  }
  const safe = safeError(error);
  return jsonResponse(safe.httpStatus, { error: { code: safe.code, message: safe.message } });
}

/** 构造禁止缓存的 JSON 响应。 */
function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** 读取必填环境变量。 */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** 将环境变量解析为有效 TCP 端口。 */
function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a valid port`);
  return parsed;
}

/** 解析可选的 PostgreSQL 或 MySQL 数据库地址。 */
function parseDatabaseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:" && url.protocol !== "mysql:") {
    throw new Error("QIANJI_MCP_DATABASE_URL must use postgres or mysql");
  }
  return url;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const running = startServer();
  const shutdown = createShutdown(running);
  /** 收到终止信号后触发幂等关闭流程。 */
  const handleSignal = (): void => {
    void shutdown().catch((error: unknown) => {
      console.error("Qianji MCP failed to stop:", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  running.catch((error: unknown) => {
    console.error("Qianji MCP failed to start:", error);
    process.exitCode = 1;
  });
}
