import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nContext } from '@/components/layout/I18nProvider';
import { translate } from '@/i18n';
import { QuickActions, QuickActionsStatus } from '@/components/chat/QuickActions';

const localized = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nContext.Provider,
  { value: { locale: 'en', setLocale: () => {}, t: (key, params) => translate('en', key, params) } }, child));

test('an empty initial suggestion list still shows the real loading state', () => {
  const html = localized(createElement(QuickActions, { isAssistantProject: true, hasMessages: false, onAction: () => {} }));
  assert.match(html, /role="status"/);
  assert.match(html, /being generated/);
});

test('failed status and a usable retry control do not depend on actions being present', () => {
  const html = localized(createElement(QuickActionsStatus, { status: { status: 'failed', reason: 'request_failed' },
    loading: false, retried: true, now: 1000, onRetry: () => {} }));
  assert.match(html, /Dynamic suggestions are unavailable/);
  assert.match(html, /Retry suggestions/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.doesNotMatch(html, /suggestions updated/);
});

test('actual future retry deadline disables retry and expiration re-enables it', () => {
  const props = { status: { status: 'cooldown' as const, reason: 'request_failed' as const, retryAt: 90000 },
    loading: false, retried: true, onRetry: () => {} };
  const cooling = localized(createElement(QuickActionsStatus, { ...props, now: 1000 }));
  assert.match(cooling, /Cooling down until/);
  assert.match(cooling, /disabled=""/);
  const expired = localized(createElement(QuickActionsStatus, { ...props, now: 90001 }));
  assert.doesNotMatch(expired, /disabled=""/);
});

test('retry success is explicit and hidden chat contexts do not render stale status', () => {
  const success = localized(createElement(QuickActionsStatus, { status: { status: 'completed' }, loading: false,
    retried: true, now: 0, onRetry: () => {} }));
  assert.match(success, /Dynamic suggestions updated/);
  assert.equal(localized(createElement(QuickActions, { isAssistantProject: false, hasMessages: false, onAction: () => {} })), '');
});
