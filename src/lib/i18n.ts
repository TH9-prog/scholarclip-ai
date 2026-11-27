export type UiLanguage = 'zh' | 'en';

const STORAGE_KEY = 'uiLanguage';

/** 根据浏览器界面语言自动判断默认显示语言（中文环境返回 zh，其余返回 en） */
export function detectBrowserLanguage(rawLang?: string): UiLanguage {
  const lang =
    rawLang ??
    (typeof chrome !== 'undefined' ? chrome.i18n?.getUILanguage?.() : undefined) ??
    (typeof navigator !== 'undefined' ? navigator.language : undefined) ??
    'en';
  return /^zh(?:[-_]|$)/i.test(lang.trim()) ? 'zh' : 'en';
}

export async function getUiLanguage(): Promise<UiLanguage> {
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY)) as { uiLanguage?: UiLanguage };
    if (stored.uiLanguage === 'zh' || stored.uiLanguage === 'en') return stored.uiLanguage;
  } catch {
    /* ignore storage errors and fall back to browser language */
  }
  return detectBrowserLanguage();
}

export async function saveUiLanguage(lang: UiLanguage): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: lang });
}

export interface OptionsStrings {
  pageTitle: string;
  headerTitle: string;
  headerSubtitle: string;
  langToggleAria: string;
  showSecret: string;
  hideSecret: string;
  llmSection: string;
  llmBaseUrlLabel: string;
  llmBaseUrlHint: string;
  llmApiKeyLabel: string;
  llmModelLabel: string;
  outputLanguageLabel: string;
  notionSection: string;
  notionTokenLabel: string;
  notionTokenHint: string;
  notionTokenPlaceholder: string;
  notionDbIdLabel: string;
  notionDbIdHint: string;
  notionDbIdPlaceholder: string;
  notionRecommendedPrefix: string;
  notionRecommendedFields: string;
  notionRecommendedAliases: string;
  notionConnectTip: string;
  saveBtn: string;
  testBtn: string;
  savedBadge: string;
  reportLlmTitle: string;
  reportNotionTitle: string;
  tableField: string;
  tableProperty: string;
  tableType: string;
  tableStatus: string;
  statusMatched: string;
  technicalDetails: string;
  errInvalidBaseUrl: string;
  errInvalidDbId: string;
  errPermissionDenied: (pattern: string) => string;
}

export const OPTIONS_STRINGS: Record<UiLanguage, OptionsStrings> = {
  zh: {
    pageTitle: 'ScholarClip AI · 设置',
    headerTitle: 'ScholarClip AI · 设置',
    headerSubtitle: '所有配置仅保存在本机 chrome.storage.local，插件直接与你配置的 API 通信，不经过任何第三方服务器。',
    langToggleAria: '切换界面语言（中文 / English）',
    showSecret: '显示',
    hideSecret: '隐藏',
    llmSection: '大模型（OpenAI 兼容格式）',
    llmBaseUrlLabel: 'API Base URL',
    llmBaseUrlHint: '如 https://api.openai.com/v1、https://api.deepseek.com/v1',
    llmApiKeyLabel: 'API Key',
    llmModelLabel: '模型名称',
    outputLanguageLabel: '总结输出语言',
    notionSection: 'Notion',
    notionTokenLabel: 'Integration Token',
    notionTokenHint: '在 notion.so/my-integrations 创建',
    notionTokenPlaceholder: 'ntn_... 或 secret_...',
    notionDbIdLabel: 'Database ID',
    notionDbIdHint: '可直接粘贴数据库链接',
    notionDbIdPlaceholder: 'https://www.notion.so/xxx?v=... 或 32 位 ID',
    notionRecommendedPrefix: '推荐数据库属性：',
    notionRecommendedFields: 'Title（标题）、Authors（文本 / 多选）、Year（数字）、URL（网址）、Tags（多选）、Citation（文本）；可选 Venue、DOI。',
    notionRecommendedAliases: '也支持中文属性名：标题、作者、年份、链接、标签、引用。',
    notionConnectTip: '记得在数据库右上角「··· → 连接」中添加你的 Integration。',
    saveBtn: '保存',
    testBtn: '测试连接并校验数据库字段',
    savedBadge: '✓ 已保存',
    reportLlmTitle: '大模型',
    reportNotionTitle: 'Notion',
    tableField: '字段',
    tableProperty: '数据库属性',
    tableType: '类型',
    tableStatus: '状态',
    statusMatched: '✓ 匹配',
    technicalDetails: '技术详情',
    errInvalidBaseUrl: 'LLM API Base URL 格式不正确，应形如 https://api.openai.com/v1',
    errInvalidDbId: 'Notion Database ID 格式不正确，请粘贴 32 位 ID 或数据库链接',
    errPermissionDenied: (pattern: string) =>
      `已保存，但未授予 ${pattern} 的访问权限。若该服务不支持跨域请求，AI 提取将失败；可再次点击保存并允许访问。`,
  },
  en: {
    pageTitle: 'ScholarClip AI · Settings',
    headerTitle: 'ScholarClip AI · Settings',
    headerSubtitle:
      'All settings are stored locally in chrome.storage.local. Requests go directly from your browser to your configured APIs with no intermediary server.',
    langToggleAria: 'Switch interface language (Chinese / English)',
    showSecret: 'Show',
    hideSecret: 'Hide',
    llmSection: 'LLM (OpenAI-Compatible API)',
    llmBaseUrlLabel: 'API Base URL',
    llmBaseUrlHint: 'e.g. https://api.openai.com/v1, https://api.deepseek.com/v1',
    llmApiKeyLabel: 'API Key',
    llmModelLabel: 'Model Name',
    outputLanguageLabel: 'Summary Output Language',
    notionSection: 'Notion',
    notionTokenLabel: 'Integration Token',
    notionTokenHint: 'Create at notion.so/my-integrations',
    notionTokenPlaceholder: 'ntn_... or secret_...',
    notionDbIdLabel: 'Database ID',
    notionDbIdHint: 'Paste the database URL or 32-char ID',
    notionDbIdPlaceholder: 'https://www.notion.so/xxx?v=... or 32-char ID',
    notionRecommendedPrefix: 'Recommended properties: ',
    notionRecommendedFields: 'Title, Authors (Text / Multi-select), Year (Number), URL, Tags (Multi-select), Citation (Text); optional Venue, DOI.',
    notionRecommendedAliases: 'Chinese property aliases are also supported.',
    notionConnectTip: 'Remember to connect your Integration via "··· → Connections" in the top-right menu of your Notion database.',
    saveBtn: 'Save',
    testBtn: 'Test Connection & Verify Schema',
    savedBadge: '✓ Saved',
    reportLlmTitle: 'LLM',
    reportNotionTitle: 'Notion',
    tableField: 'Field',
    tableProperty: 'Property',
    tableType: 'Type',
    tableStatus: 'Status',
    statusMatched: '✓ Matched',
    technicalDetails: 'Technical details',
    errInvalidBaseUrl: 'Invalid LLM API Base URL. Expected format: https://api.openai.com/v1',
    errInvalidDbId: 'Invalid Notion Database ID. Paste a 32-character ID or the full database URL.',
    errPermissionDenied: (pattern: string) =>
      `Settings saved, but host permission for ${pattern} was not granted. If the endpoint blocks CORS, AI extraction will fail; click Save again and allow access.`,
  },
};
