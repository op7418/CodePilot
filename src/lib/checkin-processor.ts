/**
 * Core check-in processing logic, extracted from the API route
 * so it can be called directly from server-side completion detection
 * without an HTTP round-trip.
 */
import fs from 'fs';
import path from 'path';
import { getSetting, getSession } from '@/lib/db';
import { resolveProvider } from '@/lib/provider-resolver';
import { loadState, saveState, writeDailyMemory } from '@/lib/assistant-workspace';
import { getLocalDateString } from '@/lib/utils';
import { generateTextFromProvider } from '@/lib/text-generator';

const CHECK_IN_LABELS = [
  'What did you work on or accomplish today?',
  'Any changes to your current priorities or goals?',
  'Anything you\'d like me to remember going forward?',
];

/**
 * Process check-in completion. Generates daily memory, promotes stable facts,
 * updates user profile.
 *
 * Idempotent for today: if state.lastCheckInDate is already today, returns early.
 *
 * @throws Error if workspace path is not configured or processing fails
 */
export async function processCheckin(
  answers: Record<string, string>,
  sessionId?: string,
): Promise<void> {
  const workspacePath = getSetting('assistant_workspace_path');
  if (!workspacePath) {
    throw new Error('No workspace path configured');
  }

  const today = getLocalDateString();

  // Idempotent check: skip if already checked in today
  const currentState = loadState(workspacePath);
  if (currentState.lastCheckInDate === today) {
    return;
  }

  // Look up the calling session for provider/model context
  let session: ReturnType<typeof getSession> | undefined;
  if (sessionId) {
    session = getSession(sessionId) ?? undefined;
    if (session && session.working_directory !== workspacePath) {
      throw new Error('Session does not belong to current workspace');
    }
  }

  const qaText = CHECK_IN_LABELS.map((q, i) => {
    const key = `q${i + 1}`;
    return `Q: ${q}\nA: ${answers[key] || '(skipped)'}`;
  }).join('\n\n');

  // Read existing files for context
  const memoryPath = path.join(workspacePath, 'memory.md');
  const userPath = path.join(workspacePath, 'user.md');
  let existingMemory = '';
  let existingUser = '';
  try { existingMemory = fs.readFileSync(memoryPath, 'utf-8'); } catch { /* new file */ }
  try { existingUser = fs.readFileSync(userPath, 'utf-8'); } catch { /* new file */ }

  try {
    const resolved = resolveProvider({
      callScene: 'user_checkin',
      sessionProviderId: session?.provider_id || undefined,
      sessionModel: session?.model || undefined,
    });
    const providerId = resolved.provider?.id || 'env';
    const model = resolved.upstreamModel || resolved.model || getSetting('default_model') || 'claude-sonnet-4-6';

    const dailyMemoryPrompt = `You maintain daily memory entries for an AI assistant. Given the user's daily check-in answers, generate a daily memory entry for ${today}.

Format it with these sections:
## Work Log
(What the user accomplished today)

## Priority Changes
(Any shifts in goals or priorities)

## To Remember
(Things the user wants remembered)

## Candidate Long-Term Memory
(Facts that seem stable enough to promote to long-term memory — only include genuinely persistent facts, not transient updates)

Keep under 2000 characters.

Today's check-in (${today}):
${qaText}`;

    const promotionPrompt = `You maintain a long-term memory file for an AI assistant. Given the user's check-in and the existing memory, output ONLY new stable facts that should be APPENDED to memory.md. These must be genuinely persistent facts (user preferences, recurring patterns, important relationships), NOT daily transients.

If there's nothing worth promoting, output exactly: (nothing to promote)

Existing memory.md:
${existingMemory || '(empty)'}

Today's check-in (${today}):
${qaText}`;

    const userPrompt = `You maintain a user.md profile for an AI assistant. Given the user's daily check-in answers and the existing profile, generate an UPDATED user.md. Only update sections affected by today's answers. Keep it organized with markdown headers. Keep under 2000 characters.

Existing user.md:
${existingUser || '(empty)'}

Today's check-in (${today}):
${qaText}`;

    const [dailyContent, promotionContent, newUser] = await Promise.all([
      generateTextFromProvider({ callScene: 'user_checkin', providerId, model, system: 'You maintain knowledge files for AI assistants. Output only the file content, no explanations.', prompt: dailyMemoryPrompt }),
      generateTextFromProvider({ callScene: 'user_checkin', providerId, model, system: 'You maintain knowledge files for AI assistants. Output only the content to append, no explanations.', prompt: promotionPrompt }),
      generateTextFromProvider({ callScene: 'user_checkin', providerId, model, system: 'You maintain user profile documents. Output only the file content, no explanations.', prompt: userPrompt }),
    ]);

    // Write daily memory file (episodic, per-day)
    if (dailyContent.trim()) {
      writeDailyMemory(workspacePath, today, dailyContent);
    }

    // Promote stable facts to memory.md (additive append, NOT rewrite)
    // Dedup: skip if today's promotion already exists in memory.md
    if (promotionContent.trim() && !promotionContent.includes('(nothing to promote)')) {
      const currentMemory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';
      if (!currentMemory.includes(`## Promoted from ${today}`)) {
        const appendText = `\n\n## Promoted from ${today}\n${promotionContent.trim()}\n`;
        fs.appendFileSync(memoryPath, appendText, 'utf-8');
      }
    }

    // Incremental user.md update
    if (existingUser && newUser.trim()) {
      fs.writeFileSync(userPath, newUser, 'utf-8');
    }

    // Archive old daily memories and promote candidates
    try {
      const { archiveDailyMemories, promoteDailyToLongTerm } = await import('@/lib/workspace-organizer');
      archiveDailyMemories(workspacePath);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const dailyDir = path.join(workspacePath, 'memory', 'daily');
      if (fs.existsSync(dailyDir)) {
        const oldFiles = fs.readdirSync(dailyDir)
          .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .filter(f => f.replace('.md', '') <= getLocalDateString(sevenDaysAgo));
        for (const f of oldFiles) {
          promoteDailyToLongTerm(workspacePath, f.replace('.md', ''));
        }
      }
    } catch {
      // organizer module not available, skip archival
    }
  } catch (e) {
    console.warn('[checkin-processor] AI generation failed, writing raw daily entry:', e);
    const rawDailyContent = `# Daily Check-in ${today}\n\n${qaText}\n`;
    writeDailyMemory(workspacePath, today, rawDailyContent);
  }

  // Update state
  const state = loadState(workspacePath);
  state.lastCheckInDate = today;
  saveState(workspacePath, state);
}
