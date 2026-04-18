export interface ThinkingIndicatorParams {
  isStreaming: boolean;
  content: string;
  toolUsesCount: number;
  thinkingContent?: string;
  statusText?: string;
}

export function shouldShowThinkingPhaseIndicator(params: ThinkingIndicatorParams): boolean {
  return (
    params.isStreaming
    && params.content.length === 0
    && params.toolUsesCount === 0
    && !params.thinkingContent
    && !params.statusText?.trim()
  );
}
