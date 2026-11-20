# 为什么先把遥测变可信，而不是先做用户分析

用户最初看到的是“Sentry 报错很多”，但总量混合了开发环境、旧 release、衍生产品、用户配置错误和真实产品缺陷。此时增加更多采集只会让数字更大，不会让判断更准。

这轮选择先做 U0：只回答“当前官方 stable 版本是否健康”。同一次应用运行只保留 Electron main 的一个 session，因此 crash-free sessions 与版本采用趋势有了相对稳定的分母；但它不代表真实用户，更不代表活跃用户。CodePilot 是托盘常驻应用，启动、驻留和有意义使用天然不是一回事，所以产品文案必须明确“不追踪功能使用、不识别用户”。

另一个取舍是保留用户可见的真实错误，同时不把原始 provider body 送进 Sentry。用户排查模型/网关问题需要上游原因，遥测只需要 status class、protocol、provider class、runtime 和 call scene。两条数据路径因此被明确拆开，而不是为了隐私把 UI 也降级成“未知错误”。

这也意味着“用户可解决”不能靠换成 info level 继续留在 Issues：HTTP 4xx（包括 429）、缺凭据和模型不支持在 U0 中必须是 0 event。它们仍在产品内给出操作建议，但 Sentry Top issues 应只保留团队能采取行动的故障。5xx、DNS 和 timeout 则只有调用方明确耗尽 retry/fallback 后才有观察价值，提前上报只会把一次最终成功的重试算成失败。

NoOutput 也不能被当作根因名称。SDK wrapper 只说明最终没有输出，底层可能是 403、503、DNS 或 timeout；因此分类器只在有界 allow-list cause graph 中读取 status/code/type，不读取 response body/chunk。只有确实没有 upstream 根因时，才把它归为 provider protocol fault。这一保守顺序让 Sentry bucket 指向可行动责任，同时不扩大身份、行为或内容采集。

同样，stream callback 的 `onError` 既不能直接上报，也不能假设后续一定进入 catch。真实 AI SDK 生命周期中，in-band error part 之后 `response` 与 `finishReason` 仍可能正常 resolve，甚至已经输出部分内容；初始 HTTP 失败也可能让 fullStream 正常结束，却随后以另一个无 cause 的 NoOutput 拒绝 result promise。可靠边界因此是 per-step terminal state：`onError` 只保存并标记结构化根因，先让 result promise 决定走 catch 还是 resolved fallback，再 exactly-once 分类；这样既不会把未耗尽 retry 的中间态提前变成 Issue，也不会让 4xx 伪装成 `EMPTY_RESPONSE`、让 partial-content 5xx 消失或把同一 5xx 报两次。

Source Map 也遵循同样原则：能产生 map 不等于可交付。必须证明上传的是最终 packaged bundle、debug ID 对得上、安装包不携带源码，并记录真实构建代价。用户已接受 stable build 绝对增加约 13.4s；official CI 已证明三层 symbolication、native minidump 恢复上传，以及 macOS/Windows/Linux 最终包 0 map，因此这部分发布门禁已闭合。后续仍要在每次相关发布中防回退，不能把历史 smoke 当作永久保证。

未来若要看用户量或活跃度，应单独做 U1/U2：独立 consent、诚实的启动/行为口径、可验证的数据集和成本。不能把错误上报开关扩张成行为分析授权，也不能用 Sentry session 数冒充 DAU/MAU。
