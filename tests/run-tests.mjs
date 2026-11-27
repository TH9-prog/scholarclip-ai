import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarclip-test-'));

await build({
  entryPoints: [
    path.join(rootDir, 'src/lib/prompt.ts'),
    path.join(rootDir, 'src/lib/llm.ts'),
    path.join(rootDir, 'src/lib/notion.ts'),
    path.join(rootDir, 'src/lib/extract.ts'),
    path.join(rootDir, 'src/lib/i18n.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outExtension: { '.js': '.mjs' },
  outdir: tmpDir,
});

const { buildPrompt } = await import(pathToFileURL(path.join(tmpDir, 'prompt.mjs')).href);
const { extractJsonObject, normalizeSummary, summarizePage } = await import(pathToFileURL(path.join(tmpDir, 'llm.mjs')).href);
const { buildBody, buildProperties, checkSchema, parseDatabaseId, richText } = await import(
  pathToFileURL(path.join(tmpDir, 'notion.mjs')).href
);
const { detectSource, mergeMeta } = await import(pathToFileURL(path.join(tmpDir, 'extract.mjs')).href);
const { detectBrowserLanguage, OPTIONS_STRINGS } = await import(pathToFileURL(path.join(tmpDir, 'i18n.mjs')).href);

const results = [];

async function test(category, name, fn) {
  try {
    await fn();
    results.push({ category, name, status: 'PASS' });
  } catch (err) {
    results.push({ category, name, status: 'FAIL', error: err instanceof Error ? err.message : String(err) });
  }
}

// 1. Prompt
await test('Prompt', '正常替换所有占位符，无残留 {{...}}', () => {
  const page = {
    url: 'https://arxiv.org/abs/1706.03762',
    pageTitle: 'Attention Is All You Need',
    source: 'arxiv',
    meta: { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], arxivId: '1706.03762' },
    text: 'Abstract: The dominant sequence transduction models...',
    usedSelection: false,
  };
  const { system, user } = buildPrompt(page, 'zh');
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(system));
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(user));
  assert.ok(system.includes('Simplified Chinese'));
  assert.ok(user.includes('<extracted_content>'));
  assert.ok(user.includes('1706.03762'));
});

await test('Prompt', '正文中含 $& / $1 / $$ 特殊字符不被误替换', () => {
  const page = {
    url: 'https://example.com/paper',
    pageTitle: 'Cost Analysis',
    source: 'generic',
    meta: { title: 'Cost $& $1 $$' },
    text: 'We save $& and $100 and $$x^2$$ in our experiments.',
    usedSelection: false,
  };
  const { user } = buildPrompt(page, 'en');
  assert.ok(user.includes('We save $& and $100 and $$x^2$$ in our experiments.'));
});

await test('Prompt', '超长正文截断至 12000 字符并附带截断标记', () => {
  const page = {
    url: 'https://example.com',
    pageTitle: 'Long',
    source: 'generic',
    meta: {},
    text: 'A'.repeat(20000),
    usedSelection: false,
  };
  const { user } = buildPrompt(page, 'zh');
  assert.ok(user.includes('…[truncated]'));
  assert.ok(user.length < 13000);
});

// 2. JSON 解析与抗破坏
await test('JSON解析', '标准纯 JSON 解析', () => {
  assert.deepEqual(extractJsonObject('{"title":"Test","year":2024}'), { title: 'Test', year: 2024 });
});

await test('JSON解析', '包裹在 ```json 代码块中', () => {
  assert.deepEqual(extractJsonObject('Here is the result:\n```json\n{"title":"Test"}\n```\nHope it helps!'), { title: 'Test' });
});

await test('JSON解析', '带 <think>...</think> 推理过程（含大括号）', () => {
  assert.deepEqual(extractJsonObject('<think>Let me format {a: 1} as JSON...</think>\n{"title":"DeepSeek Test"}'), {
    title: 'DeepSeek Test',
  });
});

await test('JSON解析', '未闭合 <think> 且含大括号时仍可提取正确 JSON', () => {
  const raw = '<think>checking {a: 1}\n{"title":"Recovered","year":2025}';
  assert.deepEqual(extractJsonObject(raw), { title: 'Recovered', year: 2025 });
});

await test('JSON解析', '字符串含未转义换行符和尾逗号', () => {
  assert.deepEqual(extractJsonObject('{"title":"Line1\nLine2","authors":["A","B",],}'), {
    title: 'Line1\nLine2',
    authors: ['A', 'B'],
  });
});

await test('JSON解析[边界压力]', 'JSON 字符串值内部包含 ``` 代码块', () => {
  const raw = '```json\n{"title":"Code Paper","methodology":"We run ```python\\nprint(1)\\n``` in eval."}\n```';
  const obj = extractJsonObject(raw);
  assert.equal(obj.title, 'Code Paper');
  assert.ok(obj.methodology.includes('print(1)'));
});

await test('JSON解析[边界压力]', 'JSON 前后说明文字包含花括号 {note}', () => {
  const raw = 'Note {important}: below is the JSON:\n{"title":"Brace Paper","year":2025}\nDone {ok}.';
  assert.deepEqual(extractJsonObject(raw), { title: 'Brace Paper', year: 2025 });
});

await test('JSON解析[边界压力]', '字符串内含未转义换行且含合法 ", ]" 字符时不被破坏', () => {
  const raw = '{"title":"Interval [a, ] and set {x, }","tldr":"Line1\nLine2"}';
  const obj = extractJsonObject(raw);
  assert.equal(obj.title, 'Interval [a, ] and set {x, }');
  assert.equal(obj.tldr, 'Line1\nLine2');
});

await test('JSON解析[边界压力]', '字符串内含 \\f (0x0c) 等其他控制字符', () => {
  const obj = extractJsonObject('{"title":"PDF\fFormFeed","year":2024}');
  assert.equal(obj.year, 2024);
  assert.equal(obj.title, 'PDF\fFormFeed');
});

// 3. 字段规范化与防幻觉边界
await test('字段规范化', '正常完整字段规范化且不误删量化指标数字', () => {
  const s = normalizeSummary({
    title: '  Attention Is All You Need  ',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    year: 2017,
    venue: 'NeurIPS',
    doi_or_id: '1706.03762',
    tags: ['Transformer', 'NLP', 'Attention'],
    tldr: 'Proposes Transformer.',
    research_problem: 'Seq2seq bottleneck.',
    methodology: 'Self-attention.',
    key_findings: ['- 28.4 BLEU on WMT14', '2. Faster training', '95.2% accuracy'],
    limitations: 'Quadratic memory.',
    citations: { apa7: 'Vaswani et al. (2017).', ieee: 'A. Vaswani et al., 2017.' },
  });
  assert.equal(s.title, 'Attention Is All You Need');
  assert.equal(s.year, 2017);
  assert.deepEqual(s.key_findings, ['28.4 BLEU on WMT14', 'Faster training', '95.2% accuracy']);
});

await test('字段规范化', '缺少必填字段 title 应抛错', () => {
  assert.throws(() => normalizeSummary({ authors: ['A'], year: 2024 }), /title/);
});

await test('字段规范化[边界压力]', 'authors 为对象数组时提取 name 且不产出 [object Object]', () => {
  const s = normalizeSummary({
    title: 'Obj Authors',
    authors: [{ name: 'Alice Smith' }, { name: 'Bob Lee' }],
  });
  assert.deepEqual(s.authors, ['Alice Smith', 'Bob Lee']);
});

await test('字段规范化[边界压力]', 'authors 为分号分隔的 Last, First 格式不被拆散', () => {
  const s = normalizeSummary({
    title: 'Semicolon Authors',
    authors: 'Vaswani, Ashish; Shazeer, Noam',
  });
  assert.deepEqual(s.authors, ['Vaswani, Ashish', 'Shazeer, Noam']);
});

await test('字段规范化[边界压力]', 'year 为不合理数字（如 0 或 99999）应置 null', () => {
  assert.equal(normalizeSummary({ title: 'Bad Year 1', year: 99999 }).year, null);
  assert.equal(normalizeSummary({ title: 'Bad Year 2', year: 0 }).year, null);
});

await test('字段规范化[边界压力]', 'venue / doi_or_id 为 "Not explicitly stated" / "未知" 应视为 null', () => {
  const s = normalizeSummary({
    title: 'Missing Meta',
    venue: 'Not explicitly stated',
    doi_or_id: '未知',
  });
  assert.equal(s.venue, null);
  assert.equal(s.doi_or_id, null);
});

// 4. LLM 流程
const dummySettings = {
  llmBaseUrl: 'https://api.example.com/v1',
  llmApiKey: 'sk-test',
  llmModel: 'gpt-4o-mini',
  outputLanguage: 'zh',
  notionToken: 'ntn_test',
  notionDatabaseId: '0123456789abcdef0123456789abcdef',
};
const dummyPage = {
  url: 'https://arxiv.org/abs/2401.00001',
  pageTitle: 'Test Paper',
  source: 'arxiv',
  meta: { title: 'Test Paper' },
  text: 'Abstract: A short test abstract for unit testing.',
  usedSelection: false,
};

await test('LLM流程', '首次返回损坏 JSON，二次重试自动修复成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const content = calls === 1 ? 'Sorry, I cannot output JSON right now.' : '{"title":"Fixed Paper","year":2024}';
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const s = await summarizePage(dummySettings, dummyPage);
  assert.equal(calls, 2);
  assert.equal(s.title, 'Fixed Paper');
});

await test('LLM流程', '服务端不支持 response_format 返回 400 时自动降级', async () => {
  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    bodies.push(JSON.parse(init.body));
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'response_format json_object is not supported' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Fallback OK"}' }, finish_reason: 'stop' }] }), {
      status: 200,
    });
  };
  const s = await summarizePage(dummySettings, dummyPage);
  assert.equal(calls, 2);
  assert.equal(bodies[0].response_format?.type, 'json_object');
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(s.title, 'Fallback OK');
});

await test('LLM流程', 'finish_reason=length 截断时提示精简重试并给出针对性报错', async () => {
  const retryBodies = [];
  globalThis.fetch = async (_url, init) => {
    retryBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Cut off' }, finish_reason: 'length' }] }), {
      status: 200,
    });
  };
  await assert.rejects(() => summarizePage(dummySettings, dummyPage), (err) => {
    assert.equal(err.code, 'LLM_JSON_PARSE');
    assert.ok(err.message.includes('截断'));
    return true;
  });
  assert.ok(retryBodies[1].messages.at(-1).content.includes('truncated'));
});

await test('LLM流程', '两次 JSON 都损坏时抛出友好 LLM_JSON_PARSE 错误', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' }, finish_reason: 'stop' }] }), { status: 200 });
  await assert.rejects(() => summarizePage(dummySettings, dummyPage), (err) => {
    assert.equal(err.code, 'LLM_JSON_PARSE');
    return true;
  });
});

// 5. Notion
await test('Notion', 'parseDatabaseId 支持 URL / 32位ID / UUID', () => {
  assert.equal(
    parseDatabaseId('https://www.notion.so/myworkspace/0123456789abcdef0123456789abcdef?v=ffffffffffffffffffffffffffffffff'),
    '01234567-89ab-cdef-0123-456789abcdef',
  );
  assert.equal(parseDatabaseId('01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(parseDatabaseId('invalid-id'), null);
});

await test('Notion', 'checkSchema 兼容中文别名并跳过类型不符字段', () => {
  const schema = checkSchema({
    id: 'db1',
    title: [{ plain_text: '论文库' }],
    properties: {
      标题: { id: '1', name: '标题', type: 'title' },
      作者: { id: '2', name: '作者', type: 'rich_text' },
      年份: { id: '3', name: '年份', type: 'checkbox' },
      标签: { id: '4', name: '标签', type: 'multi_select' },
    },
  });
  assert.equal(schema.databaseTitle, '论文库');
  assert.ok(schema.mappings.some((m) => m.logical === 'Title' && m.name === '标题'));
  assert.ok(!schema.mappings.some((m) => m.logical === 'Year'));
});

await test('Notion', 'richText 超长文本 (>2000) 自动切分且 multi_select 清理逗号', () => {
  const chunks = richText('X'.repeat(4500));
  assert.equal(chunks.length, 3);
  const props = buildProperties(
    [{ logical: 'Tags', name: 'Tags', type: 'multi_select' }],
    {
      title: 'T',
      authors: [],
      year: null,
      venue: null,
      doi_or_id: null,
      tags: ['AI, ML', 'NLP'],
      tldr: '',
      research_problem: '',
      methodology: '',
      key_findings: [],
      limitations: '',
      citations: { apa7: '', ieee: '' },
    },
    'https://arxiv.org/abs/1',
  );
  assert.deepEqual(props.Tags, { multi_select: [{ name: 'AI ML' }, { name: 'NLP' }] });
});

await test('Notion', 'buildBody 生成 callout + heading_2 + bulleted_list_item', () => {
  const blocks = buildBody(
    {
      title: 'T',
      authors: ['A'],
      year: 2024,
      venue: 'arXiv',
      doi_or_id: null,
      tags: ['LLM'],
      tldr: 'One sentence.',
      research_problem: 'Prob',
      methodology: 'Method',
      key_findings: ['Finding 1', 'Finding 2'],
      limitations: 'Limit',
      citations: { apa7: 'APA', ieee: 'IEEE' },
    },
    'https://arxiv.org/abs/2401.00001',
    'zh',
  );
  assert.equal(blocks[0].type, 'callout');
  assert.ok(blocks.some((b) => b.type === 'heading_2'));
  assert.ok(blocks.filter((b) => b.type === 'bulleted_list_item').length >= 5);
});

// 6. Extract
await test('Extract', 'detectSource 正确识别 arXiv / Scholar / IEEE / ACM / 不支持协议', () => {
  assert.equal(detectSource('https://arxiv.org/abs/1706.03762'), 'arxiv');
  assert.equal(detectSource('https://scholar.google.com/scholar?q=llm'), 'scholar');
  assert.equal(detectSource('https://ieeexplore.ieee.org/document/12345'), 'ieee');
  assert.equal(detectSource('https://dl.acm.org/doi/10.1145/12345'), 'acm');
  assert.equal(detectSource('chrome://extensions'), 'unsupported');
  assert.equal(detectSource('https://example.com/blog'), 'generic');
});

await test('Extract', 'mergeMeta 仅在原字段缺失时补位，不覆盖已有期刊名', () => {
  const merged = mergeMeta({ title: 'Paper', venue: 'Nature' }, { venue: 'arXiv', arxivId: '2401.00001' });
  assert.equal(merged.venue, 'Nature');
  assert.equal(merged.arxivId, '2401.00001');
});

// 7. i18n
await test('i18n', 'detectBrowserLanguage 按浏览器语言自动识别中英文', () => {
  assert.equal(detectBrowserLanguage('zh-CN'), 'zh');
  assert.equal(detectBrowserLanguage('zh_TW'), 'zh');
  assert.equal(detectBrowserLanguage('zh'), 'zh');
  assert.equal(detectBrowserLanguage('en-US'), 'en');
  assert.equal(detectBrowserLanguage('ja'), 'en');
  assert.deepEqual(Object.keys(OPTIONS_STRINGS.zh).sort(), Object.keys(OPTIONS_STRINGS.en).sort());
});

fs.rmSync(tmpDir, { recursive: true, force: true });

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\n=== ScholarClip AI (Fix) 测试汇总: ${passed}/${results.length} 通过, ${failed.length} 失败 ===\n`);
for (const r of results) {
  console.log(`[${r.status}] (${r.category}) ${r.name}${r.error ? `\n       -> ${r.error}` : ''}`);
}
process.exit(failed.length > 0 ? 1 : 0);
