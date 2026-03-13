/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types';
import {
  getChannelBinding,
  upsertChannelBinding,
  updateChannelBinding,
  listChannelBindings,
  getSession,
  createSession,
  getSetting,
  updateSessionProviderId,
} from '../db';

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const existing = getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const defaultCwd = workingDirectory
    || getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultModel = getSetting('bridge_default_model') || '';
  const defaultProviderId = getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    updateSessionProviderId(session.id, defaultProviderId);
  }

  return upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const session = getSession(codepilotSessionId);
  if (!session) return null;

  return upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    sdkSessionId: '',
    workingDirectory: session.working_directory,
    model: session.model,
    mode: 'code',
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  updateChannelBinding(id, updates);
}

/**
 * Create an ephemeral worker binding for parallel message processing.
 *
 * Creates a new session that inherits config from the parent binding
 * but does NOT touch channel_bindings — the parent's binding stays intact.
 * The worker session is independent and will be garbage collected when idle.
 */
export function createWorkerBinding(parentBinding: ChannelBinding): ChannelBinding {
  const session = createSession(
    `Worker: ${parentBinding.chatId.slice(0, 16)}`,
    parentBinding.model,
    undefined,
    parentBinding.workingDirectory,
    parentBinding.mode,
  );

  // Inherit provider from parent session
  const parentSession = getSession(parentBinding.codepilotSessionId);
  if (parentSession?.provider_id) {
    updateSessionProviderId(session.id, parentSession.provider_id);
  }

  // Return a synthetic binding — NOT persisted to channel_bindings table
  return {
    id: '',  // empty = ephemeral, not persisted
    channelType: parentBinding.channelType,
    chatId: parentBinding.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: parentBinding.workingDirectory,
    model: parentBinding.model,
    mode: parentBinding.mode,
    active: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return listChannelBindings(channelType);
}
