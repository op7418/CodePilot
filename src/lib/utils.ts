import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Locale, TranslationKey } from "@/i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(
  dateStr: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: Locale,
): string {
  const date = new Date(dateStr.includes("T") ? dateStr : dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return t('chatList.justNow');
  if (diffMin < 60) return t('chatList.minutesAgo', { count: diffMin });
  if (diffHr < 24) return t('chatList.hoursAgo', { count: diffHr });
  if (diffDay < 7) return t('chatList.daysAgo', { count: diffDay });
  return new Intl.DateTimeFormat(locale).format(date);
}
