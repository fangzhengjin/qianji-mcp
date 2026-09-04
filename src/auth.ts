import { createHash, randomBytes } from "node:crypto";

import { type DataStore, type PatRole } from "./data-store.ts";
import { AppError } from "./errors.ts";

export const BINDING_TICKET_TTL_MINUTES = 10;
const BINDING_TICKET_TTL_MS = BINDING_TICKET_TTL_MINUTES * 60 * 1000;
const BINDING_TICKET_PATTERN = /^[a-f0-9]{64}$/;

interface BindingTicketRecord {
  patId: number;
  expiresAtMs: number;
}

export interface BindingTicket {
  token: string;
  expiresAtMs: number;
}

/** 请求作用域内的 PAT 快照，账号操作会在执行前重新验证令牌。 */
export interface AuthenticatedPat {
  token: string;
  patId: number;
  accountId: number | null;
  role: PatRole;
  resource: URL;
}

/** 签发并核销仅驻留当前服务进程的一次性账号绑定凭证。 */
export class BindingTicketManager {
  private readonly records = new Map<string, BindingTicketRecord>();
  private readonly activePatIds = new Set<number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 为已认证 PAT 签发十分钟有效的随机凭证，内存中只保存摘要。 */
  issue(patId: number): BindingTicket {
    this.removeExpired();
    const token = randomBytes(32).toString("hex");
    const expiresAtMs = this.now() + BINDING_TICKET_TTL_MS;
    this.records.set(ticketDigest(token), { patId, expiresAtMs });
    return { token, expiresAtMs };
  }

  /** 只读检查凭证当前是否有效，不占用或核销凭证。 */
  inspect(token: string): { patId: number; expiresAtMs: number; remainingMs: number } | undefined {
    const entry = this.activeRecord(token);
    if (!entry) return undefined;
    const remainingMs = entry.record.expiresAtMs - this.now();
    if (remainingMs <= 0) {
      this.records.delete(entry.key);
      return undefined;
    }
    return {
      patId: entry.record.patId,
      expiresAtMs: entry.record.expiresAtMs,
      remainingMs,
    };
  }

  /** 撤销一个 PAT 尚未使用的全部短期连接链接。 */
  revokePat(patId: number): void {
    for (const [digest, record] of this.records) {
      if (record.patId === patId) this.records.delete(digest);
    }
  }

  /** 判断该 PAT 是否正在提交连接，供解绑避免与登录并发。 */
  isPatActive(patId: number): boolean {
    return this.activePatIds.has(patId);
  }

  /** 校验并独占凭证，绑定成功后撤销同一 PAT 的全部待用链接，失败时允许继续重试。 */
  async redeem<T>(request: Request, action: (patId: number) => Promise<T>): Promise<T> {
    const token = bearerToken(request);
    const entry = token ? this.activeRecord(token) : undefined;
    if (!entry) {
      throw new AppError("BINDING_LINK_INVALID", "连接链接无效或已过期，请返回原对话重新获取", 401);
    }
    const { key, record } = entry;
    if (this.activePatIds.has(record.patId)) {
      throw new AppError("BINDING_LINK_IN_USE", "该账号连接正在处理中，请等待当前绑定完成", 409);
    }

    this.activePatIds.add(record.patId);
    try {
      const result = await action(record.patId);
      for (const [digest, candidate] of this.records) {
        if (candidate.patId === record.patId) this.records.delete(digest);
      }
      return result;
    } finally {
      this.activePatIds.delete(record.patId);
      if (this.now() >= record.expiresAtMs) this.records.delete(key);
    }
  }

  /** 清除服务关闭前尚未使用的短期凭证。 */
  close(): void {
    this.records.clear();
    this.activePatIds.clear();
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [digest, record] of this.records) {
      if (now >= record.expiresAtMs) this.records.delete(digest);
    }
  }

  private activeRecord(token: string): { key: string; record: BindingTicketRecord } | undefined {
    if (!BINDING_TICKET_PATTERN.test(token)) return undefined;
    const key = ticketDigest(token);
    const record = this.records.get(key);
    if (!record) return undefined;
    if (this.now() >= record.expiresAtMs) {
      this.records.delete(key);
      return undefined;
    }
    return { key, record };
  }
}

/** 验证请求中的 Bearer PAT，并返回数据库中的当前身份。 */
export async function authenticatePat(
  request: Request,
  store: DataStore,
  resource: URL,
): Promise<AuthenticatedPat | undefined> {
  const token = bearerToken(request);
  if (!token) return undefined;
  const pat = await store.verifyPat(token);
  if (!pat) return undefined;
  return {
    token,
    patId: pat.id,
    accountId: pat.accountId,
    role: pat.role,
    resource,
  };
}

/** 只接受不含空白和逗号的单个 Bearer 凭证。 */
function bearerToken(request: Request): string | undefined {
  return /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
}

function ticketDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 要求 PAT 当前有效且已绑定一个钱迹账号。 */
export async function requireAccountPrincipal(
  principal: AuthenticatedPat,
  store: DataStore,
): Promise<AuthenticatedPat & { accountId: number }> {
  const current = await requirePatPrincipal(principal, store);
  if (current.accountId === null) throw new AppError("QIANJI_ACCOUNT_NOT_BOUND", "尚未绑定钱迹账号", 400);
  return { ...principal, accountId: current.accountId };
}

/** 要求请求中的 PAT 仍有效，允许调用不依赖账号绑定的工具。 */
export async function requirePatPrincipal(
  principal: AuthenticatedPat,
  store: DataStore,
) {
  const current = await store.verifyPat(principal.token);
  if (!current || current.id !== principal.patId || current.role !== principal.role) {
    throw new AppError("MCP_UNAUTHENTICATED", "PAT 已失效", 401);
  }
  return current;
}

/** 要求使用由启动配置管理的超级管理员 PAT。 */
export function requireAdmin(principal: AuthenticatedPat): AuthenticatedPat {
  if (principal.role !== "admin") throw new AppError("MCP_FORBIDDEN", "需要超级管理员 PAT", 403);
  return principal;
}
