# 媒体管线（Media Pipeline）

## 核心思路

让 MCP 工具和 CLI 工具生成的媒体内容可在聊天中内联显示，并自动保存到素材库。同时扩展了文件树预览和 Gallery 视频支持。

**重要限制**：Agent SDK 不会将 in-process MCP tool result 中的 `image` content block 透传到 conversation stream——图片数据只走 SDK 内部的 vision 通道（给 Claude 看），不出现在返回给消费者的 `tool_result.content` 中。因此 in-process MCP 工具无法直接通过 image block 向前端传递图片，需要使用 `MEDIA_RESULT_MARKER` 文本标记机制（详见下方）。外部 MCP server（stdio/sse/http）返回的 image block 则能正常提取。

## 目录结构

```
src/lib/
├── media-saver.ts              # 媒体保存：base64→文件→DB / 文件复制→DB
├── media-import-mcp.ts         # codepilot_import_media MCP tool + MEDIA_MCP_SYSTEM_PROMPT
├── image-gen-mcp.ts            # codepilot_generate_image MCP tool + MEDIA_RESULT_MARKER
├── image-generator.ts          # Gemini 图片生成（设计 Agent 和 MCP 共用）
├── claude-client.ts            # MCP 注册 + MEDIA_RESULT_MARKER 检测 + 内部工具自动审批

src/components/chat/
├── MediaPreview.tsx             # 统一媒体渲染组件：img/video/audio，支持 Lightbox
├── MessageItem.tsx              # 持久化消息：提取 media → 在 tool group 外独立渲染 MediaPreview
├── StreamingMessage.tsx         # 流式消息：同上，从 toolResults 提取 media 独立渲染

src/components/ai-elements/
├── tool-actions-group.tsx       # tool row 上的媒体指示图标（仅图标，不渲染图片）

src/components/layout/panels/
├── FileTreePanel.tsx            # 图片/视频/音频可点击预览
├── PreviewPanel.tsx             # MediaView 直接预览（sessionId → files/serve，或 fallback files/raw）

src/components/gallery/
├── GalleryGrid.tsx              # 视频缩略图 + 播放图标覆盖层
├── GalleryDetail.tsx            # 视频播放 <video controls>

src/app/api/
├── media/serve/route.ts         # 媒体文件服务（canonical .codepilot-media 路径校验）
├── media/gallery/route.ts       # 视频 MIME 检测
├── files/serve/route.ts         # 工作目录文件服务（sessionId 从 DB 获取 cwd）
├── chat/route.ts                # collectStreamResponse 自动保存 media blocks

src/types/index.ts               # MediaBlock 接口
src/hooks/useSSEStream.ts        # 解析 SSE tool_result 中的 media 字段
src/lib/stream-session-manager.ts # finalMessageContent 构建包含 media 字段
```

## 双路径架构

图片生成有两条独立路径，不要混用：

| 场景 | 触发条件 | 路径 | 确认 UI |
|------|----------|------|---------|
| **设计 Agent** | 底部"设计 Agent"按钮开启 | Claude 输出 `image-gen-request` 块 → 前端 `ImageGenConfirmation` 确认 UI（可编辑 prompt/比例/分辨率）→ 用户点击生成 → POST `/api/media/generate` → `generateSingleImage()` → 结果以 `image-gen-result` 块持久化 | 有 |
| **代码模式** | 关键词门控 `needsMediaMcp` | 注入 `codepilot_generate_image` / `codepilot_import_media` MCP → Claude 自动调用 → `MEDIA_RESULT_MARKER` → `MediaPreview` 内联渲染 | 无（自动执行） |

**为什么不统一为 MCP？** SDK 的 `acceptEdits` 权限模式会自动批准所有 MCP 工具调用，绕过 `canUseTool` 回调，无法在此拦截并展示自定义确认 UI。设计 Agent 需要确认 UI（让用户编辑 prompt），所以保持旧的前端驱动流程。

## 数据流

### 外部 MCP Server 媒体结果（自动入库）

仅适用于外部 MCP server（stdio/sse/http），in-process MCP 走下面的 MEDIA_RESULT_MARKER 路径。

```
外部 MCP Server 返回 tool_result
  content: [
    {type: "text", text: "生成完成"},
    {type: "image", data: "base64...", mimeType: "image/png"}
  ]
  ↓
claude-client.ts case 'user' — block.content 是数组
  → 提取 text → resultContent
  → 提取 image/audio blocks（有 data 字段）→ mediaBlocks
  ↓
SSE event: {type: "tool_result", data: {content, media: MediaBlock[], ...}}
  ↓
┌─ 服务端 (chat/route.ts collectStreamResponse):
│    media blocks（有 data）→ saveMediaToLibrary() → 写文件到 .codepilot-media/
│    → 插入 media_generations DB 记录 (provider='mcp')
│    → 替换 base64 为 localPath（防止 SQLite 膨胀）
│
└─ 客户端:
     useSSEStream 解析 media 字段 → toolResultsArray
     stream-session-manager finalMessageContent 包含 media
     → StreamingMessage / MessageItem → MediaPreview 独立渲染
```

### In-process MCP 媒体结果（MEDIA_RESULT_MARKER 机制）

适用于 `codepilot_import_media` 和 `codepilot_generate_image`。

```
MCP tool handler 保存图片到磁盘 + DB
  → 返回 text: "Imported successfully.\n__MEDIA_RESULT__[{type,mimeType,localPath,mediaId}]"
  ↓
claude-client.ts case 'user' — block.content 是字符串
  → resultContent 中检测 __MEDIA_RESULT__ marker
  → JSON.parse marker 后的内容 → mediaBlocks（有 localPath，无 data）
  → strip marker 文本（不显示在 UI 中）
  ↓
SSE event: {type: "tool_result", data: {content（已strip）, media: MediaBlock[], ...}}
  ↓
┌─ 服务端 (chat/route.ts collectStreamResponse):
│    media blocks 无 data → 直接透传（不触发 saveMediaToLibrary）
│    → 持久化到消息 contentBlocks（含 localPath）
│
└─ 客户端:
     同上，MediaPreview 通过 /api/media/serve?path=localPath 渲染
```

### CLI 工具导入（codepilot_import_media MCP tool）

```
用户: "帮我用 dreamina 生成一张小猫"
  ↓
Claude: 调用 dreamina CLI → 生成图片 → 得到文件路径
  ↓
Claude: 调用 codepilot_import_media MCP tool
  filePath: "./cat.png"
  prompt: "a cute cat", model: "seedance-2.0", resolution: "4096x4096"
  ↓
media-import-mcp.ts handler:
  → importFileToLibrary(filePath, {cwd: sessionWorkingDirectory, ...})
  → 复制到 .codepilot-media/ + DB 记录（含 model/resolution 等元数据）
  → 返回 text + __MEDIA_RESULT__ marker
  ↓
图片在聊天中内联显示 + 保存到素材库
```

**注意**：Claude 不应使用 `Read` 工具查看生成的图片——`Read` 只让 Claude 自己通过 vision 看到图片，**不会**在聊天界面显示给用户。`MEDIA_MCP_SYSTEM_PROMPT` 中已明确说明此规则。

### 文件树预览

```
用户点击文件树中的 .png/.mp4
  ↓
FileTreePanel → setPreviewFile(path) + setPreviewOpen(true)
  ↓
PreviewPanel — isMediaPreview(filePath) 命中
  → 跳过 /api/files/preview (不需要文本内容)
  → 直接渲染 <img>/<video>/<audio>
  → sessionId 有值: src = /api/files/serve?path=...&sessionId=...
  → sessionId 为空（pre-session）: src = /api/files/raw?path=...
```

## 媒体内联渲染

图片/视频/音频在聊天中的渲染位置是 `ToolActionsGroup` **外部**（不在折叠区域内），确保 tool group 折叠时图片仍然可见。

```
MessageItem / StreamingMessage
  ├── ToolActionsGroup（可折叠）
  │     └── ToolActionRow × N（图标 + 状态，有 media 时显示 🖼 指示）
  ├── MediaPreview（独立，不受折叠影响）
  │     └── 从 pairedTools / toolResults 提取所有 media
  └── 文字内容
```

`stream-session-manager.ts` 的 `finalMessageContent` 构建 `tool_result` block 时必须包含 `media` 字段，否则 streaming→持久化过渡期间图片会消失（因为 `StreamingMessage` 卸载后 `MessageItem` 用 `finalMessageContent` 渲染临时消息，缺少 media 就无法显示图片）。

**注意**：`ToolCallBlock.tsx` 虽然接受 `media` prop 并包含 `MediaPreview` 渲染逻辑，但当前没有被任何组件使用。实际的媒体渲染由 `MessageItem` 和 `StreamingMessage` 直接处理。

## 关键类型

```typescript
interface MediaBlock {
  type: 'image' | 'audio' | 'video';
  data?: string;        // base64（仅外部 MCP 传输时存在，保存后清除）
  mimeType: string;     // e.g. 'image/png', 'video/mp4'
  localPath?: string;   // 保存后的本地路径（MEDIA_RESULT_MARKER 和持久化后）
  mediaId?: string;     // media_generations.id
}
```

## 入库机制

| 来源 | 入库方式 | provider 字段 | 触发时机 |
|------|----------|---------------|----------|
| 外部 MCP tool result（有 base64 data） | 自动 | `'mcp'` | collectStreamResponse 处理 media blocks 时 |
| In-process MCP (`codepilot_import_media`) | MCP tool 内部 | `opts.source` e.g. `'dreamina'` | Claude 调用 MCP tool 时 |
| In-process MCP (`codepilot_generate_image`) | `generateSingleImage()` 内部 | `'gemini'` | Claude 调用 MCP tool 时 |
| 设计 Agent | `generateSingleImage()` 内部 | `'gemini'` | 用户在 ImageGenConfirmation 点击生成 |
| ~~REST 导入 (`/api/media/import`)~~ | 已删除 | — | 被 `codepilot_import_media` MCP tool 替代 |

## MCP 工具详情

### codepilot_import_media

- **文件**：`src/lib/media-import-mcp.ts`
- **参数**：`filePath`(必填), `title`, `prompt`, `source`, `model`, `resolution`, `aspectRatio`, `tags`
- **行为**：调用 `importFileToLibrary(filePath, {cwd: workingDirectory, ...})`，复制文件到 `.codepilot-media/`，创建 DB 记录（含完整元数据），返回 text + `MEDIA_RESULT_MARKER`
- **相对路径解析**：基于 `resolvedWorkingDirectory.path`（session 实际生效的 cwd），非进程 cwd

### codepilot_generate_image

- **文件**：`src/lib/image-gen-mcp.ts`
- **参数**：`prompt`(必填), `aspectRatio`, `imageSize`, `referenceImagePaths`
- **行为**：调用 `generateSingleImage()` 保存图片到磁盘 + DB，返回 text + `MEDIA_RESULT_MARKER`
- **参考图路径解析**：`image-generator.ts` 使用 `cwd` 参数解析相对路径

### 关键词门控

`needsMediaMcp`（`claude-client.ts`）：
- 匹配：`生成图片|画一|图像|图片|素材|保存.*素材|import.*library|save.*library|codepilot_import_media|codepilot_generate_image`
- **设计 Agent 模式（`imageAgentMode=true`）不触发**——避免与旧链路冲突
- `imageAgentMode` 精确判断：检测 `systemPromptAppend` 包含 `image-gen-request` 字符串（设计 Agent prompt 的特征），而非任意非空 `systemPromptAppend`

### 自动审批

`canUseTool` 中对以下工具自动返回 `{ behavior: 'allow' }`（SDK 前缀 `mcp__<server>__` 也匹配）：
- `codepilot_generate_image`
- `codepilot_import_media`
- `codepilot_load_widget_guidelines`

## 安全模型

| 端点 | 校验方式 |
|------|----------|
| **`/api/media/serve`** | `path.resolve` 规范化后，校验必须以 `~/.codepilot/.codepilot-media/` 的真实绝对路径开头（`startsWith` 检查） |
| **`/api/files/serve`** | 必须传 `sessionId`，服务端从 DB 获取 `session.working_directory`（不信任客户端路径）；校验 resolved path 严格在 cwd 子目录内（不含 cwd 自身） |
| **`/api/files/raw`** | 限制在用户 home 目录内（`isPathSafe` 检查）。`PreviewPanel` 在 `sessionId` 为空时 fallback 到此端点 |
| **`importFileToLibrary`** | 文件复制到 `.codepilot-media/`（非直接引用原路径）；相对路径基于 `cwd` 参数解析 |

## MIME 类型支持

`media-saver.ts` MIME_TO_EXT 和 `media-import-mcp.ts` mimeMap 保持一致：

| 类别 | 扩展名 | MIME |
|------|--------|------|
| Image | .png, .jpg, .jpeg, .gif, .webp, .svg, .avif, .bmp | image/* |
| Video | .mp4, .webm, .mov, .avi, .mkv | video/* |
| Audio | .mp3, .wav, .ogg, .flac, .aac | audio/* |

`media-import-mcp.ts` 的 mediaType 判断从 mimeType 前缀派生（`mimeType.startsWith('video/')` / `'audio/'`），不再用扩展名逐个匹配。

## 已清理的技术债务

- ~~`ToolCallBlock.tsx` 孤立代码~~ — 已删除。媒体渲染由 `MessageItem` / `StreamingMessage` 直接处理
- ~~`/api/media/import` REST 端点冗余~~ — 已删除。`codepilot_import_media` MCP tool 完全替代

## 剩余技术债务

- 设计 Agent 的 `ImageGenConfirmation` 通过 REST `/api/media/generate` 生成图片，结果以 `image-gen-result` markdown 块持久化，走 `ImageGenCard` 渲染。代码模式通过 MCP tool 生成图片，走 `MediaPreview` 渲染。两套渲染路径并存。原因：SDK `acceptEdits` 模式绕过 `canUseTool`，无法拦截 MCP 调用展示自定义确认 UI
