import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoTextarea, CopyButton, ErrorBox, Field, GearIcon, Spinner, TextInput } from '../components/ui';
import type { SerializedError } from '../lib/errors';
import { serializeError } from '../lib/errors';
import { detectSource, extractFromTab, SOURCE_LABEL } from '../lib/extract';
import { RemoteError, send } from '../lib/messages';
import { getDraft, getSettings, missingLlmSettings, missingNotionSettings, saveDraft } from '../lib/storage';
import type { Draft, PaperSummary, SourceKind } from '../lib/types';

type Phase = 'idle' | 'extracting' | 'summarizing' | 'ready' | 'saving' | 'saved';

/** 表单使用字符串存储，便于编辑 */
interface FormState {
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi_or_id: string;
  tldr: string;
  research_problem: string;
  methodology: string;
  key_findings: string;
  limitations: string;
  apa7: string;
  ieee: string;
  tags: string;
}

const toForm = (s: PaperSummary): FormState => {
  const authorSep = s.authors.some((a) => a.includes(',')) ? '; ' : ', ';
  return {
    title: s.title,
    authors: s.authors.join(authorSep),
    year: s.year == null ? '' : String(s.year),
    venue: s.venue ?? '',
    doi_or_id: s.doi_or_id ?? '',
    tldr: s.tldr,
    research_problem: s.research_problem,
    methodology: s.methodology,
    key_findings: s.key_findings.join('\n'),
    limitations: s.limitations,
    apa7: s.citations.apa7,
    ieee: s.citations.ieee,
    tags: s.tags.join(', '),
  };
};

const splitList = (v: string, sep: RegExp) => v.split(sep).map((x) => x.trim()).filter(Boolean);

const splitAuthors = (v: string) => {
  const sep = /[;；\n]/.test(v) ? /[;；\n]+/ : /[,，]+/;
  return splitList(v, sep);
};

const fromForm = (f: FormState): PaperSummary => {
  const y = parseInt(f.year, 10);
  return {
    title: f.title.trim(),
    authors: splitAuthors(f.authors),
    year: Number.isFinite(y) && y >= 1800 && y <= 2100 ? y : null,
    venue: f.venue.trim() || null,
    doi_or_id: f.doi_or_id.trim() || null,
    tags: splitList(f.tags, /[,;，；]/),
    tldr: f.tldr.trim(),
    research_problem: f.research_problem.trim(),
    methodology: f.methodology.trim(),
    key_findings: splitList(f.key_findings, /\n+/),
    limitations: f.limitations.trim(),
    citations: { apa7: f.apa7.trim(), ieee: f.ieee.trim() },
  };
};

const toError = (e: unknown): SerializedError => (e instanceof RemoteError ? e.error : serializeError(e));

interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export default function App() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [source, setSource] = useState<SourceKind>('generic');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<SerializedError | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [draftMeta, setDraftMeta] = useState<Pick<Draft, 'createdAt'> | null>(null);
  const [notionUrl, setNotionUrl] = useState<string | null>(null);
  const [configMissing, setConfigMissing] = useState<{ llm: string[]; notion: string[] }>({ llm: [], notion: [] });
  const [showMore, setShowMore] = useState(false);
  const [usedSelection, setUsedSelection] = useState(false);

  // 初始化：当前标签页 + 草稿恢复 + 配置检查
  useEffect(() => {
    (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      const settings = await getSettings();
      setConfigMissing({ llm: missingLlmSettings(settings), notion: missingNotionSettings(settings) });
      if (!active?.id || !active.url) {
        setSource('unsupported');
        return;
      }
      setTab({ id: active.id, url: active.url, title: active.title ?? '' });
      setSource(detectSource(active.url));
      const draft = await getDraft(active.url);
      if (draft) {
        setForm(toForm(draft.summary));
        setDraftMeta({ createdAt: draft.createdAt });
        setNotionUrl(draft.notionPageUrl ?? null);
        setPhase(draft.notionPageUrl ? 'saved' : 'ready');
      }
    })().catch((e) => setError(toError(e)));
  }, []);

  // 编辑内容自动写回草稿（防抖），popup 关闭也不会丢失修改
  const saveTimer = useRef<number>();
  useEffect(() => {
    if (!form || !tab || !draftMeta) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveDraft({
        url: tab.url,
        summary: fromForm(form),
        createdAt: draftMeta.createdAt,
        notionPageUrl: notionUrl ?? undefined,
      });
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [form, tab, draftMeta, notionUrl]);

  const update = (key: keyof FormState) => (e: { target: { value: string } }) => {
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));
    if (phase === 'saved') {
      // 修改后允许再次保存为新页面
      setPhase('ready');
    }
  };

  const runExtract = useCallback(async () => {
    if (!tab) return;
    setError(null);
    setNotionUrl(null);
    try {
      setPhase('extracting');
      const page = await extractFromTab(tab.id, tab.url);
      setSource(page.source);
      setUsedSelection(page.usedSelection);
      setPhase('summarizing');
      const draft = await send({ type: 'SUMMARIZE', page });
      setForm(toForm(draft.summary));
      setDraftMeta({ createdAt: draft.createdAt });
      setPhase('ready');
    } catch (e) {
      setError(toError(e));
      setPhase(form ? 'ready' : 'idle');
    }
  }, [tab, form]);

  const runSave = useCallback(async () => {
    if (!tab || !form) return;
    const summary = fromForm(form);
    if (!summary.title) {
      setError({ message: '论文标题不能为空', code: 'UNKNOWN' });
      return;
    }
    setError(null);
    setPhase('saving');
    try {
      const res = await send({ type: 'SAVE_TO_NOTION', url: tab.url, summary });
      setNotionUrl(res.pageUrl);
      setPhase('saved');
    } catch (e) {
      setError(toError(e));
      setPhase('ready');
    }
  }, [tab, form]);

  const openOptions = () => chrome.runtime.openOptionsPage();
  const busy = phase === 'extracting' || phase === 'summarizing' || phase === 'saving';
  const isAcademic = useMemo(() => !['generic', 'unsupported'].includes(source), [source]);
  const cannotRun = !tab || source === 'unsupported';

  return (
    <div className="w-[400px] bg-ink-50">
      {/* 顶部状态栏 */}
      <header className="flex items-start gap-3 border-b border-ink-200 bg-white px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-serif text-[15px] font-semibold tracking-tight text-ink-900">ScholarClip</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                isAcademic ? 'bg-accent-50 text-accent-600' : 'bg-ink-100 text-ink-600'
              }`}
            >
              {SOURCE_LABEL[source]}
            </span>
          </div>
          <p className="mt-1 truncate text-[12px] text-ink-600" title={tab?.title}>
            {tab?.title || '无法获取当前页面'}
          </p>
        </div>
        <button className="rounded-md p-1.5 text-ink-600 hover:bg-ink-100 hover:text-ink-900" onClick={openOptions} title="设置">
          <GearIcon />
        </button>
      </header>

      <main className="space-y-3 px-4 py-3">
        {(configMissing.llm.length > 0 || configMissing.notion.length > 0) && (
          <div className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            尚未完成配置：{[...configMissing.llm, ...configMissing.notion].join('、')}。
            <button className="ml-1 font-medium underline underline-offset-2" onClick={openOptions}>
              前往设置
            </button>
          </div>
        )}

        {/* 核心操作区 */}
        <button className="btn-dark w-full py-2.5" onClick={runExtract} disabled={busy || cannotRun || configMissing.llm.length > 0}>
          {phase === 'extracting' && (
            <>
              <Spinner /> 正在读取页面…
            </>
          )}
          {phase === 'summarizing' && (
            <>
              <Spinner /> AI 正在阅读并结构化总结…
            </>
          )}
          {!['extracting', 'summarizing'].includes(phase) && (form ? '重新提取' : 'AI 提取并预览')}
        </button>
        {phase === 'summarizing' && (
          <p className="text-center text-[11px] text-ink-400">通常需要 10–30 秒，可关闭弹窗，结果会自动保留</p>
        )}

        {error && (
          <ErrorBox
            message={error.message}
            detail={error.detail}
            action={
              ['CONFIG_MISSING', 'LLM_AUTH', 'LLM_NOT_FOUND', 'NOTION_AUTH', 'NOTION_NOT_FOUND', 'NOTION_FIELD_MISMATCH', 'PERMISSION_DENIED'].includes(
                error.code,
              ) ? (
                <button className="text-[12px] font-medium underline underline-offset-2" onClick={openOptions}>
                  打开设置
                </button>
              ) : undefined
            }
          />
        )}

        {/* 结构化预览 / 可编辑表单 */}
        {form && (
          <section className="space-y-3 rounded-lg border border-ink-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-[13px] font-semibold text-ink-800">预览与微调</h2>
              {usedSelection && <span className="text-[10.5px] text-ink-400">基于选中文本</span>}
            </div>

            <Field label="论文标题">
              <AutoTextarea value={form.title} onChange={update('title')} className="font-serif text-[14px] font-medium" />
            </Field>
            <Field label="作者" hint="逗号或分号分隔">
              <TextInput value={form.authors} onChange={update('authors')} />
            </Field>
            <div className="grid grid-cols-[88px_1fr] gap-2">
              <Field label="年份">
                <TextInput value={form.year} onChange={update('year')} inputMode="numeric" placeholder="—" />
              </Field>
              <Field label="标签 Tags" hint="逗号分隔">
                <TextInput value={form.tags} onChange={update('tags')} />
              </Field>
            </div>
            <Field label="一句话核心结论">
              <AutoTextarea value={form.tldr} onChange={update('tldr')} />
            </Field>
            <Field label="研究方法">
              <AutoTextarea value={form.methodology} onChange={update('methodology')} />
            </Field>
            <Field label="核心发现" hint="每行一条">
              <AutoTextarea value={form.key_findings} onChange={update('key_findings')} />
            </Field>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="field-label mb-0">APA 7th 引用</span>
                <CopyButton text={form.apa7} />
              </div>
              <AutoTextarea value={form.apa7} onChange={update('apa7')} className="font-serif" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="field-label mb-0">IEEE 引用</span>
                <CopyButton text={form.ieee} />
              </div>
              <AutoTextarea value={form.ieee} onChange={update('ieee')} className="font-serif" />
            </div>

            <button
              type="button"
              className="w-full text-left text-[11.5px] font-medium text-ink-600 hover:text-ink-900"
              onClick={() => setShowMore((v) => !v)}
            >
              {showMore ? '▾ 收起更多字段' : '▸ 更多字段（期刊 / DOI / 研究问题 / 局限性）'}
            </button>
            {showMore && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="期刊 / 会议">
                    <TextInput value={form.venue} onChange={update('venue')} placeholder="—" />
                  </Field>
                  <Field label="DOI / ID">
                    <TextInput value={form.doi_or_id} onChange={update('doi_or_id')} placeholder="—" />
                  </Field>
                </div>
                <Field label="研究问题">
                  <AutoTextarea value={form.research_problem} onChange={update('research_problem')} />
                </Field>
                <Field label="局限性">
                  <AutoTextarea value={form.limitations} onChange={update('limitations')} />
                </Field>
              </div>
            )}
          </section>
        )}
      </main>

      {/* 底部主按钮 */}
      {form && (
        <footer className="sticky bottom-0 space-y-2 border-t border-ink-200 bg-white/95 px-4 py-3 backdrop-blur">
          {phase === 'saved' && notionUrl ? (
            <a
              href={notionUrl}
              target="_blank"
              rel="noreferrer"
              className="btn w-full border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
            >
              ✓ 已保存 · 在 Notion 中打开 →
            </a>
          ) : (
            <button
              className="btn-primary w-full py-2.5"
              onClick={runSave}
              disabled={busy || configMissing.notion.length > 0}
              title={configMissing.notion.length ? '请先在设置页配置 Notion' : undefined}
            >
              {phase === 'saving' ? (
                <>
                  <Spinner /> 正在写入 Notion…
                </>
              ) : (
                '保存到 Notion'
              )}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}
