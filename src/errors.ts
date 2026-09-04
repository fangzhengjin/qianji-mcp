/** 可安全跨越 MCP 信任边界返回的稳定应用错误。 */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  /** 创建包含稳定错误码、公开消息和 HTTP 状态码的应用错误。 */
  constructor(
    code: string,
    message: string,
    httpStatus = 400,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 将未知异常转换为不泄露内部信息的应用错误。 */
export function safeError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError("INTERNAL_ERROR", "服务暂时不可用", 500);
}
