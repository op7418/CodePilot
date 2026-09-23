import type { MarketingContent } from './en';

export const zh: MarketingContent = {
  hero: {
    title: 'CodePilot',
    tagline: '你的 AI 工作台，专注',
    description: '在同一桌面工作区使用 Claude Code、Codex 和 CodePilot，处理项目任务与日常事务。',
    cta: '下载',
    secondaryCta: '查看文档',
    carousel: { label: 'CodePilot 界面' },
    screenshots: [
      {
        "src": "/screenshots/zh/chat-window.webp",
        "alt": "全新对话界面",
        "caption": "项目对话与个人助理，从同一个工作区开始"
      },
      {
        "src": "/screenshots/zh/plugins-window.webp",
        "alt": "技能与扩展",
        "caption": "集中管理 Skills、MCP 和命令行工具"
      },
      {
        "src": "/screenshots/zh/providers-window.webp",
        "alt": "连接 AI 服务",
        "caption": "选择订阅、API Key、第三方服务或本地模型"
      }
    ],
  },
  features: {
    title: '多个 Agent，一个工作台。',
    titleLight: '把对话、文件、工具和个人助理放在一起。',
    subtitle: '',
    items: [
      {
        icon: 'MessageSquare',
        title: '多会话聊天',
        description: '多个会话独立运行，各自保持上下文。',
      },
      {
        icon: 'Layers',
        title: '多 Agent 切换',
        description: '新对话，自由选择 Agent。',
      },
      {
        icon: 'Shield',
        title: '权限控制',
        description: '按需设置 Agent 的审批方式。',
      },
      {
        icon: 'FolderOpen',
        title: '项目工作区',
        description: '实时查看文件和审查更改。',
      },
      {
        icon: 'Brain',
        title: '个人助理',
        description: '在助理工作区保存偏好与记忆。',
      },
      {
        icon: 'Sparkles',
        title: '技能与工具',
        description: '通过 Skills、MCP 和 CLI 扩展能力。',
      },
      {
        icon: 'Bookmark',
        title: '会话持久化',
        description: '重启后从上次中断处继续。',
      },
      {
        icon: 'Compass',
        title: '引导设置',
        description: '连接服务，完成个人助理设置。',
      },
    ],
  },
  openSource: {
    title: '源码公开。',
    titleLight: '查看代码，连接自己的服务，一起改进 CodePilot。',
    highlights: [
      {
        icon: 'Code',
        title: '查看源码',
        description: '代码在 GitHub 公开，采用 BSL 1.1，个人与商业使用遵循相应许可。',
      },
      {
        icon: 'Key',
        title: '自选服务',
        description: '连接受支持的订阅、API 凭据或本地模型，额度与费用由服务商决定。',
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
    titleLight: '账号、Agent、隐私和安装，你关心的问题。',
    items: [
      {
        "q": "CodePilot 可以免费使用吗？",
        "a": "CodePilot 按 BSL 1.1 公开源码。个人、教育、非营利和评估用途可免费使用；用于对外收费的产品或服务，或超过 100 名员工的组织内部使用，需另行获得商业授权。模型订阅和 API 费用由对应服务商收取。",
        "link": {
          "label": "查看许可证",
          "href": "https://github.com/op7418/CodePilot/blob/main/LICENSE"
        }
      },
      {
        "q": "需要订阅或 API Key 吗？",
        "a": "你需要一种可用的模型接入方式：受支持的订阅授权、API Key、套餐凭据或本地模型服务，不必单独购买 Claude Code 订阅。不同 Agent 支持的接入方式不同，应用会按所选 Agent 展示可用的服务商和模型；账号额度与计费以服务商为准。"
      },
      {
        "q": "支持哪些 AI 服务和模型？",
        "a": "可连接 Anthropic、OpenRouter、DeepSeek、GLM、Kimi 等服务，配置 Anthropic 或 OpenAI 兼容 API，也可通过 Ollama 使用本地模型。具体模型、工具调用和图片输入能力取决于所选 Agent、服务商及模型，并非所有组合都通用。"
      },
      {
        "q": "同一个聊天里可以切换 Agent 吗？",
        "a": "新聊天可以选择 Claude Code、Codex 或 CodePilot。首次发送后，这个聊天会固定使用选定的 Agent；要换 Agent，请新建聊天。同一 Agent 内可以按兼容性更换模型或服务商，但可能影响上下文缓存与费用。"
      },
      {
        "q": "必须安装 Claude Code 或 Codex CLI 吗？",
        "a": "使用内置 CodePilot Agent 不需要额外安装 CLI。选择 Claude Code 或 Codex 时，需要对应的 CLI 和有效的登录或服务商凭据，可按应用中的安装引导完成准备。可用工具和模型能力取决于所选 Agent。"
      },
      {
        "q": "我的对话和数据会发到哪里？",
        "a": "对话历史与设置保存在本地。发起 AI 请求时，相关消息、附件和工具结果会发送给你选择的服务商；启用 MCP、Bridge 等联网扩展时，也会与相应服务交换数据。正式版包含匿名错误与版本健康上报，可在设置中关闭，重启后完全生效。"
      },
      {
        "q": "支持哪些平台，如何更新？",
        "a": "提供 macOS（Apple Silicon 与 Intel）、Windows（x64）和 Linux（x64 / arm64）的预编译安装包。Linux 可下载 AppImage、DEB 或 RPM。当前 macOS 和 Windows 正式版支持应用内检查更新，Linux 需手动下载安装新版本。",
        "link": {
          "label": "下载最新版本",
          "href": "https://github.com/op7418/CodePilot/releases/latest"
        }
      }
    ],
  },
  audience: {
    title: '为日常使用而设计。',
    subtitle: '面向需要 AI 协助项目与日常事务的人。',
    items: [
      {
        title: '长期代码库',
        description: '在持续数月的开发中保持上下文有序。',
      },
      {
        title: '多 Provider',
        description: '为任务选择兼容的服务商和工具。',
      },
      {
        title: '持久上下文',
        description: '积累 persona、memory 和 onboarding。',
      },
      {
        title: '随时随地',
        description: 'CodePilot 运行时，通过已配置的 Bridge 渠道向桌面 Agent 发送任务。',
      },
    ],
  },
  quickstart: {
    title: '三步开始使用。',
    steps: [
      {
        step: '1',
        title: '下载 CodePilot',
        description: '支持 macOS、Windows 和 Linux。',
      },
      {
        step: '2',
        title: '连接 AI 服务',
        description: '授权登录、添加 API 凭据，或连接本地模型服务。',
      },
      {
        step: '3',
        title: '开始对话',
        description: '选择 Agent 和模型，打开项目或个人助理。',
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
    readMore: '阅读更新详情',
    close: '关闭更新详情',
    source: '在 GitHub 上查看',
    unavailable: '暂时无法加载更新公告，可前往 GitHub 查看所有版本。',
    emptyBody: '此版本暂未提供更新说明。',
  },
  cta: {
    title: '准备好试试 CodePilot 了吗？',
    description: '连接 AI 服务，开始你的第一个任务。',
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
