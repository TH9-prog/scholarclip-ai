import { AppError } from './errors';
import type { FieldCheck, OutputLanguage, PaperSummary, Settings } from './types';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const RICH_TEXT_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Notion API 基础封装
// ---------------------------------------------------------------------------

interface NotionErrorBody {
  object?: 'error';
  status?: number;
  code?: string;
  message?: string;
}

/** 接受 32 位 ID、带横线 UUID，或直接粘贴的数据库链接 */
export function parseDatabaseId(input: string): string | null {
  const raw = input.trim();
  let candidate = raw;
  try {
    const u = new URL(raw);
    candidate = u.pathname; // 忽略 ?v=<viewId>
  } catch {
    /* 不是 URL */
  }
  const m = candidate.replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function notionFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    throw new AppError('无法连接到 Notion，请检查网络', 'NOTION_NETWORK', e instanceof Error ? e.message : String(e));
  }
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => ({}))) as NotionErrorBody;
  const detail = `${res.status} ${body.code ?? ''}: ${body.message ?? ''}`;
  if (res.status === 401 || body.code === 'unauthorized') {
    throw new AppError('Notion Token 无效，请在设置页检查 Integration Token', 'NOTION_AUTH', detail);
  }
  if (res.status === 403 || body.code === 'restricted_resource') {
    throw new AppError('Integration 无权访问该数据库，请在 Notion 中将数据库「连接」给你的 Integration', 'NOTION_AUTH', detail);
  }
  if (res.status === 404 || body.code === 'object_not_found') {
    throw new AppError(
      '找不到该 Notion 数据库：请确认 Database ID 正确，并已在数据库右上角「···→ 连接」中添加你的 Integration',
      'NOTION_NOT_FOUND',
      detail,
    );
  }
  if (res.status === 400 && body.code === 'validation_error') {
    throw new AppError(
      `Notion 字段不匹配：${body.message ?? ''}。请在设置页点击「测试连接并校验数据库字段」查看详情`,
      'NOTION_FIELD_MISMATCH',
      detail,
    );
  }
  if (res.status === 429) throw new AppError('Notion 请求过于频繁，请稍后再试', 'NOTION_HTTP', detail);
  throw new AppError(`Notion 请求失败（HTTP ${res.status}）：${body.message ?? ''}`, 'NOTION_HTTP', detail);
}

// ---------------------------------------------------------------------------
// 数据库字段校验与映射
// ---------------------------------------------------------------------------

interface DatabaseProperty {
  id: string;
  name: string;
  type: string;
}

interface DatabaseResponse {
  id: string;
  title?: { plain_text: string }[];
  properties: Record<string, DatabaseProperty>;
}

type LogicalField = 'Title' | 'Authors' | 'Year' | 'URL' | 'Tags' | 'Citation' | 'Venue' | 'DOI';

interface FieldSpec {
  logical: LogicalField;
  aliases: string[];
  types: string[];
  required: boolean;
  /** 推荐字段：缺失时在校验报告中提示；非推荐字段缺失时静默跳过 */
  recommended: boolean;
}

/** 允许的属性名（不区分大小写，含中文别名）与类型 */
const FIELD_SPECS: FieldSpec[] = [
  { logical: 'Title', aliases: ['title', 'name', '标题', '名称', '论文标题'], types: ['title'], required: true, recommended: true },
  { logical: 'Authors', aliases: ['authors', 'author', '作者'], types: ['rich_text', 'multi_select'], required: false, recommended: true },
  { logical: 'Year', aliases: ['year', '年份', '发表年份'], types: ['number', 'rich_text', 'select', 'date'], required: false, recommended: true },
  { logical: 'URL', aliases: ['url', 'link', '链接', '网址'], types: ['url', 'rich_text'], required: false, recommended: true },
  { logical: 'Tags', aliases: ['tags', 'tag', 'keywords', '标签', '关键词'], types: ['multi_select', 'rich_text'], required: false, recommended: true },
  { logical: 'Citation', aliases: ['citation', 'citations', 'reference', '引用', '参考文献'], types: ['rich_text'], required: false, recommended: true },
  { logical: 'Venue', aliases: ['venue', 'journal', 'conference', '期刊', '会议', '发表于'], types: ['rich_text', 'select'], required: false, recommended: false },
  { logical: 'DOI', aliases: ['doi', 'doi_or_id', 'arxiv id', 'id'], types: ['rich_text', 'url'], required: false, recommended: false },
];

export interface FieldMapping {
  logical: LogicalField;
  name: string;
  type: string;
}

export interface SchemaCheck {
  databaseTitle: string;
  mappings: FieldMapping[];
  report: FieldCheck[];
}

export function checkSchema(db: DatabaseResponse): SchemaCheck {
  const props = Object.values(db.properties);
  const mappings: FieldMapping[] = [];
  const report: FieldCheck[] = [];

  for (const spec of FIELD_SPECS) {
    // 标题属性每个数据库有且只有一个，名称任意
    const byName =
      spec.logical === 'Title'
        ? props.find((p) => p.type === 'title')
        : props.find((p) => spec.aliases.includes(p.name.trim().toLowerCase()));

    if (!byName) {
      if (spec.recommended) {
        report.push({
          logical: spec.logical,
          matchedName: null,
          type: null,
          required: spec.required,
          ok: false,
          note: `未找到，建议新建名为「${spec.logical}」的属性（类型：${spec.types.join(' / ')}），否则该字段将被跳过`,
        });
      }
      continue;
    }
    if (!spec.types.includes(byName.type)) {
      report.push({
        logical: spec.logical,
        matchedName: byName.name,
        type: byName.type,
        required: spec.required,
        ok: false,
        note: `类型为 ${byName.type}，需要 ${spec.types.join(' / ')}，该字段将被跳过`,
      });
      continue;
    }
    mappings.push({ logical: spec.logical, name: byName.name, type: byName.type });
    report.push({ logical: spec.logical, matchedName: byName.name, type: byName.type, required: spec.required, ok: true });
  }

  return {
    databaseTitle: db.title?.map((t) => t.plain_text).join('') || '(未命名数据库)',
    mappings,
    report,
  };
}

export async function fetchDatabaseSchema(settings: Settings): Promise<SchemaCheck> {
  const id = parseDatabaseId(settings.notionDatabaseId);
  if (!id) {
    throw new AppError('Notion Database ID 格式不正确，请粘贴 32 位 ID 或数据库页面链接', 'CONFIG_MISSING');
  }
  const db = await notionFetch<DatabaseResponse>(settings.notionToken, `/databases/${id}`);
  return checkSchema(db);
}

// ---------------------------------------------------------------------------
// Properties 与 Page Body 构建
// ---------------------------------------------------------------------------

interface RichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
}

/** Notion 单个 rich_text 对象上限 2000 字符，超长自动切分 */
export function richText(content: string, link?: string): RichText[] {
  const chunks: RichText[] = [];
  const s = content ?? '';
  for (let i = 0; i < s.length; i += RICH_TEXT_LIMIT) {
    chunks.push({ type: 'text', text: { content: s.slice(i, i + RICH_TEXT_LIMIT), ...(link ? { link: { url: link } } : {}) } });
  }
  return chunks.length ? chunks.slice(0, 100) : [];
}

/** multi_select 选项名不能包含逗号，最长 100 字符 */
const optionName = (s: string) => s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

function propertyValue(m: FieldMapping, s: PaperSummary, url: string): unknown | undefined {
  const citationText = [s.citations.apa7 && `APA: ${s.citations.apa7}`, s.citations.ieee && `IEEE: ${s.citations.ieee}`]
    .filter(Boolean)
    .join('\n');

  const asText = (v: string) => (v ? { rich_text: richText(v) } : undefined);
  const asMulti = (arr: string[]) => {
    const opts = Array.from(new Set(arr.map(optionName).filter(Boolean))).slice(0, 100);
    return opts.length ? { multi_select: opts.map((name) => ({ name })) } : undefined;
  };

  switch (m.logical) {
    case 'Title':
      return { title: richText(s.title || '(无标题)').slice(0, 100) };
    case 'Authors':
      return m.type === 'multi_select' ? asMulti(s.authors) : asText(s.authors.join(', '));
    case 'Year':
      if (s.year == null) return undefined;
      if (m.type === 'number') return { number: s.year };
      if (m.type === 'select') return { select: { name: String(s.year) } };
      if (m.type === 'date') return { date: { start: `${s.year}-01-01` } };
      return asText(String(s.year));
    case 'URL':
      return m.type === 'url' ? { url } : asText(url);
    case 'Tags':
      return m.type === 'multi_select' ? asMulti(s.tags) : asText(s.tags.join(', '));
    case 'Citation':
      return asText(citationText);
    case 'Venue':
      if (!s.venue) return undefined;
      return m.type === 'select' ? { select: { name: optionName(s.venue) } } : asText(s.venue);
    case 'DOI': {
      if (!s.doi_or_id) return undefined;
      if (m.type === 'url') {
        const doiUrl = /^10\.\d+\//.test(s.doi_or_id) ? `https://doi.org/${s.doi_or_id}` : s.doi_or_id;
        return /^https?:\/\//.test(doiUrl) ? { url: doiUrl } : undefined;
      }
      return asText(s.doi_or_id);
    }
  }
}

export function buildProperties(mappings: FieldMapping[], s: PaperSummary, url: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const m of mappings) {
    const v = propertyValue(m, s, url);
    if (v !== undefined) props[m.name] = v;
  }
  return props;
}

const HEADINGS: Record<OutputLanguage, Record<string, string>> = {
  zh: {
    tldr: '一句话结论',
    problem: '研究问题',
    method: '研究方法',
    findings: '核心发现',
    limitations: '局限性与未来工作',
    citation: '引用',
    source: '原文链接',
  },
  en: {
    tldr: 'TL;DR',
    problem: 'Research Problem',
    method: 'Methodology',
    findings: 'Key Findings',
    limitations: 'Limitations & Future Work',
    citation: 'Citation',
    source: 'Source',
  },
};

const heading2 = (text: string) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: richText(text) } });
const paragraph = (text: string) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text) } });
const bullet = (text: string, link?: string) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: richText(text, link) },
});

export function buildBody(s: PaperSummary, url: string, lang: OutputLanguage): unknown[] {
  const h = HEADINGS[lang];
  const blocks: unknown[] = [];
  const section = (title: string, text: string) => {
    if (!text) return;
    blocks.push(heading2(title), paragraph(text));
  };

  if (s.tldr) {
    blocks.push({
      object: 'block',
      type: 'callout',
      callout: { rich_text: richText(s.tldr), icon: { type: 'emoji', emoji: '💡' }, color: 'gray_background' },
    });
  }
  section(h.problem, s.research_problem);
  section(h.method, s.methodology);
  if (s.key_findings.length) {
    blocks.push(heading2(h.findings), ...s.key_findings.map((f) => bullet(f)));
  }
  section(h.limitations, s.limitations);
  if (s.citations.apa7 || s.citations.ieee) {
    blocks.push(heading2(h.citation));
    if (s.citations.apa7) blocks.push(bullet(`APA 7th: ${s.citations.apa7}`));
    if (s.citations.ieee) blocks.push(bullet(`IEEE: ${s.citations.ieee}`));
  }
  blocks.push(heading2(h.source), bullet(url, url));
  return blocks.slice(0, 100);
}

interface CreatePageResponse {
  id: string;
  url: string;
}

export async function createPaperPage(
  settings: Settings,
  summary: PaperSummary,
  url: string,
): Promise<{ pageId: string; pageUrl: string }> {
  const schema = await fetchDatabaseSchema(settings);
  if (!schema.mappings.some((m) => m.logical === 'Title')) {
    throw new AppError('目标数据库没有标题（Title）属性，无法写入', 'NOTION_FIELD_MISMATCH');
  }
  const page = await notionFetch<CreatePageResponse>(settings.notionToken, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: parseDatabaseId(settings.notionDatabaseId) },
      icon: { type: 'emoji', emoji: '📄' },
      properties: buildProperties(schema.mappings, summary, url),
      children: buildBody(summary, url, settings.outputLanguage),
    }),
  });
  return { pageId: page.id, pageUrl: page.url };
}
