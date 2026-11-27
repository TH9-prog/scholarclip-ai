import type { ReactNode, TextareaHTMLAttributes, InputHTMLAttributes } from 'react';
import { useEffect, useRef } from 'react';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">
        {label}
        {hint && <span className="ml-1 normal-case tracking-normal text-ink-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field-input ${props.className ?? ''}`} />;
}

/** 自动增高的 textarea */
export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={2} {...props} className={`field-input resize-none leading-relaxed ${props.className ?? ''}`} />;
}

export function ErrorBox({
  message,
  detail,
  action,
  detailLabel = '技术详情',
}: {
  message: string;
  detail?: string;
  action?: ReactNode;
  detailLabel?: string;
}) {
  return (
    <div className="rounded-md border border-accent-500/30 bg-accent-50 px-3 py-2.5 text-[12.5px] text-accent-600" role="alert">
      <p className="leading-relaxed">{message}</p>
      {detail && (
        <details className="mt-1.5 text-[11px] text-accent-600/70">
          <summary className="cursor-pointer select-none">{detailLabel}</summary>
          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono">{detail}</pre>
        </details>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export const GearIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
);

export const CopyButton = ({ text }: { text: string }) => (
  <button
    type="button"
    className="text-[11px] text-ink-400 hover:text-accent-500"
    onClick={() => navigator.clipboard.writeText(text).catch(() => undefined)}
    title="复制"
  >
    复制
  </button>
);
