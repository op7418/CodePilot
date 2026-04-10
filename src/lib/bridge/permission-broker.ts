/**
 * Permission Broker — forwards Claude permission requests to IM channels
 * and handles user responses via inline buttons.
 *
 * When Claude needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the existing registry
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelAddress, OutboundMessage } from './types';
import type { BaseChannelAdapter } from './channel-adapter';
import { deliver } from './delivery-layer';
import { insertPermissionLink, getPermissionLink, markPermissionLinkResolved, getSession, getDb, getSetting } from '../db';
import { resolvePendingPermission } from '../permission-registry';
import { escapeHtml } from './adapters/telegram-utils';

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  // Check if auto-approval is enabled globally — auto-approve without IM notification
  const globalAutoApprove = getSetting('dangerously_skip_permissions') === 'true';
  if (globalAutoApprove) {
    console.log(`[bridge] Auto-approved permission ${permissionRequestId} (tool=${toolName}) due to global auto-approval setting`);
    resolvePendingPermission(permissionRequestId, { behavior: 'allow' });
    return;
  }

  // Check if this session uses full_access permission profile — auto-approve without IM notification
  if (sessionId) {
    const session = getSession(sessionId);
    if (session?.permission_profile === 'full_access') {
      console.log(`[bridge] Auto-approved permission ${permissionRequestId} (tool=${toolName}) due to full_access profile`);
      resolvePendingPermission(permissionRequestId, { behavior: 'allow' });
      return;
    }
  }

  // Dedup: prevent duplicate forwarding of the same permission request
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  // Clean up old entries
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`);

  // Format the input summary (truncated)
  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300
    ? inputStr.slice(0, 300) + '...'
    : inputStr;

  // Channels without inline button support (e.g. QQ) need text-based
  // permission commands. Check if the adapter ignores inlineButtons.
  const supportsButtons = !['qq', 'weixin'].includes(adapter.channelType);

  const textLines = [
    `<b>Permission Required</b>`,
    ``,
    `Tool: <code>${escapeHtml(toolName)}</code>`,
    `<pre>${escapeHtml(truncatedInput)}</pre>`,
    ``,
  ];

  if (supportsButtons) {
    textLines.push(`Choose an action:`);
  } else {
    // Text-based permission commands for channels without inline buttons
    textLines.push(
      `Reply with one of:`,
      `/perm allow ${permissionRequestId}`,
      `/perm allow_session ${permissionRequestId}`,
      `/perm deny ${permissionRequestId}`,
    );
  }

  const text = textLines.join('\n');

  const message: OutboundMessage = {
    address,
    text,
    parseMode: supportsButtons ? 'HTML' : 'plain',
    inlineButtons: supportsButtons
      ? [
          [
            { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
            { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
            { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
          ],
        ]
      : undefined,
    replyToMessageId,
  };

  const result = await deliver(adapter, message, { sessionId });

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): boolean {
  // Parse callback data: perm:action:permId
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':'); // permId might contain colons

  // Look up the permission link to validate origin and check dedup
  const link = getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return false;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  // Security: verify the callback came from the original permission message
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return false;
  }

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
      });
      break;

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }

      resolved = resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
      break;
    }

    case 'deny':
      resolved = resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });
      break;

    default:
      return false;
  }

  return resolved;
}

/**
 * Auto-approve all pending permission requests for a session.
 * Called when a session switches from 'default' to 'full_access' profile.
 * Resolves in-memory pending permissions and marks DB links as resolved.
 */
export function autoApprovePendingForSession(sessionId: string): number {
  // The permission_requests DB table tracks pending permissions by session_id.
  // Find all pending ones and resolve them via the in-memory registry.
  const db = getDb();

  const pendingRows = db.prepare(
    "SELECT id FROM permission_requests WHERE session_id = ? AND status = 'pending'"
  ).all(sessionId) as { id: string }[];

  let resolved = 0;
  for (const row of pendingRows) {
    const ok = resolvePendingPermission(row.id, { behavior: 'allow' });
    if (ok) {
      resolved++;
      console.log(`[bridge] Auto-approved pending permission ${row.id} for session ${sessionId} (profile switched to full_access)`);
    }
    // Also mark the IM link as resolved so the button becomes inoperative
    try { markPermissionLinkResolved(row.id); } catch { /* best effort */ }
  }

  if (resolved > 0) {
    console.log(`[bridge] Auto-approved ${resolved} pending permission(s) for session ${sessionId}`);
  }
  return resolved;
}
