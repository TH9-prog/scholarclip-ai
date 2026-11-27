import { AppError } from './errors';
import { buildPrompt } from './prompt';
import type { ExtractedPage, PaperSummary, Settings } from './types';

const LLM_TIMEOUT_MS = 90_000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; type?: string; code?: string };
}

/** 兼容用户填 `https://x/v1` 或完整的 `https://x/v1/chat/completions` */
export function chatEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export function originPattern(baseUrl: string): string | null {
  try {
    return `${new URL(baseUrl.trim()).origin}/*`;
  } catch {
    return null;
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as ChatCompletionResponse;
    return j.error?.message ?? text;
  } catch {
    return text.slice(0, 500);
  }
}

function httpError(status: number, detail: string): AppError {
  if (status === 401 || status === 403)
    return new AppError('LLM API Key 无效或无权限，请在设置页检查 API Key', 'LLM_AUTH', detail);
  if (status === 404)
    return new AppError('LLM 接口或模型不存在，请检查 Base URL 与模型名称', 'LLM_NOT_FOUND', detail);
  if (status === 429)
    return new AppError('LLM 请求过于频繁或额度已用尽，请稍后再试', 'LLM_RATE_LIMIT', detail);
  if (status >= 500) return new AppError(`LLM 服务端错误（HTTP ${status}），请稍后再试`, 'LLM_HTTP', detail);
  return new AppError(`LLM 请求失败（HTTP ${status}）：${detail.slice(0, 200)}`, 'LLM_HTTP', detail);
}

interface ChatOptions {
  jsonMode?: boolean;
  maxTokens?: number;
  /** null = 不发送该参数（部分推理模型只接受默认温度） */
  temperature?: number | null;
}

interface ChatResult {
  content: string;
  finishReason?: string;
}

/** 内部调用：同时返回内容与 finish_reason，便于识别输出截断 */
async function chatWithMeta(settings: Settings, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: settings.llmModel.trim(),
    messages,
  };
  const temperature = opts.temperature === undefined ? 0.2 : opts.temperature;
  if (temperature !== null) body.temperature = temperature;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(chatEndpoint(settings.llmBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.llmApiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new AppError(`LLM 响应超时（>${LLM_TIMEOUT_MS / 1000}s），请稍后重试或换用更快的模型`, 'LLM_TIMEOUT');
    }
    const pattern = originPattern(settings.llmBaseUrl);
    const granted = pattern ? await chrome.permissions.contains({ origins: [pattern] }).catch(() => false) : false;
    throw new AppError(
      granted
        ? '无法连接到 LLM 服务，请检查网络或 Base URL 是否正确'
        : '无法连接到 LLM 服务：插件尚未获得该域名的访问授权，请在设置页重新保存配置并允许访问',
      granted ? 'LLM_NETWORK' : 'PERMISSION_DENIED',
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await readError(res);
    // 部分 OpenAI 兼容服务不支持 response_format / max_tokens / temperature，自动降级重试
    if (opts.jsonMode && res.status === 400 && /response_format|json_object|json mode/i.test(detail)) {
      return chatWithMeta(settings, messages, { ...opts, jsonMode: false });
    }
    if (res.status === 400 && opts.maxTokens && /max_tokens|max_completion_tokens/i.test(detail)) {
      return chatWithMeta(settings, messages, { ...opts, maxTokens: undefined });
    }
    if (res.status === 400 && temperature !== null && /temperature/i.test(detail)) {
      return chatWithMeta(settings, messages, { ...opts, temperature: null });
    }
    throw httpError(res.status, detail);
  }

  const data = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (!content || !content.trim()) {
    throw new AppError('LLM 返回了空内容，请重试或更换模型', 'LLM_EMPTY', JSON.stringify(data)?.slice(0, 500));
  }
  return { content, finishReason: choice?.finish_reason };
}

/** OpenAI 兼容的 /chat/completions 调用 */
export async function chat(settings: Settings, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  return (await chatWithMeta(settings, messages, opts)).content;
}

// ---------------------------------------------------------------------------
// JSON 严格解析与字段规范化
// ---------------------------------------------------------------------------

/**
 * 去除思考段、剥离最外层围栏，并用字符串感知的平衡括号扫描提取最可靠的 JSON 对象。
 * 避免字段值包含 ``` 或前后说明含 {note} 时截断/错位。
 */
export function extractJsonObject(raw: string): unknown {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 若存在未闭合的 <think>，且之后没有 </think>，直接丢弃 <think> 标签前导
  if (/^<think>/i.test(s)) {
    const endThink = s.search(/<\/think>/i);
    s = endThink !== -1 ? s.slice(endThink + '</think>'.length).trim() : s.replace(/^<think>/i, '').trim();
  }
  // 仅剥离包裹整段输出的最外层 ```json ... ``` 围栏，避免被字段内部代码块截断
  const outerFence = s.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (outerFence) s = outerFence[1].trim();

  const candidates = extractBalancedJsonObjects(s);
  if (candidates.length === 0) throw new Error('响应中未找到 JSON 对象');

  // 优先尝试包含 "title" 的候选对象，其次按长度降序尝试
  const ordered = [...candidates].sort((a, b) => {
    const aHas = /"title"\s*:/.test(a) ? 1 : 0;
    const bHas = /"title"\s*:/.test(b) ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.length - a.length;
  });

  let lastErr: unknown = null;
  for (const body of ordered) {
    try {
      return JSON.parse(body);
    } catch {
      try {
        return JSON.parse(sanitizeJsonCandidate(body));
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('响应中的 JSON 无法解析');
}

/** 使用字符串状态机扫描所有顶层平衡的 `{ ... }` 片段 */
function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

/**
 * 字符串感知的 JSON 轻度容错清洗：
 * 1. 仅在字符串字面量内部转义所有 U+0000–U+001F 控制字符（\n/\r/\t/\b/\f 等）
 * 2. 仅在字符串字面量外部移除对象/数组末尾多余逗号，绝不篡改字符串内的 ", ]" / ", }"
 */
function sanitizeJsonCandidate(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    const code = ch.charCodeAt(0);
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (ch === '\b') out += '\\b';
        else if (ch === '\f') out += '\\f';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === ',') {
        // 向前窥视：若逗号后仅跟空白与 } 或 ]，则为非法尾逗号，跳过
        let j = i + 1;
        while (j < json.length && /\s/.test(json[j])) j++;
        if (j < json.length && (json[j] === '}' || json[j] === ']')) {
          continue;
        }
        out += ch;
      } else {
        out += ch;
      }
    }
  }
  return out;
}

const NULL_PLACEHOLDER_RE =
  /^(null|n\/a|na|unknown|none|nil|not available|not explicitly stated|not stated|not mentioned|not specified|未提及|未说明|未知|无|暂无|-+|—+)$/i;

/** 将任意值安全转为字符串；对象优先提取常见文本字段，绝不输出 "[object Object]" */
const str = (v: unknown): string => {
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const key of ['name', 'full_name', 'text', 'value', 'point', 'finding', 'summary', 'title']) {
      if (typeof o[key] === 'string' && o[key].trim()) return o[key].trim();
    }
    return '';
  }
  return '';
};

const strOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s && !NULL_PLACEHOLDER_RE.test(s) ? s : null;
};

const strArray = (v: unknown, splitter = /[,;，；、]/): string[] => {
  if (Array.isArray(v)) return v.map(str).filter((x) => x && !NULL_PLACEHOLDER_RE.test(x));
  if (typeof v === 'string') {
    return v
      .split(splitter)
      .map((x) => x.trim())
      .filter((x) => x && !NULL_PLACEHOLDER_RE.test(x));
  }
  return [];
};

/** 作者列表专用拆分：优先按分号/顿号/换行拆分，避免破坏 "Last, First" 格式 */
const authorArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return strArray(v);
  if (typeof v === 'string') {
    const hasStrongSep = /[;；、\n]/.test(v);
    return strArray(v, hasStrongSep ? /[;；、\n]+/ : /[,，]+/);
  }
  return [];
};

/** 仅剥离真正的列表项目符号/编号前缀，绝不误删 "28.4 BLEU" 这类量化指标开头 */
const stripListPrefix = (x: string): string =>
  x
    .replace(/^\s*(?:[-*•▪▸►]\s+|(?:\(\d+\)|\[\d+\]|\d+[.)、])\s+)/, '')
    .trim();

export function normalizeSummary(input: unknown): PaperSummary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('JSON 顶层不是对象');
  }
  const o = input as Record<string, unknown>;
  const yearRaw = o.year;
  let year: number | null = null;
  if (typeof yearRaw === 'number' && Number.isFinite(yearRaw)) {
    const y = Math.trunc(yearRaw);
    if (y >= 1800 && y <= 2100) year = y;
  } else if (typeof yearRaw === 'string') {
    const m = yearRaw.match(/\b(1[89]|20|21)\d{2}\b/);
    const y = m ? Number(m[0]) : NaN;
    if (y >= 1800 && y <= 2100) year = y;
  }
  const c = (o.citations && typeof o.citations === 'object' ? o.citations : {}) as Record<string, unknown>;

  const summary: PaperSummary = {
    title: str(o.title),
    authors: authorArray(o.authors),
    year,
    venue: strOrNull(o.venue),
    doi_or_id: strOrNull(o.doi_or_id),
    tags: strArray(o.tags).slice(0, 8),
    tldr: str(o.tldr),
    research_problem: str(o.research_problem),
    methodology: str(o.methodology),
    key_findings: strArray(o.key_findings, /\n+/).map(stripListPrefix).filter(Boolean),
    limitations: str(o.limitations),
    citations: { apa7: str(c.apa7 ?? o.apa7), ieee: str(c.ieee ?? o.ieee) },
  };
  if (!summary.title) throw new Error('缺少必填字段 title');
  return summary;
}

/**
 * 主流程：构建 Prompt → 调用 LLM → 严格解析 JSON。
 * 若首次输出无法解析，会带上具体原因要求模型修正一次。
 */
export async function summarizePage(settings: Settings, page: ExtractedPage): Promise<PaperSummary> {
  const { system, user } = buildPrompt(page, settings.outputLanguage);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const first = await chatWithMeta(settings, messages, { jsonMode: true });
  try {
    return normalizeSummary(extractJsonObject(first.content));
  } catch (firstErr) {
    const truncatedHint =
      first.finishReason === 'length'
        ? ' Your previous response was truncated due to length limit, so keep every field concise to ensure the JSON closes completely.'
        : '';
    const retry = await chatWithMeta(
      settings,
      [
        ...messages,
        { role: 'assistant', content: first.content.slice(0, 2000) },
        {
          role: 'user',
          content: `Your previous output could not be parsed as a valid JSON object matching the schema.${truncatedHint} Return ONLY the complete, raw, valid JSON object with all quotes and newlines properly escaped, and no markdown code fences or extra text.`,
        },
      ],
      { jsonMode: true, temperature: 0 },
    );
    try {
      return normalizeSummary(extractJsonObject(retry.content));
    } catch (e) {
      throw new AppError(
        first.finishReason === 'length' || retry.finishReason === 'length'
          ? 'AI 输出因长度限制被截断，导致 JSON 不完整。请选中核心段落后重试，或换用上下文/输出上限更大的模型'
          : 'AI 返回的内容不是有效的 JSON，解析失败。请重试，或换用支持 JSON 输出的模型',
        'LLM_JSON_PARSE',
        `${firstErr instanceof Error ? firstErr.message : ''} / ${e instanceof Error ? e.message : ''}\n---\n${retry.content.slice(0, 1000)}`,
      );
    }
  }
}

/** 设置页「测试连接」：用轻量请求验证 Key / 模型 / 网络（兼容推理模型，不设过小 max_tokens） */
export async function testLlm(settings: Settings): Promise<string> {
  const reply = await chat(settings, [{ role: 'user', content: 'Reply with the single word: pong' }], {
    temperature: 0,
  });
  return `连接成功，模型 ${settings.llmModel} 已响应（${reply.trim().slice(0, 20)}）`;
}
