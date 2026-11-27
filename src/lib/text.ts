/** Prompt 中约定的正文截断长度：{{RAW_TEXT_TRUNCATED_TO_12000_CHARS}} */
export const MAX_TEXT_CHARS = 12000;

export function truncate(text: string, max = MAX_TEXT_CHARS): string {
  return text.length <= max ? text : text.slice(0, max) + '\n…[truncated]';
}
