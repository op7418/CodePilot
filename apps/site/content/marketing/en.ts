import { siteConfig } from '../../src/lib/site.config';

export interface MarketingContent {
  hero: {
    notice?: {
      label: string;
      english: string;
      chinese: string;
      cta: string;
      href: string;
    };
    title: string;
    tagline: string;
    description: string;
    cta: string;
    secondaryCta: string;
    screenshots: { src: string; alt: string; caption: string }[];
    carousel: { label: string };
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
    items: { q: string; a: string; link?: { label: string; href: string } }[];
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
    readMore: string;
    close: string;
    source: string;
    unavailable: string;
    emptyBody: string;
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
    tagline: 'Your AI workspace for',
    description: siteConfig.description,
    cta: 'Download',
    secondaryCta: 'Documentation',
    carousel: { label: 'Inside CodePilot' },
    screenshots: [
      {
        "src": "/screenshots/en/chat-window.webp",
        "alt": "A new conversation",
        "caption": "Project conversations and a personal assistant in one workspace"
      },
      {
        "src": "/screenshots/en/plugins-window.webp",
        "alt": "Skills and extensions",
        "caption": "Manage Skills, MCP servers, and command-line tools"
      },
      {
        "src": "/screenshots/en/providers-window.webp",
        "alt": "Connect your AI services",
        "caption": "Choose subscriptions, API keys, third-party services, or local models"
      }
    ],
  },
  features: {
    title: 'Your agents, in one workspace.',
    titleLight: 'Work with conversations, files, tools, and a personal assistant.',
    subtitle: '',
    items: [
      {
        icon: 'MessageSquare',
        title: 'Multi-session chat',
        description: 'Run multiple conversations with independent context.',
      },
      {
        icon: 'Layers',
        title: 'Multiple agents',
        description: 'Choose your agent for each new conversation.',
      },
      {
        icon: 'Shield',
        title: 'Permission control',
        description: 'Set how your agent requests approval.',
      },
      {
        icon: 'FolderOpen',
        title: 'Project workspace',
        description: 'Inspect files and review changes live.',
      },
      {
        icon: 'Brain',
        title: 'Personal assistant',
        description: 'Keep preferences and memories in your assistant workspace.',
      },
      {
        icon: 'Sparkles',
        title: 'Skills & tools',
        description: 'Extend your agent with Skills, MCP, and CLI tools.',
      },
      {
        icon: 'Bookmark',
        title: 'Session persistence',
        description: 'Pick up where you left off after restart.',
      },
      {
        icon: 'Compass',
        title: 'Guided setup',
        description: 'Connect services and set up your assistant.',
      },
    ],
  },
  openSource: {
    title: 'Source available.',
    titleLight: 'Read the code, connect your services, and help improve CodePilot.',
    highlights: [
      {
        icon: 'Code',
        title: 'Read the source',
        description: 'Code is published on GitHub under BSL 1.1, with terms for personal and commercial use.',
      },
      {
        icon: 'Key',
        title: 'Your services',
        description: 'Connect supported subscriptions, API credentials, or local models. Your provider sets usage and billing.',
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
    titleLight: 'Accounts, agents, privacy, and getting started.',
    items: [
      {
        "q": "Can I use CodePilot for free?",
        "a": "CodePilot publishes its source under BSL 1.1. Personal, educational, nonprofit, and evaluation use is free. Use in products or services offered to third parties for a fee, or internal use by organizations with more than 100 employees, requires a separate commercial license. Your AI provider charges for model subscriptions and API usage.",
        "link": {
          "label": "Read the license",
          "href": "https://github.com/op7418/CodePilot/blob/main/LICENSE"
        }
      },
      {
        "q": "Do I need a subscription or an API key?",
        "a": "You need a working model connection: a supported subscription sign-in, API key, plan credentials, or a local model service. A Claude Code subscription is not required. Available connections differ by agent, and the app shows providers and models for the selected agent. Your provider determines account limits and billing."
      },
      {
        "q": "Which AI services and models can I use?",
        "a": "Connect services such as Anthropic, OpenRouter, DeepSeek, GLM, and Kimi, configure an Anthropic-compatible or OpenAI-compatible API, or use local models through Ollama. Model availability, tool use, and image input depend on your agent, provider, and model; not every combination is supported."
      },
      {
        "q": "Can I switch agents in the same conversation?",
        "a": "Choose Claude Code, Codex, or CodePilot when starting a conversation. After the first message, that conversation stays with its selected agent; start a new conversation to use another agent. You can change compatible models or providers within the same agent, which may affect context caching and cost."
      },
      {
        "q": "Do I have to install the Claude Code or Codex CLI?",
        "a": "The built-in CodePilot agent works without an additional CLI. Choosing Claude Code or Codex requires its corresponding CLI and a valid sign-in or provider credentials. Follow the setup guidance in the app. Available tools and model capabilities depend on the agent you choose."
      },
      {
        "q": "Where do my conversations and data go?",
        "a": "Conversation history and settings are stored locally. AI requests send relevant messages, attachments, and tool results to your chosen provider. Networked extensions such as MCP and Bridge also exchange data with their respective services. Stable releases include anonymous error and release-health reporting, which you can disable in settings; restart the app for the change to fully take effect."
      },
      {
        "q": "Which platforms are supported, and how do I update?",
        "a": "Prebuilt installers are available for macOS (Apple Silicon and Intel), Windows (x64), and Linux (x64 / arm64). Linux downloads include AppImage, DEB, and RPM packages. Current stable macOS and Windows releases support in-app update checks; Linux updates require downloading and installing a new package.",
        "link": {
          "label": "Download the latest release",
          "href": "https://github.com/op7418/CodePilot/releases/latest"
        }
      }
    ],
  },
  audience: {
    title: 'Built for daily use.',
    subtitle: 'For people working with AI on projects and everyday tasks.',
    items: [
      {
        title: 'Long-lived codebases',
        description: 'Keep project context organized across months of work.',
      },
      {
        title: 'Multiple providers',
        description: 'Choose compatible providers and tools for each task.',
      },
      {
        title: 'Persistent context',
        description: 'Build up persona, memory, and onboarding that stick.',
      },
      {
        title: 'Work on the go',
        description: 'Message your desktop agent through a configured Bridge channel while CodePilot is running.',
      },
    ],
  },
  quickstart: {
    title: 'Three steps to start.',
    steps: [
      {
        step: '1',
        title: 'Download CodePilot',
        description: 'Available for macOS, Windows, and Linux.',
      },
      {
        step: '2',
        title: 'Connect an AI service',
        description: 'Sign in, add API credentials, or connect a local model service.',
      },
      {
        step: '3',
        title: 'Start a conversation',
        description: 'Choose an agent and model, then open your project or personal assistant.',
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
    readMore: 'Read release notes',
    close: 'Close release notes',
    source: 'View on GitHub',
    unavailable: 'Release notes are currently unavailable. You can find every release on GitHub.',
    emptyBody: 'No release notes were provided for this version.',
  },
  cta: {
    title: 'Ready to try CodePilot?',
    description: 'Connect an AI service and start your first task.',
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
