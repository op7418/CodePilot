/**
 * Brand-icon resolver — pure URL/name → icon-key matcher.
 *
 * Lives outside `provider-presets.tsx` so the rule is unit-testable without
 * React. The `.tsx` consumer maps `ProviderIconKey` → React component via a
 * static lookup table; this file owns the matching logic.
 *
 * Rule order matters — first match wins. When adding a new vendor with a
 * shared host fragment (e.g. `token-plan` appears in both Bailian Token
 * Plan AND Xiaomi MiMo Token Plan hosts), keep the more specific vendor
 * higher up OR scope its match to a brand-unique fragment (`maas.aliyuncs.com`
 * for Bailian, `xiaomimimo` for Xiaomi). Don't introduce a generic
 * `token-plan` match — it would steal icons across vendors.
 */

export type ProviderIconKey =
  | "openrouter"
  | "zhipu"
  | "kimi"
  | "moonshot"
  | "minimax"
  | "volcengine"
  | "bailian"
  | "xiaomi-mimo"
  | "ollama"
  | "openai"
  | "xai"
  | "deepseek"
  | "bedrock"
  | "google"
  | "aws"
  | "anthropic"
  | "cline"
  | "opencode"
  | "default";

export function getProviderIconKey(name: string, baseUrl: string): ProviderIconKey {
  const lower = name.toLowerCase();
  const url = baseUrl.toLowerCase();

  if (lower.includes("openrouter")) return "openrouter";
  // OpenCode Go: the provider name carries a protocol suffix — "OpenCode Go
  // (OpenAI)" / "(Anthropic)". Match BEFORE the openai / anthropic name
  // matchers below, which would otherwise steal the wrong brand logo
  // (OpenCode brand icon added in @lobehub/icons 4.9.0).
  if (url.includes("opencode.ai") || lower.includes("opencode")) return "opencode";
  // ClinePass — Cline brand icon. Scoped to brand-unique fragments
  // (`cline.bot` host / `clinepass` name) to avoid stealing on "client" etc.
  if (url.includes("cline.bot") || lower.includes("clinepass")) return "cline";
  if (
    url.includes("bigmodel.cn") ||
    url.includes("z.ai") ||
    lower.includes("glm") ||
    lower.includes("zhipu") ||
    lower.includes("chatglm")
  )
    return "zhipu";
  if (url.includes("kimi.com") || lower.includes("kimi")) return "kimi";
  if (url.includes("moonshot") || lower.includes("moonshot")) return "moonshot";
  if (url.includes("minimax") || lower.includes("minimax")) return "minimax";
  if (
    url.includes("volces.com") ||
    url.includes("volcengine") ||
    lower.includes("volcengine") ||
    lower.includes("火山") ||
    lower.includes("doubao") ||
    lower.includes("豆包")
  )
    return "volcengine";
  // Aliyun-only host fragments — must NOT include a bare `token-plan`
  // match: Xiaomi MiMo Token Plan host is `token-plan-cn.xiaomimimo.com`
  // and would steal the Bailian icon if we matched on `token-plan` alone.
  // `maas.aliyuncs.com` already covers Bailian Token Plan
  // (`token-plan.cn-beijing.maas.aliyuncs.com`); name-side matchers
  // (`bailian` / `百炼` / `aliyun`) cover any user-renamed entries.
  if (
    url.includes("dashscope") ||
    url.includes("maas.aliyuncs.com") ||
    lower.includes("bailian") ||
    lower.includes("百炼") ||
    lower.includes("aliyun")
  )
    return "bailian";
  if (url.includes("xiaomimimo") || lower.includes("mimo") || lower.includes("小米"))
    return "xiaomi-mimo";
  if (url.includes("11434") || lower.includes("ollama")) return "ollama";
  if (
    url.includes("api.x.ai") ||
    lower.includes("xai") ||
    lower.includes("x.ai") ||
    lower.includes("grok")
  )
    return "xai";
  if (
    url.includes("api.openai.com") ||
    lower.includes("openai") ||
    lower.includes("gpt image")
  )
    return "openai";
  if (url.includes("deepseek") || lower.includes("deepseek")) return "deepseek";
  if (lower.includes("bedrock")) return "bedrock";
  if (lower.includes("vertex") || lower.includes("google")) return "google";
  if (lower.includes("aws")) return "aws";
  if (lower.includes("anthropic") || url.includes("anthropic")) return "anthropic";

  return "default";
}
