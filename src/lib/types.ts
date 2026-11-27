/** 用户配置（保存在 chrome.storage.local） */
export type OutputLanguage = 'zh' | 'en';

export interface Settings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  outputLanguage: OutputLanguage;
  notionToken: string;
  notionDatabaseId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  outputLanguage: 'zh',
  notionToken: '',
  notionDatabaseId: '',
};

/** 网页来源识别 */
export type SourceKind = 'arxiv' | 'scholar' | 'ieee' | 'acm' | 'academic' | 'generic' | 'unsupported';

/** 页面元数据（citation_* / dc.* / og:* 等标签与站点专用提取器的合并结果） */
export interface PageMeta {
  title?: string;
  authors?: string[];
  publicationDate?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  pdfUrl?: string;
  publisher?: string;
  keywords?: string[];
  siteName?: string;
  description?: string;
}

/** 从当前标签页提取出的内容 */
export interface ExtractedPage {
  url: string;
  pageTitle: string;
  source: SourceKind;
  meta: PageMeta;
  /** 已截断到 12000 字符的正文 */
  text: string;
  /** 用户在页面上选中的文本（优先作为正文） */
  usedSelection: boolean;
}

/** LLM 输出（与 Prompt 中的 Output JSON Schema 一一对应） */
export interface PaperSummary {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi_or_id: string | null;
  tags: string[];
  tldr: string;
  research_problem: string;
  methodology: string;
  key_findings: string[];
  limitations: string;
  citations: {
    apa7: string;
    ieee: string;
  };
}

/** 草稿：AI 结果 + 页面信息，供 popup 关闭重开后恢复 */
export interface Draft {
  url: string;
  summary: PaperSummary;
  createdAt: number;
  notionPageUrl?: string;
}

/** Notion 数据库字段校验报告 */
export interface FieldCheck {
  logical: string;
  /** 数据库中实际匹配到的属性名 */
  matchedName: string | null;
  type: string | null;
  required: boolean;
  ok: boolean;
  note?: string;
}

export interface ConnectionReport {
  llm: { ok: boolean; message: string };
  notion: { ok: boolean; message: string; databaseTitle?: string; fields?: FieldCheck[] };
}
