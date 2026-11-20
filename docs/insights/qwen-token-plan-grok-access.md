# 千问 Token Plan 与 xAI Grok 接入：产品取舍

## 用户真正遇到的问题

这次不是简单地“多加几个模型”。用户购买的是有明确身份、目录、条款和计费边界的产品，但旧 Provider 体系主要靠 URL 识别服务商：

- Qwen Personal 与 Team 共用地址，URL 无法说明用户买了哪个套餐。
- Coding Plan、Token Plan Personal、Token Plan Team 的模型目录不同，错误匹配会把套餐配置成另一套产品。
- 套餐凭据若被后台任务使用，用户既看不到调用，也可能违反套餐的交互使用边界。
- xAI API Key 与 Grok Build 订阅 OAuth（历史 smoke 使用 SuperGrok 账号）是两种不同的凭据和风险模型，不能包装成一个模糊的“Grok 登录”。

因此产品目标是让“用户选择的产品身份”贯穿配置、模型列表、Runtime 与实际请求，而不是只让连接测试返回成功。

## 为什么引入稳定 preset identity

URL 是传输配置，不是产品身份。把 `preset_key` 持久化后，用户选择套餐的行为才成为可审计事实；同地址产品不会因 preset 排序、后续新增条目或模糊 matcher 改变归属。

迁移不应替用户猜测。能从历史 fingerprint 证明的配置自动回填，不能证明的配置要求重新选择。这会增加一次确认，但比静默串线更可信。

身份采纳与目录整理也必须拆开：用户编辑名称或 Key，不代表同意应用替换其模型。只有在套餐选择器中明确说明影响后，才执行 catalog reconcile。

## 为什么套餐调用必须知道场景

“当前聊天使用某套餐”不等于“应用所有后台智能功能都能使用该套餐”。自动标题、heartbeat、定时任务、后台记忆与用户发起的对话在可见性和条款上不同。

所以策略不是在每个调用点加一条易漏的 if，而是要求所有 credential-bearing 调用声明封闭 `callScene`，再由统一 gate 裁决。未知场景 fail closed，让未来新增入口必须先回答“这是用户交互还是隐藏自动化”。

## 为什么 xAI 保留两条渠道

官方 API Key 是稳定、按 API 账户计费的路径；Grok Build OAuth 是订阅用户更自然的体验，但 CodePilot 当前复用公开 Grok Build client，受上游 allowlist、redirect 和政策调整影响。

把两条路径并列有三个好处：

1. 不把兼容 OAuth 宣传为官方合作。
2. OAuth 上游变化时，API Key 仍是独立兜底。
3. 用户能明确知道当前请求使用 API 账户还是订阅登录。

浏览器 PKCE 面向桌面用户，设备码面向 VPS/SSH/端口受限环境。它们是同一 OAuth identity 的两种登录方法，不应在浏览器登录过程中同时出现、制造“还需要设备码”的误解。

## 为什么 Grok 模型可用不等于 X Search 可用

Grok 的文本推理、CodePilot 客户端函数工具和 xAI 托管 X Search 是三层不同事实。模型返回文本只能证明 Responses 调用成功；文件/Shell 工具工作只能证明 CodePilot 的 client tools 接线成功；只有请求真实携带 `x_search`、上游返回 provider-executed lifecycle 与 X citation，才能证明本轮使用了 X Search。

因此产品不做静默能力猜测：API Key 与 OAuth 共用同一 hosted-tool 接线，但四个 Runtime/凭据组合仍分别真实验收。搜索结果按不可信外部数据处理，来源进入消息持久化；403 只说明上游拒绝访问，不能仅凭状态码把原因写死为订阅 entitlement。费用也不按调用次数在客户端猜算，只有上游真实 usage/账单事实才可显示。

## 为什么 Grok Imagine 不放进聊天模型列表

Grok Build 的账号目录与媒体能力是两类产品表面：authenticated `/v1/models` 回答“这个订阅账号可以把聊天路由到哪些文本/agent 模型”，而 `image_gen`、`image_edit`、`image_to_video`、`reference_to_video` 是聊天中触发的工具。把 Imagine slug 塞进聊天模型 picker，会让用户误以为选中后仍能进行普通多轮对话，也绕开现有媒体结果的 Gallery/lineage 合同。

因此产品入口应保持简单：聊天 picker 只显示账号目录返回的可对话模型；用户在聊天中提出生成/编辑图片或制作视频时，由 Grok Build 工具产出 `MediaBlock` 并进入 Gallery。OAuth 传输也分开守边界——文本推理与目录走 Build proxy，图片/视频只经精确媒体路径直连公共 API；不能因为两者使用同一登录态就放宽成任意 `api.x.ai` 请求。

还有一个更基础的语义门禁：Build proxy 通过 `x-grok-model-override` 决定真实文本后端。若 UI 显示 4.6、请求却不发 override，实际可能仍走默认 `grok-build`；连接成功也不能算选中模型已生效。产品必须同时核对 picker 选择、请求 header 与响应模型，才允许显示为可用。

## 用户反馈改变了什么

真实测试连续暴露了两个单元测试不容易发现的完成感问题：

- 浏览器登录期间仍展示设备码入口，让用户误以为两步都必须完成。
- CodePilot 已保存凭据，但 xAI 页面因 callback GET 缺少 CORS/PNA 成功响应而停在复制代码页。

最终界面锁定用户选择的登录方式，浏览器流明确无需设备码；loopback callback 则完整支持 xAI 页面读取完成结果。这说明 OAuth 验收不能只看 token 是否落库，还要验证浏览器和应用两端都能结束流程。

0.59.0 发布后的另一台电脑又暴露了第三层问题：系统浏览器能通过代理完成 xAI 授权，但 packaged server 的 Node `fetch` 没有自动消费同一代理，导致授权码换 token 时失败。产品上“跟随系统代理”不能只停留在检测到代理或给子进程写环境变量，必须验证浏览器、loopback 和服务端上游请求三段使用一致且可解释的网络路径。0.59.1 因此只为 xAI 外部请求挂局部代理 dispatcher，避免把本地 callback 和无关 Provider 一起交给代理。

0.59.1 在同一台故障电脑上的后续复验还出现过一次浏览器相关差异：同一账号经 Dia 授权后，xAI 推理返回 team RPM `0/0`；把默认浏览器改为 Chrome 并重新授权后，同账号在 CodePilot Runtime 正常回复。当前证据只能说明该次 OAuth grant/浏览器上下文存在差异，不能证明 Dia 普遍不兼容，也不能归因于账号额度或 CodePilot 的代理实现。按用户裁决保留观察记录，不为此改代码；未来若出现第二个独立复现，再收集两次授权的脱敏 claims/team 与 xAI response 元数据后决定是否建立浏览器兼容矩阵。

## 仍然诚实保留的限制

- OAuth client 不是 CodePilot 自有，兼容性可能被 xAI 上游收紧。
- OAuth bundle 尚未迁移到 OS keyring，沿用项目现有 settings 存储边界。
- 配额、套餐名称和剩余额度没有可靠 API 来源，因此界面不展示猜测值。
- device、refresh/tool/logout、Windows packaged 登录、其他浏览器及部分 Qwen 套餐还需要继续真实 smoke。
- Grok Build 的 `x-grok-model-override` 与 Imagine 图像/视频工具已经实现并通过自动化合同；账号模型目录仍是静态 fallback，Imagine entitlement/计费和真实媒体输出尚未完成真实凭据 smoke。

后续优先方向是申请 CodePilot 自有 public OAuth client、统一凭据加密，并把真实 smoke 变成每个发布版本可重复执行的外部验收清单。
