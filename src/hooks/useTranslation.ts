'use client';

import { useContext } from 'react';
import { I18nContext, type I18nContextValue } from '@/components/layout/I18nProvider';

export function useTranslation(): I18nContextValue {
  return useContext(I18nContext);
}
