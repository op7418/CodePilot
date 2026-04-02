# 语音助手（浮窗 + MCP）

> 关联：[统一上下文层 Phase 4](../exec-plans/active/unified-context-layer.md#四phase-4-待开始浮窗助理)

## 核心想法

全局快捷键拉起浮窗，语音输入 → STT → 正常聊天流程 → TTS 播报回复。快进快出，不需要打开主窗口。

语音能力作为 **MCP server** 实现，不依赖 Claude Code 的 Channel 协议。参考 Channel 的架构思路（MCP server 桥接外部 IO），但完全由 CodePilot 自己控制。

## 架构

```
┌──────────────────────────────────────────┐
│  浮窗 UI（Electron BrowserWindow）         │
│                                          │
│  ┌───────────┐  ┌─────────────────────┐  │
│  │ VoiceBtn  │  │  LiveWaveform       │  │  ← ElevenLabs UI 组件
│  └─────┬─────┘  └─────────────────────┘  │
│        │         ┌─────────────────────┐  │
│        │         │  MicSelector        │  │  ← ElevenLabs UI 组件
│        │         └─────────────────────┘  │
│        ▼                                  │
│  useVoiceInput() hook                     │
│  - 录音控制 (MediaRecorder / Web Audio)    │
│  - 调 MCP tool transcribe() → 文字        │
│  - sendMessage() 走正常聊天流程             │
│  - 收到回复 → 调 MCP tool speak() → 播放   │
└──────────────────────────────────────────┘
        │ IPC
┌───────▼──────────────────────────────────┐
│  CodePilot Main Process                   │
│  Session Manager + Context Assembler      │
│  entryPoint: 'floating'                   │
│  → 只注入 workspace prompt（上下文小，快）   │
└───────┬──────────────────────────────────┘
        │ stdio
┌───────▼──────────────────────────────────┐
│  voice-mcp-server（独立进程）               │
│                                           │
│  tool: transcribe(audio) → string         │
│  tool: speak(text) → audio_url            │
│  tool: list_voices() → Voice[]  (可选)     │
│                                           │
│  STT 后端：Whisper local / OpenAI API      │
│  TTS 后端：系统原生 / OpenAI TTS API        │
│  自动降级：本地模型没装就 fallback 到 API     │
└───────────────────────────────────────────┘
```

### 为什么用 MCP 而不是直接内嵌

- 语音能力作为独立进程，崩溃不影响主应用
- STT/TTS 后端可替换（Whisper / OpenAI / ElevenLabs / 系统原生），MCP tool 接口不变
- 其他入口（Bridge、主窗口）将来也能调用同一套语音能力
- 遵循项目已有的 MCP 基础设施，不引入新的扩展机制

### 为什么不用 Claude Code Channel

Channel 是 Claude Code CLI 的私有协议（`notifications/claude/channel`），绑定 CLI 运行时。我们的场景：

- CodePilot 自己就是客户端，不需要通过 CLI 中转
- Pull 模式（前端主动调 MCP tool）已经够用，不需要 push notification
- 保持独立，不引入 Claude Code CLI 的运行时依赖

## 交互模式：Pull

用户主动按下录音按钮 → 录音 → 松手/静音检测停止 → 调 `transcribe()` → 文字发送 → 收到回复 → 调 `speak()` 播报。

```
按住 VoiceButton
  → state: recording, LiveWaveform 显示实时波形
  → MediaRecorder 录音

松手 / VAD 静音检测
  → state: processing
  → 调 voice MCP transcribe(audio_buffer)
  → 拿到文字，填入 MessageInput（或直接 sendMessage）

Claude 回复完成
  → 调 voice MCP speak(reply_text)
  → 浮窗播放音频
  → state: idle
```

Push 模式（免唤醒持续监听）作为 V2 考虑，需要 MCP notification 机制支持。

## ElevenLabs UI 可复用组件

从 [ui.elevenlabs.io](https://ui.elevenlabs.io/) 拉取，零服务依赖，纯浏览器 API：

| 组件 | 用途 | 关键特性 |
|------|------|---------|
| **LiveWaveform** | 实时音频波形 | Canvas 渲染，Web Audio API，static/scrolling 模式，idle→active→processing 状态动画，支持 deviceId 指定麦克风 |
| **VoiceButton** | 录音按钮 | idle/recording/processing/success/error 五态，内嵌 LiveWaveform，可配 label/trailing/icon |
| **MicSelector** | 麦克风选择 | `navigator.mediaDevices` 枚举设备，下拉选择，静音切换，实时预览波形 |

安装方式：`npx @elevenlabs/cli@latest components add voice-button live-waveform mic-selector`

**不可用的组件**：
- `SpeechInput` — 绑定 ElevenLabs Scribe WebSocket STT（`useScribe` hook）
- `ConversationBar` — 绑定 ElevenLabs Agent WebRTC（`useConversation` hook）

这两个的 UI 结构（复合组件模式、状态管理）可参考，但核心逻辑要自己实现。

## voice-mcp-server 设计

```typescript
// tool: transcribe
interface TranscribeInput {
  audio: string       // base64 encoded audio
  format: 'webm' | 'wav' | 'mp3'
  language?: string   // 'zh' | 'en' | 'auto'
}
interface TranscribeOutput {
  text: string
  language: string
  duration_ms: number
}

// tool: speak
interface SpeakInput {
  text: string
  voice?: string      // voice id or name
  speed?: number      // 0.5 - 2.0
}
interface SpeakOutput {
  audio_url: string   // file:// URL to temp audio file
  duration_ms: number
}
```

STT 后端优先级：
1. 本地 Whisper（`whisper.cpp` 或 `mlx-whisper`，macOS 用户友好）
2. OpenAI Whisper API（fallback）
3. 浏览器 Web Speech API（最后兜底，质量差但零配置）

TTS 后端优先级：
1. macOS `say` / Windows SAPI（零配置，延迟低）
2. OpenAI TTS API（质量好，需要 API key）
3. ElevenLabs TTS API（可选，用户自带 key）

## 浮窗 Electron 实现要点

- `Tray` 常驻菜单栏
- `globalShortcut.register('CommandOrControl+Shift+Space')` 全局快捷键
- 独立 `BrowserWindow`：小尺寸、置顶、圆角、无边框
- Esc 或失焦隐藏（`hide()` 不 `close()`，保持进程热启动）
- 弹出时 `clipboard.readText()` + `clipboard.readImage()` 感知剪贴板
- Context Assembler 按 `entryPoint: 'floating'` 组装，只注入 workspace prompt

## 待确认的问题

- 录音格式：MediaRecorder 默认 webm/opus，Whisper 支持但需确认 Electron 的 Chromium 版本兼容性
- 音频传输：base64 over MCP stdio 还是写临时文件传路径？大段录音 base64 可能很大
- VAD（语音活动检测）：用 Web Audio API 的音量阈值简单实现，还是引入 `@ricky0123/vad-web`？
- 浮窗会话：固定一个长期会话（助理模式），还是每次新建？
- 快捷键冲突：`Cmd+Shift+Space` 可能跟 Spotlight / Raycast 冲突，需要可配置
