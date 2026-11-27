/** 面向用户的友好错误。message 为可直接展示的中文提示，detail 为原始技术信息。 */
export class AppError extends Error {
  constructor(
    message: string,
    public code: AppErrorCode,
    public detail?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type AppErrorCode =
  | 'CONFIG_MISSING'
  | 'LLM_AUTH'
  | 'LLM_NOT_FOUND'
  | 'LLM_RATE_LIMIT'
  | 'LLM_HTTP'
  | 'LLM_TIMEOUT'
  | 'LLM_NETWORK'
  | 'LLM_JSON_PARSE'
  | 'LLM_EMPTY'
  | 'NOTION_AUTH'
  | 'NOTION_NOT_FOUND'
  | 'NOTION_FIELD_MISMATCH'
  | 'NOTION_HTTP'
  | 'NOTION_NETWORK'
  | 'PERMISSION_DENIED'
  | 'EXTRACT_FAILED'
  | 'UNKNOWN';

export interface SerializedError {
  message: string;
  code: AppErrorCode;
  detail?: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof AppError) return { message: err.message, code: err.code, detail: err.detail };
  if (err instanceof Error) return { message: `发生未知错误：${err.message}`, code: 'UNKNOWN', detail: err.stack };
  return { message: '发生未知错误', code: 'UNKNOWN', detail: String(err) };
}
