# CodePilot 官网与 README 截图

所有图片来自当前工作区的 Electron Dev 客户端实拍。官网按语言引用独立素材；英文 README 使用 `en/`，中文 README 使用 `zh/`，日文 README 使用英文界面截图（应用目前提供中英文界面）。

| 中文文件 | 英文文件 | 页面与真实状态 |
| --- | --- | --- |
| `zh/chat-window.webp` | `en/chat-window.webp` | `/chat`，空白对话首页，项目和个人助理入口；未发送消息 |
| `zh/plugins-window.webp` | `en/plugins-window.webp` | `/plugins`，本机已安装的公开 Skills 列表；35 为截图环境实测数量，不代表默认安装数量 |
| `zh/providers-window.webp` | `en/providers-window.webp` | `/settings/providers` → 添加服务，实际可选服务类型；Codex Account 的登录状态来自本机 CLI 检测，未添加或展示凭据 |

- 捕获日期：2026-09-05；CodePilot `0.67.13`，基线 commit `9bef7299` 的工作区。
- 环境：实际 `electron/main.ts` / `preload.ts` 编译后的 Electron Dev 客户端，连接当前 Next.js Dev `127.0.0.1:3220`；浅色、默认 macOS 原生样式。语言通过应用「设置 → 通用 → 语言」切换，不翻译或合成截图文字。Skills 自身描述保持原始语言，因此英文界面内仍可能出现中文 Skill 描述。
- 隔离数据：`CLAUDE_GUI_DATA_DIR=/private/tmp/codepilot-native-site-capture-20260905/data`，`CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS=1`；Electron userData 和 Documents 也重定向到同一个临时目录。没有导入真实会话、API Key 或 Provider 记录，没有生成假的对话、用量或模型响应。
- 捕获方式：经用户明确允许，使用 macOS `screencapture -x -o -l <Dev-window-id>`，只拍摄本次 Dev 窗口；窗口保持完全位于屏幕内。原始 PNG 为 Retina 2560 × 1720（逻辑窗口 1280 × 860）。
- 用户明确要求保留完整窗口，接受顶部系统控制标记。成品 **2560 × 1720（64:43）**，直接由原始 PNG 转码，不裁切、不拼接标题栏、不重绘产品内容。已撤销上一轮裁去顶部 104px 的做法。Next.js 开发角标通过自带 Preferences → Hide 隐藏。
- 输出：WebP quality 92，保留原始完整分辨率，不放大；每语言三张约 350–380 KB。官网轮播框和图片 intrinsic 尺寸匹配 64:43，保留现有自动轮播和缓动。
- 两种语言首页的 OG/Twitter 图片使用各自 `chat-window.webp`；站点默认 `../og-image.png` 来自英文首页。Logo、favicon 与 README 图标继续从仓库 `build/icon.png` / `build/icon.ico` 派生。
- 原始 PNG、六图联系表和站点验证截图保存在本次本地证据目录 `native-20260905/`，不把带控制标记的低清构图 JPEG 用作官网素材。

更新时重新拍摄对应语言的实际客户端，检查截图上下边缘完整、无私密数据（系统控制标记按用户要求保留），更新此索引；运行 `npm run test:smoke --workspace @codepilot/site` 验证两组图片实际加载、语言路径、比例和轮播。

- 官网截图外框与图片框使用连续三次贝塞尔路径；每角由两段镜像曲线构成，直边端曲率为零、对角连接曲率连续。ResizeObserver 按实际尺寸重算，外置 drop-shadow 保留同轮廓阴影，不依赖兼容性尚有限的 CSS corner-shape。完整窗口素材使用 `*-window.webp` 新文件名，避免旧裁切图的优化缓存。
