import type { TranslationKey } from '@/i18n';

export type TFunction = (
  key: TranslationKey,
  params?: Record<string, string | number>
) => string;

export function buildHelpContent(t: TFunction): string {
  return [
    `## ${t('help.title')}`,
    `### ${t('help.instantTitle')}`,
    `- **/help** - ${t('help.helpDesc')}`,
    `- **/clear** - ${t('help.clearDesc')}`,
    `- **/cost** - ${t('help.costDesc')}`,
    `### ${t('help.promptTitle')}`,
    `- **/compact** - ${t('help.compactDesc')}`,
    `- **/doctor** - ${t('help.doctorDesc')}`,
    `- **/init** - ${t('help.initDesc')}`,
    `- **/review** - ${t('help.reviewDesc')}`,
    `- **/terminal-setup** - ${t('help.terminalSetupDesc')}`,
    `- **/memory** - ${t('help.memoryDesc')}`,
    `### ${t('help.customSkillsTitle')}`,
    t('help.customSkillsDesc'),
    `**${t('help.tipsTitle')}:**`,
    `- ${t('help.tipSlash')}`,
    `- ${t('help.tipAt')}`,
    `- ${t('help.tipNewline')}`,
    `- ${t('help.tipFolder')}`,
  ].join('\n\n');
}
