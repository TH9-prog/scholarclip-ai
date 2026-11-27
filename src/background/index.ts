/**
 * Background Service Worker
 * - 代理 LLM 与 Notion API 请求（扩展后台不受页面 CORS 限制）
 * - 读取 chrome.storage.local 中的密钥，密钥不会经过 popup 消息传递
 */
import { AppError, serializeError } from '../lib/errors';
import { summarizePage, testLlm } from '../lib/llm';
import type { Request, Response, ResponseMap } from '../lib/messages';
import { createPaperPage, fetchDatabaseSchema } from '../lib/notion';
import { getDraft, getSettings, missingLlmSettings, missingNotionSettings, saveDraft } from '../lib/storage';
import type { ConnectionReport, Draft } from '../lib/types';

async function handle(req: Request): Promise<ResponseMap[Request['type']]> {
  const settings = await getSettings();

  switch (req.type) {
    case 'SUMMARIZE': {
      const missing = missingLlmSettings(settings);
      if (missing.length) throw new AppError(`请先在设置页填写：${missing.join('、')}`, 'CONFIG_MISSING');
      const summary = await summarizePage(settings, req.page);
      const draft: Draft = { url: req.page.url, summary, createdAt: Date.now() };
      // 写入 session 草稿：即使 popup 在等待期间被关闭，下次打开也能恢复结果
      await saveDraft(draft);
      return draft;
    }

    case 'SAVE_TO_NOTION': {
      const missing = missingNotionSettings(settings);
      if (missing.length) throw new AppError(`请先在设置页填写：${missing.join('、')}`, 'CONFIG_MISSING');
      const result = await createPaperPage(settings, req.summary, req.url);
      const existing = await getDraft(req.url);
      await saveDraft({
        url: req.url,
        summary: req.summary,
        createdAt: existing?.createdAt ?? Date.now(),
        notionPageUrl: result.pageUrl,
      });
      return result;
    }

    case 'TEST_CONNECTION': {
      const report: ConnectionReport = {
        llm: { ok: false, message: '' },
        notion: { ok: false, message: '' },
      };
      const llmMissing = missingLlmSettings(settings);
      const notionMissing = missingNotionSettings(settings);

      await Promise.all([
        (async () => {
          if (llmMissing.length) {
            report.llm = { ok: false, message: `未填写：${llmMissing.join('、')}` };
            return;
          }
          try {
            report.llm = { ok: true, message: await testLlm(settings) };
          } catch (e) {
            report.llm = { ok: false, message: serializeError(e).message };
          }
        })(),
        (async () => {
          if (notionMissing.length) {
            report.notion = { ok: false, message: `未填写：${notionMissing.join('、')}` };
            return;
          }
          try {
            const schema = await fetchDatabaseSchema(settings);
            const problems = schema.report.filter((f) => !f.ok);
            report.notion = {
              ok: !problems.some((f) => f.required),
              databaseTitle: schema.databaseTitle,
              fields: schema.report,
              message: problems.length
                ? `已连接「${schema.databaseTitle}」，${problems.length} 个推荐字段缺失或类型不符（可正常保存，相关字段会被跳过）`
                : `已连接「${schema.databaseTitle}」，所有字段校验通过`,
            };
          } catch (e) {
            report.notion = { ok: false, message: serializeError(e).message };
          }
        })(),
      ]);
      return report;
    }
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
  // 只接受来自本扩展页面的消息
  if (sender.id !== chrome.runtime.id) return false;
  handle(req)
    .then((data) => sendResponse({ ok: true, data } satisfies Response<typeof data>))
    .catch((err: unknown) => {
      console.error('[ScholarClip]', err);
      sendResponse({ ok: false, error: serializeError(err) } satisfies Response<never>);
    });
  return true; // 保持异步响应通道
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
