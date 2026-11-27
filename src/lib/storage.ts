import { DEFAULT_SETTINGS, type Draft, type Settings } from './types';

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get('settings')) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

/** 草稿保存在 storage.session：浏览器关闭即清除，且不会落盘 */
const draftKey = (url: string) => `draft:${normalizeUrl(url)}`;

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export async function getDraft(url: string): Promise<Draft | null> {
  const key = draftKey(url);
  const data = await chrome.storage.session.get(key);
  return (data[key] as Draft | undefined) ?? null;
}

export async function saveDraft(draft: Draft): Promise<void> {
  await chrome.storage.session.set({ [draftKey(draft.url)]: draft });
}

export async function clearDraft(url: string): Promise<void> {
  await chrome.storage.session.remove(draftKey(url));
}

/** 判断配置是否完整，返回缺失项的中文描述 */
export function missingLlmSettings(s: Settings): string[] {
  const missing: string[] = [];
  if (!s.llmBaseUrl.trim()) missing.push('LLM API Base URL');
  if (!s.llmApiKey.trim()) missing.push('LLM API Key');
  if (!s.llmModel.trim()) missing.push('模型名称');
  return missing;
}

export function missingNotionSettings(s: Settings): string[] {
  const missing: string[] = [];
  if (!s.notionToken.trim()) missing.push('Notion Integration Token');
  if (!s.notionDatabaseId.trim()) missing.push('Notion Database ID');
  return missing;
}
