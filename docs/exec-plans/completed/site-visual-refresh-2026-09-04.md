# 官网与 README 视觉更新

> 创建时间：2026-09-04
> 最后更新：2026-09-05
> 状态：Code complete / Tests pass / Smoke passed（含 Phase 8 完整截图与连续圆角）。提交验收阶段；未 push、未部署。

## 用户问题与取舍

当前桌面 UI 已迭代，官网仍挂载旧 `ChatDemo`，五张 SVG 占位图与 README 远程图片无法代表当前产品。官网 warm stone 色值偏离黑白灰品牌，下载按钮保留原有彩虹阴影作为品牌特征；更新公告手写解析只保留三级标题和顶层 bullet，导致正文结构丢失且页面无限拉长。

复用当前 `build/icon.png` / `build/icon.ico`，覆盖导航、页头、favicon、PWA、社交分享与三语 README。三张实拍截图使用当前 v0.67.13 工作区的网页渲染和隔离数据，展示聊天首页、Skills 与添加服务；未伪造对话、统计或凭据。图片源见 [素材索引](../../../apps/site/public/screenshots/README.md)。

用户在实施中补充参考图，明确要求“圆角矩形截图后面带抽象背景，中间几个点就行”。用 CSS 黑白灰抽象渐变托住原图，仅保留居中三圆点，提供点击、键盘和触屏滑动切换。用户在预览后明确补充每 5 秒自动轮播，切换使用 Framer Motion 的 0.6 秒左右滑动缓出；悬停、键盘焦点、触摸、后台标签及减少动态效果偏好时暂停，自动切换不触发屏幕阅读器播报。截图说明保留给辅助技术，实际图片不被修改。三图合计约 146 KB，提前加载以免首次切换出现空白。

公告保持 GitHub Release 为事实源，最多展示四个非 draft / prerelease 的稳定版本；与 FAQ 同宽的直角单列四行，桌面 128px / 手机 144px 高度，给两行纯文本摘要，Base UI Dialog 内完整渲染 Markdown（标题、嵌套列表、代码、表格、链接），正文独立滚动。使用 `react-markdown` + `remark-gfm`，跳过原始 HTML 并使用默认安全 URL 规则；不执行远程 MDX。接口失败有真实的不可用提示及 GitHub 入口，缺失日期隐藏，空正文不隐瞒该版本。

本次不改桌面运行逻辑、发版链路、既有未提交工作或暂缓的大规模站点重构。

## 状态总览

| Phase | 用户可见结果 / 验收入口 | 状态 |
| --- | --- | --- |
| 1 | 官网及三语 README 使用当前图标与真实截图 | ✅ 已完成 |
| 2 | 黑白灰抽象背景截图轮播与限高公告详情弹窗 | ✅ 已完成 |
| 3 | 中英文、移动端、深色、键盘操作与生产构建验证 | ✅ 已完成 |
| 4 | 每 5 秒自动轮播、彩虹下载阴影、Mac 圆角应用图标、灰色区域留白、多 Agent 文案与四条直角公告 | ✅ 已完成 |
| 5 | Framer Motion 左右滑动缓出；多 Agent 与其它特性正文统一限宽 | ✅ 已完成 |
| 6 | 更新中英文首页定位、特性与 FAQ，明确登录/费用/权限/隐私/平台边界，同步 metadata | ✅ 已完成 |
| 7 | 中英文官网分别展示对应语言的原生 Dev 截图 | ✅ 已完成：两组原生实拍、语言路径、比例与站点 smoke 验证通过 |
| 8 | 完整窗口截图；外框和截图框连续圆角 | ✅ 已完成 |

## 执行清单

- [x] Phase 1：核对图标源、捕获与检查截图、更新 README 与素材索引。
- [x] Phase 2：替换首页演示与色板，实现圆点轮播与 Markdown 公告弹窗。
- [x] Phase 3：站点 typecheck/build、相关回归及真实 UI smoke；开发与最终 production smoke 均通过。

- [x] Phase 4：按用户预览反馈完成六处修订；以中英官网首页/文档导航、轮播、下载按钮及公告弹窗验收，不涉及桌面产品逻辑或部署。

- [x] Phase 5：官网首页自动/手动轮播有平滑过渡、连续操作不乱序，特性正文限宽与简短文案；不改截图素材、图标、公告或桌面运行逻辑。

- [x] Phase 6：遍历官网营销文案，对照当前实现、LICENSE 与公开 Release 更新；不修改许可证、桌面运行逻辑、发版配置或完整文档站。FAQ 许可与下载提供原始来源入口；中英与移动端验收。

## 验证与防回归

- `npm run test`：5459 pass、1 skip、0 fail；首轮 sandbox 环境 7 个本地端口 EPERM，在批准的测试环境完整重跑通过。
- `npm run test --workspace @codepilot/site`：6 项真实数据解析/Markdown 渲染测试通过，覆盖段落与空正文、预发布过滤、缺失日期、坏 URL、摘要限长、表格/嵌套列表/代码与 HTML/危险 URL。
- `npm run typecheck --workspace @codepilot/site`、改动 TS/TSX 定向 ESLint、docs-drift 与 `git diff --check` 通过。最终 `npm run build --workspace @codepilot/site` 成功。
- `npm run test:smoke --workspace @codepilot/site`：专用真实页面 smoke，可用 `SITE_SMOKE_URL` 指定本地服务，`SITE_SMOKE_ARTIFACTS` 保存证据；必须先按站点默认 `npm run dev --workspace @codepilot/site` 或 production start 启动。测试使用真实公开 GitHub feed，需要网络可用。
- 最终网站预览证据：`/Users/op7418/.codex/visualizations/2026/09/04/01a06c87-72ac-73d1-afd3-d94497df8a57/`。

- 2026-09-05 本轮：site typecheck、定向 ESLint、6 项 release 单测、`git diff --check` 与真实页面 smoke 通过；桌面/手机/深色截图已检查。未修改构建配置或依赖，本轮未重跑生产构建，前一轮生产构建记录保留。
- 本轮证据：`/Users/op7418/.codex/visualizations/2026/09/04/01a06c87-72ac-73d1-afd3-d94497df8a57/followup-20260905/`。

- Phase 5：site typecheck、定向 ESLint、`git diff --check` 与本地真实页面 smoke 通过。逐帧检查正向/反向/首尾循环的中间位移、固定框高度、退出图辅助技术隐藏；连续点击最终选中正确。八项正文均不超过 288px。中英文/390px/深浅色/减少动态效果反例与既有公告/图标/下载验证通过。证据位于上述目录下 `motion-20260905/`，含 `results.txt` 和 `site-features.png`。

- Phase 6：site typecheck、定向 ESLint、6 项 release 单测、`git diff --check` 通过。完整 site smoke 覆盖中英文七项 FAQ、BSL/订阅/Agent 绑定/CLI/隐私/Linux 内容与来源链接、折叠区不可聚焦、答案展开完整高度、SEO/分享摘要、390px 导航不重叠，以及前五阶段交互回归；无页面错误或 hydration 警告。截图已人工查看，证据 `copy-20260905/`。
- Star 反例验证：直接对真实 `IntegrationsSection` 做 SSR + fetch fixture 检查，真实 6400/0 显示 6.4k/0，缺值/非法字符串/503/网络失败都隐藏计数，六例通过；禁止恢复固定回退数字。首轮临时脚本 ESM/CJS 导入包装未适配，修正导入后通过，产品代码未因此改动。

## Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-04 | Next.js site dev / Chromium | 公开 GitHub Release | N/A | 无凭据 | 中英入口、三圆点切换、键盘焦点及回绕、256px 公告、真实 Markdown 详情、正文内滚动、ESC / 关闭后焦点恢复、390px 手机、深色、减少动态效果 | ✅ | `scripts/smoke.mjs`；截图和 `results.txt` 见上述证据目录 |
| 2026-09-04 | Next.js site production / Chromium | 公开 GitHub Release | N/A | 无凭据 | 最终三圆点设计、所有同上交互与图片真实加载检查、浅/深色预览 | ✅ | 最终 `results.txt`、`site-carousel.png`、`site-home-desktop.png`、`site-home-mobile.png`、`site-home-dark.png`、`site-release-dialog.png` |
| 2026-09-05 | Next.js site dev / Chromium | 公开 GitHub Release | N/A | 无凭据 | 5 秒自动轮播；悬停/焦点/减少动态效果反例暂停；当前 Mac 圆角图标及文档导航内容哈希；双彩虹 CTA；灰色区留白；四条直角公告、Markdown 弹窗/滚动/焦点；390px 手机与深浅色、中英 | ✅ | `followup-20260905/results.txt`、`site-home-desktop.png`、`site-home-mobile.png`、`site-home-dark.png`、`site-releases.png`、`site-release-dialog.png` |
| 2026-09-05 | Next.js site dev / Chromium | 公开 GitHub Release | N/A | 无凭据 | Phase 5：左右滑动中间帧、首尾正向循环、快速连续点击、固定框高度、只暴露当前图、减少动态效果即时切换；八项正文统一限宽；既有中英/手机/图标/彩虹/公告回归 | ✅ | `motion-20260905/results.txt`、`site-features.png` 及各页面截图 |
| 2026-09-05 | Next.js site dev / Chromium | 公开 GitHub Release | N/A | 无凭据 | Phase 6：中英文七项 FAQ 事实文案/可点击来源/折叠焦点/展开全文；头部与 SEO/分享摘要；390px 导航与长文无溢出；轮播/公告/图标回归 | ✅ | `copy-20260905/results.txt`、`site-home-desktop.png`、`site-home-mobile.png`、`site-faq-zh-0.png`、`site-faq-zh-5.png`、`site-faq-zh-6.png`、`site-faq-en-0.png` 等 |

| 2026-09-05 | Electron Dev / macOS screencapture + site Chromium | 无新增服务，原生 UI | N/A | 未输入凭据 | Phase 7：中英文各三张真实窗口；原生 PNG 裁去系统栏；语言图片/分享 metadata/完整加载/比例/轮播/移动端及既有交互 | ✅ | `native-20260905/capture-contact-sheet.png`、`site-carousel.png`、`site-home-mobile.png`、`site-home-dark.png`、`results.txt` |

| 2026-09-05 | site dev / Chromium | N/A | N/A | 无新增凭据 | Phase 8：完整窗口 64:43；中英新素材路径；两层连续贝塞尔裁切；桌面/手机与轮播交互回归 | ✅ | `corners-20260905/results.txt`、`site-carousel.png`、`site-home-mobile.png` |

## 决策日志

- 2026-09-04：基于 `9bef7299` 工作区启动；保留已有 research、model identity E2E、tsconfig 与并行 ModelsSection/OpenRouter/i18n 改动。未提交。
- 2026-09-04：技术方案核对 [Base UI Dialog](https://base-ui.com/react/components/dialog) 与 [react-markdown](https://github.com/remarkjs/react-markdown) 官方文档；保留仓库已有锁定依赖版本，不升级依赖树。
- 2026-09-04：内置浏览器两次连接超时后停止重试，用既有 Playwright 的独立 Chromium 捕获当前 UI；不接管用户浏览器。临时桌面数据目录和编译目录隔离，结束后清理专用编译产物与自动添加的 tsconfig include。
- 2026-09-04：以用户补充参考图覆盖第一轮“箭头 + 页码 + 说明”设计；最终只保留圆点，取消自动播放。此前的 SSR 媒体偏好 hydration 风险也随简化消除。
- 2026-09-04：实际测试发现英文首页旧 middleware 将 `/` rewrite 成 `/en/`，Next trailing slash 重定向再和隐藏默认 locale 相互冲突；根路径改写为 `/en`，保留其它语言策略，真实 `/` 和 `/docs` 均返回 200。本地服务按默认 hostname 启动，避免显式 127.0.0.1 和 Next middleware 内部 localhost 的跨主机重写。
- 2026-09-04：第一轮完整 site build 通过；截图检查发现隐藏图片 lazy load 可在切换时暂时空白，已对约 146KB 的三张截图采用提前加载并声明 quality 90，最终重新构建验证。

- 2026-09-04：最终生产构建及 production smoke 全部通过；真实截图加载、英文根路由、中英/深浅色/390px、卡片限高与弹窗焦点均有证据。计划移至 completed；未提交，保留用户控制的 push / 部署步骤。

- 2026-09-05：用户明确要求自动轮播与彩虹阴影。上轮把“几个点就行”误解为取消自动播放、把中性色扩大至品牌 CTA；本轮保留三个圆点，每 5 秒切换，悬停/焦点/触摸/后台/减少动态效果时暂停，并恢复独立彩虹阴影。网页 logo 统一经过 `BrandLogo` 组件加载当前 Mac 圆角应用图标，使用 Next 静态 import 的内容哈希避开旧 URL 缓存；正文灰色区域与视口留边并增加底部空间。公告用同 FAQ 宽度的直角单列四行、两行摘要和限高详情弹窗；文案根据真实 RuntimeSelector 选择入口表达新对话多 Agent 选择。

- 2026-09-05：用户看到中途透明 SVG 预览后纠正，Logo 必须保留 Mac 图标的圆角矩形底板，不能只放核心点阵。已统一采用现有 `build/icon.png` 同源 PNG，以静态 import 更新缓存 URL；页头由 96/112px 缩至 80/96px（手机/桌面），保留图标自带留白。该明确反馈覆盖中途 SVG 方案。

- 2026-09-05：最终 Mac 图标版本通过全部本轮验证，开发预览继续运行于 `http://localhost:3001/zh`；计划重新归档 completed。中途 SVG 版本 smoke 在用户实时反馈后因预期已变而停止匹配，更新用例后整套重跑通过。

- 2026-09-05：用户反馈图片直接切换太生硬、多 Agent 比其他特性显宽。实测两列均 352px，但原说明更长且无独立正文限宽。统一正文最大 18rem 并缩短中英文 Agent 说明；最终截图发现中文尾字单独换行，补充 text-balance 均衡短段落行长并再次截图确认。复用已安装 Framer Motion 的 AnimatePresence/motion.figure 实现 0.6 秒左右滑动缓出，固定 8:5 框避免布局跳动；进入/退出方向沿实际操作，保留自动轮播、悬停/焦点暂停及减少动态效果偏好。退出图从辅助技术树隐藏，三张优化图片提前缓存。技术参考：https://motion.dev/docs/react-animate-presence 与 https://motion.dev/docs/react-accessibility。

- 2026-09-05：Phase 5 定向静态检查与完整 site UI smoke 通过，检查特性区实拍后完成；未新增依赖，未重新运行生产构建或 root 全量测试（未提交）。计划归档 completed，保留运行中的本地预览。

## Phase 6 文案事实核对

| 旧表述 / 缺口 | 更新依据与取舍 | Source breadcrumb |
| --- | --- | --- |
| 多模型客户端、只提 Claude 或 API Key | 桌面 AI 工作台；Claude Code / Codex / CodePilot，受支持的订阅授权/API/套餐/本地服务 | `src/lib/runtime/runtime-catalog.ts`、`src/components/settings/ProviderManager.tsx` OAuth entries 与分组、`src/lib/runtime/native-runtime.ts` |
| 所有/任何服务商、17+ 预设 | 删除固定计数与全兼容承诺，用实际预设举例并保留 Agent/协议能力限制 | `src/lib/provider-catalog.ts` VENDOR_PRESETS / openai-compatible、`src/lib/runtime/thread-execution-binding.ts` |
| 一律修改前确认、Code-Plan-Ask 等旧模式说明 | 权限档位决定确认方式；Agent 首次发送后固定，换 Agent 新建聊天 | `src/lib/permission/profile.ts`、`src/lib/runtime/thread-execution-binding.ts` |
| Skills 只是提示模板，Onboarding 首次扫描项目 | Skills/MCP/CLI 扩展；助理设置引导与持久偏好 | `src/lib/onboarding-processor.ts`、`src/lib/assistant-workspace.ts`、截图对应当前插件 UI |
| 完全免费且开源 | 按 BSL 1.1 公开源码，明确免费用途/商业边界和模型费用；不修改许可 | 根 `LICENSE`；已核对公开 main/LICENSE 相同条款 |
| 所有数据绝不上报 | 本地会话；AI/扩展按需发送数据；正式版匿名错误与版本健康上报可关，完全生效需重启 | `src/lib/telemetry/contract.ts`、`src/instrumentation.ts`、`src/lib/telemetry/sanitize.ts`、`src/components/settings/GeneralSection.tsx:268`、`src/i18n/zh.ts:162` |
| Linux 需源码构建 | 当前有 AppImage/DEB/RPM，x64/arm64；Windows 仅 x64，Mac Apple Silicon/Intel | 2026-09-05 GitHub REST `/repos/op7418/CodePilot/releases/latest` 返回 `v0.67.13` / 20 个资产；网页搜索缓存仍为 0.67.10，采用新鲜 REST 资产结果 |
| Star 请求失败回退固定 3.4k | 失败隐藏计数，避免旧数字充当实时统计 | `apps/site/src/components/marketing/IntegrationsSection.tsx` |

- 2026-09-05：Phase 6 完成。FAQ 从五项更新为七项，许可/下载链接采用原始来源；新增 aria-expanded/controls 与关闭区域 inert，避免隐藏链接仍可聚焦。文案加长后的截图采用完整展开高度验收；手机导航缩短间距、语言不换行、小屏隐藏 Star 数，中文 Docs 改为“文档”。最终两轮 site smoke 均通过（第二轮加强完整展开与导航重叠断言），计划归档 completed，保留本地预览。没有重新运行 root 全量测试或生产构建，没有部署。

## Phase 7：原生 Dev 截图与语言分离

用户反馈网页截图缺少客户端质感。使用当前工作区编译的 Electron Dev + 独立数据库与配置，分别通过应用语言设置拍摄中文、英文的首页、插件、添加服务。官网和对应语言 README 引用独立素材；不伪造会话、响应或统计，不修改桌面运行逻辑。

- [x] 启动隔离的 Electron Dev（3220）和官网预览（3001）。
- [x] 完成两组原生窗口截图并更新素材来源。
- [x] 接入中英文官网和 README，检查实际图片加载与比例。
- [x] 运行站点定向检查与 smoke，回写证据。

2026-09-05 决策：基线工作区未提交。Computer Use 截图带控制标记且压缩分辨率，已请求用户允许改用 macOS 原生 screencapture，仅捕获隔离 Dev 窗口。语言和页面准备继续进行。

- 已通过真实设置界面切换并检查两种语言。六张构图预览保存在 `native-20260905/*-preview.jpeg`，由于控制叠层与分辨率限制未用作正式官网素材；这批 JPEG 仅为初步构图记录，正式素材已改用后续原生高清 PNG。

- 2026-09-05：用户明确允许原生 `screencapture`。实际 Dev 窗口 1280 × 860，原始 PNG 2560 × 1720；首轮连续捕获发现系统共享提示及窗口部分移出屏幕后底部透明，重拍完整窗口并统一裁去顶部 104px 系统栏。最终 2560 × 1616 WebP 保留实际客户端材质与分栏，没有重绘或合成 UI。两种语言各三张，原始 Skill 描述不改写。
- 2026-09-05：Phase 7 完成，工作区未提交。中英文营销数据、README、分享 metadata 使用各自语言目录，日文 README 使用英文 UI；旧共享 WebP 移除。轮播 intrinsic 尺寸和固定框统一 160:101，防止拉伸或裁切。site typecheck、定向 ESLint、6 项单测、`git diff --check` 与完整 site smoke 通过；新增真实加载/语言 URL/分享图/比例断言，中英桌面、390px 手机、深浅色、轮播及公告交互回归均通过，无页面错误/hydration 警告。已查看六图联系表、官网轮播与手机截图。本轮未修改桌面运行逻辑、依赖或构建流程，未重跑 root 全量测试或生产构建，未部署。
- 防回归：`apps/site/public/screenshots/README.md` 记录真实来源、语言、裁切边界与输出规格；`scripts/smoke.mjs` 检查三张图均真实加载、URL 与页面语言一致、分享图语言一致、160:101 比例。原始图和 `results.txt` 等证据：`/Users/op7418/.codex/visualizations/2026/09/04/01a06c87-72ac-73d1-afd3-d94497df8a57/native-20260905/`。保留本地官网 3001 与截图 Dev 客户端 3220 供用户预览，专用空白背景进程已停止。

## Phase 8：完整截图与连续圆角

用户明确认为裁去系统栏破坏构图，接受原始控制标记。恢复六张完整 Dev PNG，并同步尺寸、分享图、README。外框和截图框使用两段三次贝塞尔构成每个角，直边进入曲线处曲率从零开始，镜像连接；通过 ResizeObserver 随尺寸更新，保留自动轮播和阴影。参考 Figma 连续圆角原理：https://www.figma.com/blog/desperately-seeking-squircles/ 。CSS corner-shape 尚非跨浏览器 Baseline，采用通用 clip-path path 而不依赖该属性。

- [x] 恢复完整 2560 × 1720 素材与 64:43 比例。
- [x] 实现两层连续贝塞尔圆角与响应式适配。
- [x] 验证中英文、桌面与移动端、轮播与裁切，并回写证据。

- 2026-09-05：Phase 8 完成，未提交。用户反馈覆盖 Phase 7 的裁切选择，全部恢复完整 PNG，只做 WebP 转码；使用 `*-window.webp` 新路径避免旧图缓存，中英官网、三语 README 与 OG/Twitter 同步。外层与截图框每角由两个三次贝塞尔段组成，端点曲率为零且对角镜像连接；ResizeObserver 保持响应式尺寸。clip-path 由独立外层 drop-shadow 包裹，保留同轮廓阴影。实现位于现有 ScreenshotCarousel/global.css，无新增依赖。
- 验证：site typecheck、定向 ESLint、`git diff --check`、完整 site smoke 通过；包含真实语言素材加载、新 64:43 比例、两层八段贝塞尔裁切、自动/手动滑动、快速连续操作、390px 手机与中英深浅色、FAQ/公告/图标回归，无页面错误/hydration 警告。已人工查看 `corners-20260905/site-carousel.png` 与 `site-home-mobile.png`。本轮纯视觉修订未重新运行 root 全量测试或生产构建，无提交/部署。原始图完全保留，不合成或抹去系统标记。

## 提交验收

2026-09-05：用户明确要求提交本次官网与 README 改动。提交范围仅包含 `apps/site/`、三语 README、`docs/icon-readme.png`、本计划及其索引条目、站点依赖的 workspace lockfile 声明；不纳入并行 Runtime / OAuth / 模型变更。使用基线加本次变更的独立副本运行完整提交 hook：lint-hooks、lint-staged/docs-drift、harness boundary、typecheck 通过，单测 5459 pass / 1 skip；站点 typecheck 与 6 条单测通过。临时 worktree 的 Git 环境影响了 Git 初始化测试，改用独立副本后通过，未修改或跳过检查。并行任务提交后，在当前主目录按官网范围暂存并再次运行提交门禁；没有 push 或部署。
