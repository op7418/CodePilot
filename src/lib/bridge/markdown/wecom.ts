/**
 * Enterprise WeCom-specific Markdown and card helpers.
 */

import {
  TemplateCardType,
  type SendMarkdownMsgBody,
  type SendTemplateCardMsgBody,
} from '@wecom/aibot-node-sdk';
import type { InlineButton } from '../types';

/** Detect complex markdown that may benefit from card-style delivery later. */
export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/** Ensure code fences start on a new line without stripping language tags. */
export function preprocessWecomMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

/** Convert simple HTML responses into WeCom markdown. */
export function htmlToWecomMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildMarkdownMessage(text: string): SendMarkdownMsgBody {
  return {
    msgtype: 'markdown',
    markdown: { content: text },
  };
}

export function buildPermissionCommands(inlineButtons: InlineButton[][]): string[] {
  return inlineButtons.flat().map((btn) => {
    if (!btn.callbackData.startsWith('perm:')) return btn.text;

    const parts = btn.callbackData.split(':');
    const action = parts[1];
    const permId = parts.slice(2).join(':');
    return `/perm ${action} ${permId}`;
  });
}

export function buildPermissionCommandText(
  text: string,
  inlineButtons: InlineButton[][],
): string {
  const sections = [text.trim(), 'Reply with one of these commands:', ...buildPermissionCommands(inlineButtons)]
    .filter(Boolean);
  return sections.join('\n\n');
}

export function buildPermissionCard(
  inlineButtons: InlineButton[][],
  taskId = `perm_${Date.now()}`,
  title = '需要操作权限',
  desc = '请选择一个审批动作'
): SendTemplateCardMsgBody {
  return {
    msgtype: 'template_card',
    template_card: {
      card_type: TemplateCardType.ButtonInteraction,
      main_title: {
        title,
        desc,
      },
      sub_title_text: '请通过点击下方按钮批准或拒绝来自 WeCom Bridge 的请求。',
      button_list: inlineButtons
        .flat()
        .slice(0, 6)
        .map((btn) => ({
          text: btn.text.slice(0, 24),
          key: btn.callbackData,
        })),
      task_id: taskId,
    },
  };
}