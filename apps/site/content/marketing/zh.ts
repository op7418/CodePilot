import type { MarketingContent } from './en';

export const zh: MarketingContent = {
  hero: {
    title: 'CodePilot',
    tagline: '你的桌面 AI Agent，专注',
    cta: '下载',
    secondaryCta: '查看文档',
    screenshots: [
      { src: '/screenshots/chat.svg', alt: '聊天界面', caption: '多会话聊天，支持 Code、Plan、Ask 模式' },
      { src: '/screenshots/providers.svg', alt: 'Provider 管理', caption: '连接并切换多个 AI 提供商' },
      { src: '/screenshots/mcp-skills.svg', alt: 'MCP 和 Skills', caption: '通过 MCP 和 Skills 扩展能力' },
      { src: '/screenshots/workspace.svg', alt: 'Assistant Workspace', caption: '实时检查文件和审查更改' },
      { src: '/screenshots/bridge.svg', alt: 'Bridge 消息', caption: '在手机上继续对话' },
    ],
  },
  features: {
    title: '使用 Claude Code 所需的一切',
    titleLight: '对话、Provider、扩展和项目上下文——集于一处。',
    subtitle: '',
    items: [
      {
        icon: 'MessageSquare',
        title: '多会话聊天',
        description: '多个会话独立运行，各自保持上下文。',
      },
      {
        icon: 'Layers',
        title: 'Code · Plan · Ask',
        description: '三种模式，适配不同工作流。',
      },
      {
        icon: 'Shield',
        title: '权限控制',
        description: '修改文件前需你确认。',
      },
      {
        icon: 'FolderOpen',
        title: 'Assistant Workspace',
        description: '实时查看文件和审查更改。',
      },
      {
        icon: 'Brain',
        title: 'Persona 和 Memory',
        description: '跨会话保持一致的行为。',
      },
      {
        icon: 'Sparkles',
        title: 'Skills',
        description: '可复用、可分享的提示模式。',
      },
      {
        icon: 'Bookmark',
        title: '会话持久化',
        description: '重启后从上次中断处继续。',
      },
      {
        icon: 'Compass',
        title: 'Onboarding',
        description: '首次运行自动检测项目结构。',
      },
    ],
  },
  openSource: {
    title: '完全开源。',
    titleLight: '使用你自己的 API Key，没有中间商，没有加价。',
    highlights: [
      {
        icon: 'Code',
        title: '开源',
        description: '所有代码公开在 GitHub，可审查、可 fork、可贡献。',
      },
      {
        icon: 'Key',
        title: '自带 Key',
        description: '直连 Anthropic、OpenAI、Google 或任何 Provider，使用你自己的 API Key。',
      },
      {
        icon: 'Users',
        title: '社区驱动',
        description: '在开发者社区的反馈中持续迭代。',
      },
    ],
    githubCta: '在 GitHub 上 Star',
    githubUrl: 'https://github.com/op7418/CodePilot',
  },
  faq: {
    title: '常见问题。',
    titleLight: '开始使用前你可能想了解的一切。',
    items: [
      {
        q: 'CodePilot 真的免费吗？',
        a: '是的。CodePilot 完全免费且开源，你只需为所选 Provider 的 API 用量付费。',
      },
      {
        q: '支持哪些 AI Provider？',
        a: 'Anthropic、OpenAI、Google、AWS Bedrock 以及任何 OpenAI 兼容接口，随时切换。',
      },
      {
        q: '需要 Claude Code 订阅吗？',
        a: '不需要。CodePilot 直接使用你自己的 API Key，无需 Claude Code 订阅。',
      },
      {
        q: '我的数据会发送到 CodePilot 服务器吗？',
        a: '不会。所有 API 调用从你的电脑直接发送到 Provider，CodePilot 不会接触你的代码或对话。',
      },
      {
        q: '支持哪些平台？',
        a: 'CodePilot 支持 macOS（Apple Silicon 和 Intel）、Windows（x64）以及 Linux（x64 和 arm64）。前往 GitHub Releases 页面下载对应平台的最新版本。',
      },
    ],
  },
  audience: {
    title: '为日常使用而设计。',
    subtitle: '面向每天依赖 Claude Code 的开发者。',
    items: [
      {
        title: '长期代码库',
        description: '在持续数月的开发中保持上下文有序。',
      },
      {
        title: '多 Provider',
        description: '在提供商和 MCP 服务器之间无缝切换。',
      },
      {
        title: '持久上下文',
        description: '积累 persona、memory 和 onboarding。',
      },
      {
        title: '随时随地',
        description: '通过手机继续任务，Claude 持续工作。',
      },
    ],
  },
  quickstart: {
    title: '三步开始使用。',
    steps: [
      {
        step: '1',
        title: '安装 Claude Code CLI',
        description: '安装并用 Anthropic 账户登录。',
      },
      {
        step: '2',
        title: '下载 CodePilot',
        description: '配置你偏好的 Provider。',
      },
      {
        step: '3',
        title: '开始会话',
        description: '按需连接 Workspace、MCP 或 Bridge。',
      },
    ],
  },
  docs: {
    title: '文档',
    cards: [
      { title: '快速开始', description: '安装与第一步。', href: '/docs' },
      { title: 'Providers', description: '配置 AI 提供商。', href: '/docs/providers' },
      { title: 'MCP', description: '设置 MCP 服务器。', href: '/docs/mcp' },
      { title: 'Bridge', description: '连接消息平台。', href: '/docs/bridge' },
      { title: 'Workspace', description: '文件检查与上下文。', href: '/docs/workspace' },
    ],
  },
  releases: {
    title: '更新公告',
    titleLight: '',
    viewAll: '在 GitHub 上查看所有版本',
  },
  cta: {
    title: '准备好试试 CodePilot 了吗？',
    description: '下载并开始在桌面工作区中使用 Claude Code。',
    primary: '下载',
    secondary: '阅读文档',
  },
  footer: {
    copyright: '\u00a9 2026 CodePilot',
    links: [
      { text: 'GitHub', url: 'https://github.com/op7418/CodePilot' },
      { text: '文档', url: '/zh/docs' },
      { text: '下载', url: '/zh/download' },
    ],
  },
};
