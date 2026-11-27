import { Readability } from '@mozilla/readability';
import { AppError } from './errors';
import { truncate } from './text';
import type { ExtractedPage, PageMeta, SourceKind } from './types';

interface RawPage {
  html: string;
  url: string;
  title: string;
  selection: string;
}

/**
 * 注入到目标页面执行的函数。必须完全自包含（不能引用外部变量），
 * 只返回可序列化的原始数据；解析工作在 popup 中完成，避免单独打包 content script。
 */
function grabPage(): RawPage {
  return {
    html: document.documentElement.outerHTML,
    url: location.href,
    title: document.title,
    selection: String(window.getSelection?.() ?? '').trim(),
  };
}

export function detectSource(url: string, doc?: Document): SourceKind {
  let host = '';
  let protocol = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    return 'unsupported';
  }
  if (!/^https?:$/.test(protocol)) return 'unsupported';
  if (/(^|\.)arxiv\.org$/.test(host)) return 'arxiv';
  if (/^scholar\.google\./.test(host)) return 'scholar';
  if (host === 'ieeexplore.ieee.org') return 'ieee';
  if (host === 'dl.acm.org') return 'acm';
  if (doc?.querySelector('meta[name="citation_title"], meta[name="dc.Title" i], meta[name="DC.title" i]')) {
    return 'academic';
  }
  return 'generic';
}

export const SOURCE_LABEL: Record<SourceKind, string> = {
  arxiv: 'arXiv',
  scholar: 'Google Scholar',
  ieee: 'IEEE Xplore',
  acm: 'ACM DL',
  academic: '学术网页',
  generic: '普通网页',
  unsupported: '不支持的页面',
};

// ---------------------------------------------------------------------------
// Meta 标签提取
// ---------------------------------------------------------------------------

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function metaAll(doc: Document, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    doc.querySelectorAll('meta').forEach((m) => {
      const key = (m.getAttribute('name') ?? m.getAttribute('property') ?? '').toLowerCase();
      if (key === lower) {
        const v = clean(m.getAttribute('content'));
        if (v) out.push(v);
      }
    });
  }
  return out;
}

const metaOne = (doc: Document, ...names: string[]) => metaAll(doc, ...names)[0];

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Highwire Press (citation_*)、Dublin Core、PRISM、Open Graph 通用提取 */
function extractGenericMeta(doc: Document): PageMeta {
  const authors = metaAll(doc, 'citation_author', 'dc.creator', 'DC.creator', 'author');
  const keywords = metaAll(doc, 'citation_keywords', 'keywords', 'dc.subject')
    .flatMap((k) => k.split(/[;,]/))
    .map(clean)
    .filter(Boolean);
  const rawDoi = metaOne(doc, 'citation_doi', 'prism.doi') ??
    metaAll(doc, 'dc.identifier')
      .map((id) => id.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, '').trim())
      .find((id) => /^10\.\d{4,9}\/\S+$/.test(id));
  return {
    title: metaOne(doc, 'citation_title', 'dc.title', 'og:title'),
    authors: authors.length ? dedupe(authors) : undefined,
    publicationDate: metaOne(
      doc,
      'citation_publication_date',
      'citation_date',
      'citation_online_date',
      'dc.date',
      'prism.publicationDate',
      'article:published_time',
    ),
    venue: metaOne(
      doc,
      'citation_journal_title',
      'citation_conference_title',
      'citation_inbook_title',
      'prism.publicationName',
      'dc.source',
    ),
    doi: rawDoi?.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, ''),
    arxivId: metaOne(doc, 'citation_arxiv_id'),
    abstract: metaOne(doc, 'citation_abstract', 'dc.description'),
    pdfUrl: metaOne(doc, 'citation_pdf_url'),
    publisher: metaOne(doc, 'citation_publisher', 'dc.publisher'),
    keywords: keywords.length ? dedupe(keywords).slice(0, 15) : undefined,
    siteName: metaOne(doc, 'og:site_name'),
    description: metaOne(doc, 'description', 'og:description'),
  };
}

function extractArxiv(doc: Document, url: string): Partial<PageMeta> {
  const idMatch = url.match(/arxiv\.org\/(?:abs|html|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?(?:[?#]|$)/i);
  const abs = doc.querySelector('blockquote.abstract');
  return {
    arxivId: idMatch?.[1],
    abstract: abs ? clean(abs.textContent).replace(/^Abstract:\s*/i, '') : undefined,
    venue: 'arXiv',
  };
}

/** Google Scholar 是搜索结果页：仅提取第一条结果，避免拼接多篇论文导致模型跨论文串台幻觉 */
function extractScholar(doc: Document): { meta: Partial<PageMeta>; text: string } {
  const results = Array.from(doc.querySelectorAll('.gs_r.gs_or, .gs_ri')).slice(0, 5);
  for (const r of results) {
    const title = clean(r.querySelector('.gs_rt')?.textContent);
    if (!title) continue;
    const by = clean(r.querySelector('.gs_a')?.textContent);
    const snippet = clean(r.querySelector('.gs_rs')?.textContent);
    // .gs_a 格式通常为 "作者 - 期刊, 年份 - 出版方"
    const [authorPart, venuePart] = by.split(' - ');
    const first: Partial<PageMeta> = {
      title: title.replace(/^\[[A-Z]+\]\s*/, ''),
      authors: authorPart?.split(',').map(clean).filter((a) => a && a !== '…'),
      venue: venuePart?.replace(/,\s*\d{4}$/, '').trim() || undefined,
      publicationDate: by.match(/\b(19|20)\d{2}\b/)?.[0],
      abstract: snippet || undefined,
    };
    return {
      meta: first,
      text: `Title: ${first.title}\nCitation Info: ${by}\nSnippet: ${snippet}`,
    };
  }
  return { meta: {}, text: '' };
}

/** IEEE Xplore 将完整元数据放在 xplGlobal.document.metadata 中 */
function extractIeee(html: string): Partial<PageMeta> {
  const m = html.match(/xplGlobal\.document\.metadata\s*=\s*(\{[\s\S]*?\});\s*(?:\n|<\/script>)/);
  if (!m) return {};
  try {
    const d = JSON.parse(m[1]) as {
      title?: string;
      authors?: { name?: string }[];
      publicationYear?: string;
      publicationDate?: string;
      doi?: string;
      abstract?: string;
      publicationTitle?: string;
      displayPublicationTitle?: string;
      publisher?: string;
      keywords?: { kwd?: string[] }[];
    };
    return {
      title: d.title ? clean(d.title) : undefined,
      authors: d.authors?.map((a) => clean(a.name)).filter(Boolean),
      publicationDate: d.publicationYear ?? d.publicationDate,
      doi: d.doi,
      abstract: d.abstract ? clean(d.abstract) : undefined,
      venue: d.displayPublicationTitle ?? d.publicationTitle,
      publisher: d.publisher,
      keywords: d.keywords?.flatMap((k) => k.kwd ?? []).slice(0, 15),
    };
  } catch {
    return {};
  }
}

function extractAcm(doc: Document): Partial<PageMeta> {
  const abs = doc.querySelector('section#abstract, div.abstractSection, [role="paragraph"].abstractInFull');
  const authors = Array.from(doc.querySelectorAll('.loa__author-name, [property="author"] [property="name"]'))
    .map((e) => clean(e.textContent))
    .filter(Boolean);
  return {
    abstract: abs ? clean(abs.textContent).replace(/^Abstract\s*/i, '') : undefined,
    authors: authors.length ? dedupe(authors) : undefined,
  };
}

const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** 合并：后者仅在前者缺失时补位（不覆盖已有字段） */
export function mergeMeta(base: PageMeta, extra: Partial<PageMeta>): PageMeta {
  const out: PageMeta = { ...base };
  (Object.keys(extra) as (keyof PageMeta)[]).forEach((k) => {
    const v = extra[k];
    if (!isEmptyValue(v) && isEmptyValue(out[k])) {
      (out as Record<string, unknown>)[k] = v;
    }
  });
  return out;
}

function stripEmpty(meta: PageMeta): PageMeta {
  const out: PageMeta = {};
  (Object.entries(meta) as [keyof PageMeta, unknown][]).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return;
    (out as Record<string, unknown>)[k] = v;
  });
  return out;
}

function readabilityText(doc: Document): string {
  try {
    const article = new Readability(doc, { charThreshold: 300 }).parse();
    const text = article?.textContent ?? '';
    return text.replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  } catch {
    return '';
  }
}


// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export function parsePage(raw: RawPage): ExtractedPage {
  const doc = new DOMParser().parseFromString(raw.html, 'text/html');
  // 让 Readability 正确解析相对链接
  const base = doc.createElement('base');
  base.href = raw.url;
  doc.head?.prepend(base);

  const source = detectSource(raw.url, doc);
  let meta = extractGenericMeta(doc);
  let siteText = '';

  switch (source) {
    case 'arxiv':
      meta = mergeMeta(meta, extractArxiv(doc, raw.url));
      break;
    case 'scholar': {
      const s = extractScholar(doc);
      meta = mergeMeta(s.meta, meta);
      siteText = s.text;
      break;
    }
    case 'ieee':
      // IEEE 页面内置的 xplGlobal.document.metadata 比通用 meta 更完整，优先使用
      meta = mergeMeta(extractIeee(raw.html), meta);
      break;
    case 'acm':
      meta = mergeMeta(meta, extractAcm(doc));
      break;
    default:
      break;
  }
  meta = stripEmpty(meta);

  const usedSelection = raw.selection.length >= 200;
  let body: string;
  if (usedSelection) {
    body = raw.selection;
  } else if (siteText) {
    body = siteText;
  } else {
    body = readabilityText(doc) || clean(doc.body?.textContent);
  }

  // 摘要放在正文最前面，保证截断后关键信息仍在
  const parts: string[] = [];
  if (meta.abstract && !body.includes(meta.abstract.slice(0, 80))) parts.push(`Abstract: ${meta.abstract}`);
  parts.push(body);
  const text = truncate(parts.join('\n\n'));

  // 防止仅有标题而无正文（如付费墙/未加载完页面）发送给 LLM 诱发凭标题胡编
  if (text.replace(/\s/g, '').length < 80) {
    throw new AppError(
      '当前页面提取到的有效正文过少（可能是付费墙或页面尚未加载完成）。为防止 AI 凭标题编造内容，请等待页面加载完成或手动选中正文后重试',
      'EXTRACT_FAILED',
    );
  }

  return {
    url: raw.url,
    pageTitle: raw.title,
    source,
    meta,
    text,
    usedSelection,
  };
}

/** 从当前激活标签页提取内容（依赖 activeTab + scripting 权限，需由用户点击触发） */
export async function extractFromTab(tabId: number, url: string): Promise<ExtractedPage> {
  if (/\.pdf($|[?#])/i.test(url) || /arxiv\.org\/pdf\//i.test(url)) {
    const absHint = url.match(/arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?$/i);
    throw new AppError(
      absHint
        ? `暂不支持直接解析 PDF，请打开论文摘要页：https://arxiv.org/abs/${absHint[1]}`
        : '暂不支持直接解析 PDF 页面，请打开论文的 HTML 摘要页后重试',
      'EXTRACT_FAILED',
    );
  }
  let results: chrome.scripting.InjectionResult<RawPage>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func: grabPage });
  } catch (e) {
    throw new AppError(
      '无法读取此页面（浏览器内置页、扩展商店页面等受保护页面不允许插件访问）',
      'EXTRACT_FAILED',
      e instanceof Error ? e.message : String(e),
    );
  }
  const raw = results?.[0]?.result;
  if (!raw) throw new AppError('页面内容读取失败，请刷新页面后重试', 'EXTRACT_FAILED');
  return parsePage(raw);
}
