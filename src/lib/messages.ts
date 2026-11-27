import type { SerializedError } from './errors';
import type { ConnectionReport, Draft, ExtractedPage, PaperSummary } from './types';

/** popup / options → background 的消息协议 */
export type Request =
  | { type: 'SUMMARIZE'; page: ExtractedPage }
  | { type: 'SAVE_TO_NOTION'; url: string; summary: PaperSummary }
  | { type: 'TEST_CONNECTION' };

export interface ResponseMap {
  SUMMARIZE: Draft;
  SAVE_TO_NOTION: { pageId: string; pageUrl: string };
  TEST_CONNECTION: ConnectionReport;
}

export type Response<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

export class RemoteError extends Error {
  constructor(public error: SerializedError) {
    super(error.message);
  }
}

/** 类型安全的 sendMessage 封装 */
export async function send<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<ResponseMap[R['type']]> | undefined;
  if (!res) throw new RemoteError({ message: '后台服务未响应，请重新打开插件后再试', code: 'UNKNOWN' });
  if (!res.ok) throw new RemoteError(res.error);
  return res.data;
}
