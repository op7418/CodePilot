import { useCallback } from 'react';
import type { Message } from '@/types';

interface UseChatCommandsOpts {
  sessionId: string;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  sendMessage: (content: string) => void;
}

export function useChatCommands({ sessionId, messages, setMessages, sendMessage }: UseChatCommandsOpts): (command: string) => void {
  return useCallback((command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content: `## Available Commands\n\n### Instant Commands\n- **/help** — Show this help message\n- **/clear** — Clear conversation history\n- **/cost** — Show token usage statistics\n\n### Prompt Commands (shown as badge, add context then send)\n- **/compact** — Compress conversation context\n- **/doctor** — Diagnose project health\n- **/init** — Initialize CLAUDE.md for project\n- **/review** — Review code quality\n- **/terminal-setup** — Configure terminal settings\n- **/memory** — Edit project memory file\n\n### Custom Skills\nSkills from \`~/.claude/commands/\` and project \`.claude/commands/\` are also available via \`/\`.\n\n**Tips:**\n- Type \`/\` to browse commands and skills\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, helpMessage]);
        break;
      }
      case '/clear':
        setMessages([]);
        // Also clear database messages and reset SDK session
        if (sessionId) {
          fetch(`/api/chat/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear_messages: true }),
          }).catch(() => { /* silent */ });
        }
        break;
      case '/cost': {
        // Aggregate token usage from all messages in this session
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheCreation = 0;
        let totalCost = 0;
        let turnCount = 0;

        for (const msg of messages) {
          if (msg.token_usage) {
            try {
              const usage = typeof msg.token_usage === 'string' ? JSON.parse(msg.token_usage) : msg.token_usage;
              totalInput += usage.input_tokens || 0;
              totalOutput += usage.output_tokens || 0;
              totalCacheRead += usage.cache_read_input_tokens || 0;
              totalCacheCreation += usage.cache_creation_input_tokens || 0;
              if (usage.cost_usd) totalCost += usage.cost_usd;
              turnCount++;
            } catch { /* skip */ }
          }
        }

        const totalTokens = totalInput + totalOutput;
        let content: string;

        if (turnCount === 0) {
          content = `## Token Usage\n\nNo token usage data yet. Send a message first.`;
        } else {
          content = `## Token Usage\n\n| Metric | Count |\n|--------|-------|\n| Input tokens | ${totalInput.toLocaleString()} |\n| Output tokens | ${totalOutput.toLocaleString()} |\n| Cache read | ${totalCacheRead.toLocaleString()} |\n| Cache creation | ${totalCacheCreation.toLocaleString()} |\n| **Total tokens** | **${totalTokens.toLocaleString()}** |\n| Turns | ${turnCount} |${totalCost > 0 ? `\n| **Estimated cost** | **$${totalCost.toFixed(4)}** |` : ''}`;
        }

        const costMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, costMessage]);
        break;
      }
      default:
        // This shouldn't be reached since non-immediate commands are handled via badge
        sendMessage(command);
    }
  }, [sessionId, sendMessage, messages, setMessages]);
}
