'use client';

import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { translate, SUPPORTED_LOCALES, type Locale, type TranslationKey } from '@/i18n';

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key) => String(key),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  const userChangedRef = useRef(false);

  // Load persisted locale on mount
  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/app')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || userChangedRef.current) return;
        const saved = data.settings?.locale;
        if (saved && SUPPORTED_LOCALES.includes(saved as Locale)) {
          setLocaleState(saved as Locale);
          document.documentElement.lang = saved;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    userChangedRef.current = true;
    setLocaleState(newLocale);
    document.documentElement.lang = newLocale;
    // Persist to backend
    fetch('/api/settings/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { locale: newLocale } }),
    }).catch(() => {});
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}
