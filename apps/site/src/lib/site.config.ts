/**
 * Centralized site configuration.
 * All public URLs, repo links, and external references should be sourced from here
 * to avoid drift across layout, marketing content, and documentation.
 */
export const siteConfig = {
  name: 'CodePilot',
  description: 'Bring Claude Code, Codex, and CodePilot into one desktop workspace for project work and everyday tasks.',
  url: 'https://www.codepilot.sh',

  // Canonical repository
  repo: {
    owner: 'op7418',
    name: 'CodePilot',
    url: 'https://github.com/op7418/CodePilot',
    releases: 'https://github.com/op7418/CodePilot/releases',
    issues: 'https://github.com/op7418/CodePilot/issues',
  },

  // External links
  links: {
    discord: '#', // TODO: replace with actual Discord invite
    mcp: 'https://modelcontextprotocol.io',
    nodejs: 'https://nodejs.org',
    anthropicConsole: 'https://console.anthropic.com',
    openaiPlatform: 'https://platform.openai.com',
    googleAIStudio: 'https://aistudio.google.com',
    discordDev: 'https://discord.com/developers/applications',
    telegramBotFather: 'https://t.me/BotFather',
    feishuOpen: 'https://open.feishu.cn',
  },
} as const;

export type SiteConfig = typeof siteConfig;
