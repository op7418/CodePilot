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
  updateSessionWorkingDirectory,
  updateSdkSessionId,
} from '../db';
import { resolveWorkingDirectory } from '../working-directory';

function shouldResetResumeForSource(source: string): boolean {
  return source === 'setting' || source === 'home' || source === 'process';
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 * Self-heals stale workingDirectory / sdkSessionId in existing bindings.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const existing = getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    const session = getSession(existing.codepilotSessionId);
    if (session) {
      const resolved = resolveWorkingDirectory([
        { path: session.sdk_cwd, source: 'session_sdk_cwd' },
        { path: existing.workingDirectory, source: 'binding' },
        { path: session.working_directory, source: 'session_working_directory' },
        { path: getSetting('bridge_default_work_dir'), source: 'setting' },
      ]);
      const shouldResetResume = shouldResetResumeForSource(resolved.source);
      const updates: Partial<Pick<ChannelBinding, 'workingDirectory' | 'sdkSessionId'>> = {};

      if (resolved.invalidCandidates.length > 0) {
        console.warn('[channel-router] Healed invalid bridge working directory', {
          channelType: existing.channelType,
          chatId: existing.chatId,
          sessionId: existing.codepilotSessionId,
          selected: resolved.path,
          source: resolved.source,
          invalidCandidates: resolved.invalidCandidates,
        });
      }

      if (existing.workingDirectory !== resolved.path) {
        updates.workingDirectory = resolved.path;
        existing.workingDirectory = resolved.path;
      }

      if (shouldResetResume && existing.sdkSessionId) {
        updates.sdkSessionId = '';
        existing.sdkSessionId = '';
      }

      if (Object.keys(updates).length > 0) {
        updateChannelBinding(existing.id, updates);
      }

      if (session.working_directory !== resolved.path || session.sdk_cwd !== resolved.path) {
        updateSessionWorkingDirectory(session.id, resolved.path);
      }

      if (shouldResetResume && session.sdk_session_id) {
        updateSdkSessionId(session.id, '');
      }

      return existing;
    }
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
  const resolved = resolveWorkingDirectory([
    { path: workingDirectory, source: 'requested' },
    { path: getSetting('bridge_default_work_dir'), source: 'setting' },
  ]);
  const defaultCwd = resolved.path;
  const defaultModel = getSetting('bridge_default_model') || '';
  const defaultProviderId = getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
    undefined, // provider id — set below once known
    undefined, // permission profile
    undefined, // source
    // The channel identity IS the name here; a fallback derived from the
    // first inbound message would be strictly worse information.
    'system',
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
    providerId: defaultProviderId || undefined,
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

  const resolved = resolveWorkingDirectory([
    { path: session.sdk_cwd, source: 'session_sdk_cwd' },
    { path: session.working_directory, source: 'session_working_directory' },
    { path: getSetting('bridge_default_work_dir'), source: 'setting' },
  ]);

  if (session.working_directory !== resolved.path || session.sdk_cwd !== resolved.path) {
    updateSessionWorkingDirectory(session.id, resolved.path);
  }

  return upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    sdkSessionId: '',
    workingDirectory: resolved.path,
    model: session.model,
    mode: 'code',
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'providerId' | 'active'>>,
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
