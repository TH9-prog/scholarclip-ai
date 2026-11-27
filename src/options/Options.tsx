import { useEffect, useState } from 'react';
import { ErrorBox, Field, Spinner, TextInput } from '../components/ui';
import { serializeError, type SerializedError } from '../lib/errors';
import { detectBrowserLanguage, getUiLanguage, OPTIONS_STRINGS, saveUiLanguage, type UiLanguage } from '../lib/i18n';
import { originPattern } from '../lib/llm';
import { RemoteError, send } from '../lib/messages';
import { parseDatabaseId } from '../lib/notion';
import { getSettings, saveSettings } from '../lib/storage';
import { DEFAULT_SETTINGS, type ConnectionReport, type Settings } from '../lib/types';

function SecretInput({
  value,
  onChange,
  placeholder,
  showLabel,
  hideLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  showLabel: string;
  hideLabel: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <TextInput
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="pr-14 font-mono"
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-400 hover:text-ink-800"
        onClick={() => setShow((s) => !s)}
      >
        {show ? hideLabel : showLabel}
      </button>
    </div>
  );
}

/** 类似明暗模式切换的胶囊滑动开关（中 / EN） */
function LanguageSwitch({
  lang,
  onToggle,
  ariaLabel,
}: {
  lang: UiLanguage;
  onToggle: () => void;
  ariaLabel: string;
}) {
  const isEn = lang === 'en';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isEn}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onToggle}
      className="relative inline-flex h-8 w-[76px] shrink-0 items-center rounded-full border border-ink-200 bg-ink-100 p-0.5 text-[11px] font-semibold transition-colors hover:border-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-900/15"
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute left-0.5 top-0.5 h-[26px] w-[35px] rounded-full bg-white shadow-sm ring-1 ring-ink-900/5 transition-transform duration-200 ease-out ${
          isEn ? 'translate-x-[35px]' : 'translate-x-0'
        }`}
      />
      <span className={`relative z-10 w-1/2 text-center transition-colors ${!isEn ? 'text-ink-900' : 'text-ink-400'}`}>中</span>
      <span className={`relative z-10 w-1/2 text-center transition-colors ${isEn ? 'text-ink-900' : 'text-ink-400'}`}>EN</span>
    </button>
  );
}

const StatusDot = ({ ok }: { ok: boolean }) => (
  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-emerald-500' : 'bg-accent-500'}`} />
);

export default function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [lang, setLang] = useState<UiLanguage>(() => detectBrowserLanguage());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<SerializedError | null>(null);
  const [report, setReport] = useState<ConnectionReport | null>(null);

  const t = OPTIONS_STRINGS[lang];

  useEffect(() => {
    Promise.all([getSettings(), getUiLanguage()]).then(([settings, uiLang]) => {
      setS(settings);
      setLang(uiLang);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    document.title = t.pageTitle;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang, t.pageTitle]);

  const toggleLang = () => {
    const next: UiLanguage = lang === 'zh' ? 'en' : 'zh';
    setLang(next);
    void saveUiLanguage(next);
  };

  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  /**
   * 保存配置。chrome.permissions.request 必须在用户手势中、且在任何 await 之前调用，
   * 用于按需申请用户自定义 LLM 域名的访问权限（最小权限原则）。
   */
  const persist = async (): Promise<boolean> => {
    setError(null);
    const pattern = originPattern(s.llmBaseUrl);
    if (s.llmBaseUrl.trim() && !pattern) {
      setError({ message: t.errInvalidBaseUrl, code: 'CONFIG_MISSING' });
      return false;
    }
    if (s.notionDatabaseId.trim() && !parseDatabaseId(s.notionDatabaseId)) {
      setError({ message: t.errInvalidDbId, code: 'CONFIG_MISSING' });
      return false;
    }
    const permissionPromise = pattern ? chrome.permissions.request({ origins: [pattern] }) : Promise.resolve(true);

    setSaving(true);
    try {
      const granted = await permissionPromise.catch(() => false);
      const normalized: Settings = {
        ...s,
        llmBaseUrl: s.llmBaseUrl.trim().replace(/\/+$/, ''),
        llmApiKey: s.llmApiKey.trim(),
        llmModel: s.llmModel.trim(),
        notionToken: s.notionToken.trim(),
        notionDatabaseId: parseDatabaseId(s.notionDatabaseId) ?? s.notionDatabaseId.trim(),
      };
      await saveSettings(normalized);
      setS(normalized);
      setSavedAt(Date.now());
      if (!granted && pattern) {
        setError({
          message: t.errPermissionDenied(pattern),
          code: 'PERMISSION_DENIED',
        });
      }
      return true;
    } catch (e) {
      setError(serializeError(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setReport(null);
    const ok = await persist();
    if (!ok) return;
    setTesting(true);
    try {
      setReport(await send({ type: 'TEST_CONNECTION' }));
    } catch (e) {
      setError(e instanceof RemoteError ? e.error : serializeError(e));
    } finally {
      setTesting(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4 border-b border-ink-200 pb-6">
        <div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight">{t.headerTitle}</h1>
          <p className="mt-1.5 text-[13px] text-ink-600">{t.headerSubtitle}</p>
        </div>
        <LanguageSwitch lang={lang} onToggle={toggleLang} ariaLabel={t.langToggleAria} />
      </header>

      <form
        className="space-y-8"
        onSubmit={(e) => {
          e.preventDefault();
          void persist();
        }}
      >
        <section className="space-y-4">
          <h2 className="font-serif text-[16px] font-semibold">{t.llmSection}</h2>
          <Field label={t.llmBaseUrlLabel} hint={t.llmBaseUrlHint}>
            <TextInput value={s.llmBaseUrl} onChange={(e) => set('llmBaseUrl')(e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
          </Field>
          <Field label={t.llmApiKeyLabel}>
            <SecretInput value={s.llmApiKey} onChange={set('llmApiKey')} placeholder="sk-..." showLabel={t.showSecret} hideLabel={t.hideSecret} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t.llmModelLabel}>
              <TextInput value={s.llmModel} onChange={(e) => set('llmModel')(e.target.value)} placeholder="gpt-4o-mini" spellCheck={false} />
            </Field>
            <Field label={t.outputLanguageLabel}>
              <select className="field-input" value={s.outputLanguage} onChange={(e) => set('outputLanguage')(e.target.value as Settings['outputLanguage'])}>
                <option value="zh">中文（简体）</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-serif text-[16px] font-semibold">{t.notionSection}</h2>
          <Field label={t.notionTokenLabel} hint={t.notionTokenHint}>
            <SecretInput
              value={s.notionToken}
              onChange={set('notionToken')}
              placeholder={t.notionTokenPlaceholder}
              showLabel={t.showSecret}
              hideLabel={t.hideSecret}
            />
          </Field>
          <Field label={t.notionDbIdLabel} hint={t.notionDbIdHint}>
            <TextInput value={s.notionDatabaseId} onChange={(e) => set('notionDatabaseId')(e.target.value)} placeholder={t.notionDbIdPlaceholder} spellCheck={false} className="font-mono" />
          </Field>
          <div className="rounded-md bg-ink-100 px-3 py-2.5 text-[12px] leading-relaxed text-ink-600">
            {t.notionRecommendedPrefix}
            {t.notionRecommendedFields} {t.notionRecommendedAliases}
            <br />
            {t.notionConnectTip}
          </div>
        </section>

        <div className="flex items-center gap-3 border-t border-ink-200 pt-6">
          <button type="submit" className="btn-primary px-5" disabled={saving || testing}>
            {saving && !testing ? <Spinner /> : null} {t.saveBtn}
          </button>
          <button type="button" className="btn-secondary px-5" onClick={onTest} disabled={saving || testing}>
            {testing ? <Spinner /> : null} {t.testBtn}
          </button>
          {savedAt && !error && <span className="text-[12px] text-emerald-700">{t.savedBadge}</span>}
        </div>

        {error && <ErrorBox message={error.message} detail={error.detail} detailLabel={t.technicalDetails} />}

        {report && (
          <section className="space-y-3 rounded-lg border border-ink-200 bg-white p-4 text-[13px]">
            <div className="flex items-start gap-2">
              <StatusDot ok={report.llm.ok} />
              <div className="-mt-1">
                <div className="font-medium">{t.reportLlmTitle}</div>
                <div className="text-ink-600">{report.llm.message}</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <StatusDot ok={report.notion.ok} />
              <div className="-mt-1 min-w-0 flex-1">
                <div className="font-medium">{t.reportNotionTitle}</div>
                <div className="text-ink-600">{report.notion.message}</div>
                {report.notion.fields && (
                  <table className="mt-3 w-full text-left text-[12px]">
                    <thead className="text-ink-400">
                      <tr>
                        <th className="py-1 font-medium">{t.tableField}</th>
                        <th className="py-1 font-medium">{t.tableProperty}</th>
                        <th className="py-1 font-medium">{t.tableType}</th>
                        <th className="py-1 font-medium">{t.tableStatus}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.notion.fields.map((f) => (
                        <tr key={f.logical} className="border-t border-ink-100 align-top">
                          <td className="py-1.5 font-medium">{f.logical}</td>
                          <td className="py-1.5">{f.matchedName ?? '—'}</td>
                          <td className="py-1.5 font-mono text-[11px]">{f.type ?? '—'}</td>
                          <td className={`py-1.5 ${f.ok ? 'text-emerald-700' : 'text-accent-600'}`}>{f.ok ? t.statusMatched : f.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        )}
      </form>
    </div>
  );
}
