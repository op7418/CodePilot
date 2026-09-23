import { CHAT_SAVE_UNCONFIRMED } from './chat-collection-response';
import { TOKENDANCE_RECOVERY_ERRORS } from './tokendance';
import { translateActive, type TranslationKey } from '@/i18n';
import { MODEL_SELECTION_ERRORS } from './model-selection-error';

const keys: Record<keyof typeof MODEL_SELECTION_ERRORS, TranslationKey> = {
  OPENAI_OAUTH_EFFORT_UNAVAILABLE: 'chat.error.oauthEffortUnavailable',
  OPENAI_OAUTH_CATALOG_EMPTY: 'chat.error.oauthCatalogEmpty',
};

/** Replace only our exact error payload, retaining surrounding diagnostics. */
export function localizeModelSelectionError(
  message: string,
  t: (key: TranslationKey) => string = translateActive,
): string {
  if (message === CHAT_SAVE_UNCONFIRMED) return t('chat.error.saveUnconfirmed');
  for (const code of Object.keys(keys) as Array<keyof typeof keys>) {
    message = message.replace(`[${code}] ${MODEL_SELECTION_ERRORS[code]}`, t(keys[code]));
  }
  const recoveryKeys = {
    top_up_balance: 'chat.error.tokenDanceTopUp',
    reauthorize_api_key: 'chat.error.tokenDanceReauthorize',
    api_key_quota: 'chat.error.tokenDanceQuota',
  } as const;
  for (const action of Object.keys(recoveryKeys) as Array<keyof typeof recoveryKeys>) {
    message = message.replace(TOKENDANCE_RECOVERY_ERRORS[action], t(recoveryKeys[action]));
  }
  return message;
}
