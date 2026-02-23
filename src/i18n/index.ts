import en from './en';
import zh from './zh';
import ja from './ja';
import type { TranslationKey } from './en';

export type Locale = 'en' | 'zh' | 'ja';
export type { TranslationKey };

export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh', 'ja'];

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en, zh, ja,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Look up a translation key with optional parameter interpolation.
 * Falls back to English if the key is missing in the target locale.
 *
 * Usage: translate('zh', 'chatList.minutesAgo', { count: 5 })
 *        -> "5 分钟前"
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[locale] || dictionaries.en;
  let value = dict[key] ?? dictionaries.en[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      const pattern = new RegExp(`\\{${escapeRegExp(k)}\\}`, 'g');
      // Use function replacement so `$` in parameter values is treated literally.
      value = value.replace(pattern, () => String(v));
    }
  }

  return value;
}
