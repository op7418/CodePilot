# Jev / OpenRouter 适配调研

> 2026-09-18；范围：公开文档、公开模型元数据、当前工作区源码和已安装 SDK。未调用付费推理、未使用真实凭据、未修改产品代码。

> 用户决策（2026-09-18）：暂不接入 Jev，本轮发版不包含该能力；保留调研和能力识别技术债供后续参考。

## 用户问题与结论

用户希望判断 OpenRouter 新上架的 `~typesafe/jev-latest` 是否需要单独适配。此前 Gemini Native 的接入方式不能直接套用：Jev 是结构化决策模型，输出 choices / scores / probabilities，不生成自由文本。

**若要使用 Jev，需要独立的 decision/evaluation 调用能力；不应作为 Native、Codex、Claude Code 的普通主聊天模型暴露。** 现阶段建议先补模型能力识别，再以明确场景做可选 POC，例如候选记忆相关性评分、Skill 候选分类。尚不建议为了上架一个模型改造三套主聊天协议或整体升级 AI SDK。

## 外部事实

| 项目 | 已核实事实与来源 |
| --- | --- |
| 类型 | TypeSafe 称为 System One：共享 state 上的原子问题判断，不生成文章、代码或推理解释。[官方说明](https://docs.typesafe.ai/concepts/system-one) |
| 输出 | Choice 从预定义选项选择并返回概率分布；Score 按预定义等级计算加权分数；Noul 返回“是”的概率。Choice/Score 另带 confidence，Noul 没有单独 confidence。[API](https://docs.typesafe.ai/api)、[置信度说明](https://docs.typesafe.ai/confidence) |
| 输入 | 仅文本；state 可用字符串或结构化对象/数组。同一 state 可并行评估多个问题。[模型文档](https://docs.typesafe.ai/models) |
| OpenRouter 身份 | 用户链接 `~typesafe/jev-latest` 是会移动的家族别名；当前版本页是 `typesafe/jev-1.13`。不得误用 TypeSafe 直连的 `jev-1.13.0` 作为 OpenRouter ID。[别名页](https://openrouter.ai/~typesafe/jev-latest)、[版本页](https://openrouter.ai/typesafe/jev-1.13) |
| OpenRouter 价格/上下文 | 版本页和公开 endpoints 元数据为输入 $0.042 / 百万 token，输出 $0；context_length 为 32,000。[版本页](https://openrouter.ai/typesafe/jev-1.13) |
| 直连上下文 | TypeSafe 文档另列总请求 64k、state 加最长问题 32k 两项预算；不能据此把 OpenRouter 的上下文改为 64k。[模型文档](https://docs.typesafe.ai/models) |
| 语言 | 官方明确英语表现最好，CJK 可处理但准确率不等同英语；中文场景需要自己的样本评估。[模型文档](https://docs.typesafe.ai/models) |

这里的概率/置信度不等于每次判断正确，也不应把宣传中的低延迟或效果当成本项目实测。版本变化可能改变经过校准的阈值，生产评估应记录实际模型版本。

### OpenRouter 公开元数据实测

2026-09-18 无凭据 GET [版本 endpoints](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints) 成功，关键字段：

```json
{
  "id": "typesafe/jev-1.13",
  "architecture": {
    "modality": "text->decisions",
    "input_modalities": ["text"],
    "output_modalities": ["decisions"]
  }
}
```

版本页面内嵌数据同时给出 `has_text_output: false`、`quick_start_example_type: decisions`。这直接支持“不能当普通文本模型”的结论。endpoints 中通用 `supports_tool_choice` 标志不能证明 Jev 能生成任意工具参数或完成主 Agent 循环。

本次无凭据 GET [普通模型目录](https://openrouter.ai/api/v1/models) 返回 445 项、`total_count: 445`、`links.next: null`，其中没有 Jev/TypeSafe。只能说明这次公开目录响应未包含它，不能推断所有账号目录都相同，也不能声称当前搜索 UI 已实际展示 Jev。

临时取证文件：`/tmp/jev-endpoints.json`、`/tmp/jev-openrouter-models.json`、`/tmp/jev-api-page.html`。这些不是持久化测试 fixture；复查时应重新 GET 上述公开地址。

### 调用协议与 AI SDK 边界

TypeSafe 直连的已公开协议是 `POST https://api.typesafe.ai/v1/systemone`，请求 `model / state / questions`，响应 `model / answers / usage`。[官方 API](https://docs.typesafe.ai/api)

本次未取得足以确认 **OpenRouter 决策推理端点及完整请求/响应契约** 的专用文档，也未做真实推理。OpenRouter 作者页通用 FAQ 的“OpenAI-compatible”不能单独证明 Jev 支持现有 `/chat/completions`，不能把 TypeSafe 的 `/v1/systemone` 直接拼到 OpenRouter 地址。实现前需补齐这个渠道的专用协议与真实 smoke；若选择直连 TypeSafe，需要独立凭据，不能使用 OpenRouter key。

Vercel 官方 Jev 页使用 `experimental_evaluate`、`state`、`questions`，模型 ID 为 `typesafe-ai/jev`，boolean 问题类型也与 TypeSafe 的 `noul` 不同。[官方示例](https://vercel.com/ai-gateway/models/jev)

当前工作区已安装 `ai@7.0.11`，运行 `typeof require('ai').experimental_evaluate` 得到 `undefined`；当前类型声明也未提供该能力。因此不能直接复制官网示例。Vercel Gateway、TypeSafe 直连和 OpenRouter 是不同渠道，接入其中之一不等于其他渠道已可用。

## 本仓库现状

| 位置 | 已核实实现 | 影响 |
| --- | --- | --- |
| `src/lib/openrouter-catalog.ts` | 读取 `/api/v1/models`，候选只保留 ID、名称、上下文、价格；未消费输出 modality | 若上游目录包含 decision-only 模型，现有映射不能区分；这是能力识别缺口，并非已观察到 Jev 用户故障 |
| `src/app/api/providers/[id]/search-models/route.ts` | 消费上述候选目录 | 后续需将能力信息传到搜索/添加合同，不能只加 Jev 名称黑名单 |
| `src/lib/runtime-compat.ts` | OpenRouter `/api` 按 Anthropic skin，`/api/v1` 按 OpenAI skin 分类 | 仅 provider transport 兼容不足以证明模型支持主聊天；不能把所有 OpenRouter 连接都称为 Native 路径 |
| `src/lib/ai-provider.ts` | OpenAI-compatible 分支返回 `openai.chat(modelId)` | 属于 Chat Completions，不是 evaluation adapter |
| `src/lib/agent-loop.ts` | Native 使用 `streamText` 和消息/工具历史推进 | 没有 state/questions/answers 决策调用合同 |

## 建议取舍与后续执行范围

1. **先补能力识别。** 保留有来源的 output modalities；明确只有 decisions 输出的模型不进入主聊天候选。手动添加、已有会话和服务端调用也需一致检查，不能仅靠隐藏选项。缺失 metadata 与明确“不支持文本”必须区别处理，避免误伤存量兼容服务。已登记 tech-debt #95。
2. **以辅助决策能力接入。** 明确 typed questions 和 typed answers 的独立合同，保留概率分布、实际模型身份和真实 usage；不把结果包装成聊天 token 流，不把 output 免费解释为 output token 一定为零。
3. **先选择一个场景。** 推荐评估“候选记忆与当前问题的相关性评分”，或“从已知 Skill 候选中分类选择”。这是产品方向建议，尚无本项目延迟/中文准确率/成本收益实测。生成标题、写摘要、写文章、补代码仍需文本模型。
4. **真实渠道验证后再扩展。** 若走 OpenRouter，先核实其 decisions wire；若通过 SDK，先确认实际可用版本及 adapter，单独评估依赖升级影响。不能静默切换到另一计费渠道。
5. **验收重点。** 非聊天模型的目录/手动添加/服务端拦截；Choice/Score/Noul 的 schema 和概率含义；取消/超时/429；实际 usage；中文与模糊问题；失败或低置信度时保留现有路径。不要以决策输出代替用户授权或悄悄改变用户选定的主模型。

## 验证边界

已完成公开文档、公开 HTTP 元数据与源码/本地 SDK 导出核验。本次仅文档变更，不运行与此无关的全量产品测试；未验证真实推理、中文效果、延迟、费用或三 Runtime 工具接线。结论是“需要独立能力适配”，不是“已接入”或“已可在 OpenRouter 成功调用”。
