export interface MarketingContent {
  hero: {
    title: string;
    tagline: string;
    cta: string;
    secondaryCta: string;
    screenshots: { src: string; alt: string; caption: string }[];
  };
  features: {
    title: string;
    titleLight: string;
    subtitle: string;
    items: {
      icon: string;
      title: string;
      description: string;
      badge?: string;
    }[];
  };
  openSource: {
    title: string;
    titleLight: string;
    highlights: {
      icon: string;
      title: string;
      description: string;
    }[];
    githubCta: string;
    githubUrl: string;
  };
  faq: {
    title: string;
    titleLight: string;
    items: { q: string; a: string }[];
  };
  audience: {
    title: string;
    subtitle: string;
    items: { title: string; description: string }[];
  };
  quickstart: {
    title: string;
    steps: { step: string; title: string; description: string }[];
  };
  docs: {
    title: string;
    cards: { title: string; description: string; href: string }[];
  };
  releases: {
    title: string;
    titleLight: string;
    viewAll: string;
  };
  cta: {
    title: string;
    description: string;
    primary: string;
    secondary: string;
  };
  footer: {
    copyright: string;
    links: { text: string; url: string }[];
  };
}

export const en: MarketingContent = {
  hero: {
    title: 'CodePilot',
    tagline: 'Your desktop AI Agent for',
    cta: 'Download',
    secondaryCta: 'Documentation',
    screenshots: [
      { src: '/screenshots/chat.svg', alt: 'Chat interface', caption: 'Multi-session chat with Code, Plan, and Ask modes' },
      { src: '/screenshots/providers.svg', alt: 'Provider management', caption: 'Connect and switch between AI providers' },
      { src: '/screenshots/mcp-skills.svg', alt: 'MCP and Skills', caption: 'Extend with MCP servers and Skills' },
      { src: '/screenshots/workspace.svg', alt: 'Assistant Workspace', caption: 'Inspect files and review changes in real time' },
      { src: '/screenshots/bridge.svg', alt: 'Bridge messaging', caption: 'Continue conversations from your phone' },
    ],
  },
  features: {
    title: 'Everything you need to work with Claude Code.',
    titleLight: 'Conversations, providers, extensions, and project context — in one place.',
    subtitle: '',
    items: [
      {
        icon: 'MessageSquare',
        title: 'Multi-session chat',
        description: 'Run multiple conversations with independent context.',
      },
      {
        icon: 'Layers',
        title: 'Code · Plan · Ask',
        description: 'Three modes for different workflows.',
      },
      {
        icon: 'Shield',
        title: 'Permission control',
        description: 'Confirm before Claude modifies files.',
      },
      {
        icon: 'FolderOpen',
        title: 'Assistant Workspace',
        description: 'Inspect files and review changes live.',
      },
      {
        icon: 'Brain',
        title: 'Persona & Memory',
        description: 'Consistent behavior across sessions.',
      },
      {
        icon: 'Sparkles',
        title: 'Skills',
        description: 'Reusable prompt patterns you can share.',
      },
      {
        icon: 'Bookmark',
        title: 'Session persistence',
        description: 'Pick up where you left off after restart.',
      },
      {
        icon: 'Compass',
        title: 'Onboarding',
        description: 'Auto-detect project structure on first run.',
      },
    ],
  },
  openSource: {
    title: 'Fully open source.',
    titleLight: 'Use your own API key. No middleman, no markup.',
    highlights: [
      {
        icon: 'Code',
        title: 'Open Source',
        description: 'Every line of code is public on GitHub. Audit, fork, or contribute.',
      },
      {
        icon: 'Key',
        title: 'Bring Your Own Key',
        description: 'Connect directly to Anthropic, OpenAI, Google, or any provider with your own API key.',
      },
      {
        icon: 'Users',
        title: 'Community Driven',
        description: 'Built in the open with feedback from developers who use it every day.',
      },
    ],
    githubCta: 'Star on GitHub',
    githubUrl: 'https://github.com/op7418/CodePilot',
  },
  faq: {
    title: 'Frequently asked questions.',
    titleLight: 'Everything you need to know before getting started.',
    items: [
      {
        q: 'Is CodePilot really free?',
        a: 'Yes. CodePilot is completely free and open source. You only pay for the API usage from your chosen provider.',
      },
      {
        q: 'Which AI providers are supported?',
        a: 'Anthropic, OpenAI, Google, AWS Bedrock, and any OpenAI-compatible endpoint. You can switch between them at any time.',
      },
      {
        q: 'Do I need a Claude Code subscription?',
        a: 'No. CodePilot works with your own API key directly — no Claude Code subscription required.',
      },
      {
        q: 'Is my data sent to CodePilot servers?',
        a: 'No. All API calls go directly from your machine to the provider. CodePilot never sees your code or conversations.',
      },
      {
        q: 'Which platforms are supported?',
        a: 'CodePilot supports macOS (Apple Silicon & Intel), Windows (x64), and Linux (x64 & arm64). Download the latest version for your platform from the GitHub releases page.',
      },
    ],
  },
  audience: {
    title: 'Built for daily use.',
    subtitle: 'For developers who rely on Claude Code every day.',
    items: [
      {
        title: 'Long-lived codebases',
        description: 'Keep project context organized across months of work.',
      },
      {
        title: 'Multiple providers',
        description: 'Switch between providers and MCP servers without friction.',
      },
      {
        title: 'Persistent context',
        description: 'Build up persona, memory, and onboarding that stick.',
      },
      {
        title: 'Work on the go',
        description: 'Continue tasks from your phone while Claude keeps working.',
      },
    ],
  },
  quickstart: {
    title: 'Three steps to start.',
    steps: [
      {
        step: '1',
        title: 'Install Claude Code CLI',
        description: 'Install and sign in with your Anthropic account.',
      },
      {
        step: '2',
        title: 'Download CodePilot',
        description: 'Configure your preferred provider.',
      },
      {
        step: '3',
        title: 'Start a session',
        description: 'Connect Workspace, MCP, or Bridge as needed.',
      },
    ],
  },
  docs: {
    title: 'Documentation',
    cards: [
      { title: 'Getting Started', description: 'Installation and first steps.', href: '/docs' },
      { title: 'Providers', description: 'Configure AI providers.', href: '/docs/providers' },
      { title: 'MCP', description: 'Set up MCP servers.', href: '/docs/mcp' },
      { title: 'Bridge', description: 'Connect messaging platforms.', href: '/docs/bridge' },
      { title: 'Workspace', description: 'File inspection and context.', href: '/docs/workspace' },
    ],
  },
  releases: {
    title: 'What\'s New',
    titleLight: 'in CodePilot',
    viewAll: 'View all releases on GitHub',
  },
  cta: {
    title: 'Ready to try CodePilot?',
    description: 'Download and start working with Claude Code in a desktop workspace.',
    primary: 'Download',
    secondary: 'Read the docs',
  },
  footer: {
    copyright: '\u00a9 2026 CodePilot',
    links: [
      { text: 'GitHub', url: 'https://github.com/op7418/CodePilot' },
      { text: 'Docs', url: '/docs' },
      { text: 'Download', url: '/download' },
    ],
  },
};
