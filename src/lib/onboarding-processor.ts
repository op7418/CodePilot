/**
 * Core onboarding processing logic, extracted from the API route
 * so it can be called directly from server-side completion detection
 * without an HTTP round-trip.
 */
import fs from 'fs';
import path from 'path';
import { getSetting, getSession } from '@/lib/db';
import { resolveProvider, DEFAULT_MODEL_ID } from '@/lib/provider-resolver';
import { loadState, saveState, ensureDailyDir, generateRootDocs } from '@/lib/assistant-workspace';
import { getLocalDateString } from '@/lib/utils';
import { generateTextFromProvider } from '@/lib/text-generator';

const QUESTION_LABELS = [
  'How should I address you?',
  'What name should I use for myself?',
  'Do you prefer "concise and direct" or "detailed explanations"?',
  'Do you prefer "minimal interruptions" or "proactive suggestions"?',
  'What are your three hard boundaries?',
  'What are your three most important current goals?',
  'Do you prefer output as "lists", "reports", or "conversation summaries"?',
  'What information may be written to long-term memory?',
  'What information must never be written to long-term memory?',
  'What three things should I do first when entering a project?',
  'How do you organize your materials? (by project / time / topic / mixed)',
  'Where should new information go by default?',
  'How should completed tasks be archived?',
];

/**
 * Process onboarding completion. Generates workspace files from answers.
 * Idempotent: if state.onboardingComplete is already true, returns early.
 *
 * @throws Error if workspace path is not configured or processing fails
 */
export async function processOnboarding(
  answers: Record<string, string>,
  sessionId?: string,
): Promise<void> {
  const workspacePath = getSetting('assistant_workspace_path');
  if (!workspacePath) {
    throw new Error('No workspace path configured');
  }

  // Idempotent check
  const currentState = loadState(workspacePath);
  if (currentState.onboardingComplete) {
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

  // Build Q&A text for the prompt
  const qaText = QUESTION_LABELS.map((q, i) => {
    const key = `q${i + 1}`;
    return `Q: ${q}\nA: ${answers[key] || '(skipped)'}`;
  }).join('\n\n');

  let soulContent: string;
  let userContent: string;
  let claudeContent: string;
  let memoryContent: string;

  try {
    const resolved = resolveProvider({
      sessionProviderId: session?.provider_id || undefined,
      sessionModel: session?.model || undefined,
    });
    const providerId = resolved.provider?.id || 'env';
    const model = resolved.upstreamModel || resolved.model || getSetting('default_model') || DEFAULT_MODEL_ID;

    const soulPrompt = `Based on the following user onboarding answers, generate a concise "soul.md" file that defines an AI assistant's personality, communication style, and behavioral rules. Write in second person ("You are..."). Keep it under 2000 characters. Use markdown headers and bullet points.\n\n${qaText}`;

    const userPrompt = `Based on the following user onboarding answers, generate a concise "user.md" profile that captures the user's preferences, goals, and boundaries. Write in third person. Keep it under 2000 characters. Use markdown headers and bullet points.\n\n${qaText}`;

    const claudePrompt = `Based on the following user onboarding answers, generate a "claude.md" rules file for an AI assistant. Include:
- Execution rules (what to do when entering a project, based on Q10)
- Communication style rules (based on Q3, Q4, Q7)
- Memory rules (what to remember/forget, based on Q8, Q9)
- Hard boundaries (based on Q5)
Keep it under 2000 characters. Use markdown headers and bullet points.\n\n${qaText}`;

    const memoryPrompt = `Based on the following user onboarding answers, generate an initial "memory.md" file with long-term facts about the user worth remembering. Include user goals, preferences, and any stable facts. Keep it under 1000 characters. Use markdown headers.\n\n${qaText}`;

    [soulContent, userContent, claudeContent, memoryContent] = await Promise.all([
      generateTextFromProvider({ providerId, model, system: 'You generate configuration files for AI assistants. Output only the file content, no explanations.', prompt: soulPrompt }),
      generateTextFromProvider({ providerId, model, system: 'You generate user profile documents. Output only the file content, no explanations.', prompt: userPrompt }),
      generateTextFromProvider({ providerId, model, system: 'You generate configuration files for AI assistants. Output only the file content, no explanations.', prompt: claudePrompt }),
      generateTextFromProvider({ providerId, model, system: 'You generate knowledge files for AI assistants. Output only the file content, no explanations.', prompt: memoryPrompt }),
    ]);

    if (!soulContent.trim() || !userContent.trim()) {
      throw new Error('AI returned empty content');
    }
  } catch (e) {
    console.warn('[onboarding-processor] AI generation failed, using raw answers:', e);
    soulContent = `# Soul\n\n## Communication Style\n- Address user as: ${answers.q1 || 'not specified'}\n- Assistant name: ${answers.q2 || 'not specified'}\n- Style: ${answers.q3 || 'not specified'}\n- Approach: ${answers.q4 || 'not specified'}\n`;
    userContent = `# User Profile\n\n## Preferences\n- Boundaries: ${answers.q5 || 'not specified'}\n- Goals: ${answers.q6 || 'not specified'}\n- Output format: ${answers.q7 || 'not specified'}\n- Memory allowed: ${answers.q8 || 'not specified'}\n- Memory forbidden: ${answers.q9 || 'not specified'}\n- Project entry: ${answers.q10 || 'not specified'}\n- Organization: ${answers.q11 || 'not specified'}\n- Default capture: ${answers.q12 || 'not specified'}\n- Archive policy: ${answers.q13 || 'not specified'}\n`;
    claudeContent = `# Rules\n\n## Execution\n- On project entry: ${answers.q10 || 'not specified'}\n\n## Boundaries\n- ${answers.q5 || 'not specified'}\n\n## Memory\n- Allowed: ${answers.q8 || 'not specified'}\n- Forbidden: ${answers.q9 || 'not specified'}\n`;
    memoryContent = `# Memory\n\n## User Goals\n- ${answers.q6 || 'not specified'}\n`;
  }

  // Write all core files
  fs.writeFileSync(path.join(workspacePath, 'soul.md'), soulContent, 'utf-8');
  fs.writeFileSync(path.join(workspacePath, 'user.md'), userContent, 'utf-8');
  if (claudeContent.trim()) {
    fs.writeFileSync(path.join(workspacePath, 'claude.md'), claudeContent, 'utf-8');
  }
  if (memoryContent.trim()) {
    fs.writeFileSync(path.join(workspacePath, 'memory.md'), memoryContent, 'utf-8');
  }

  // Ensure V2 directories
  ensureDailyDir(workspacePath);
  const inboxDir = path.join(workspacePath, 'Inbox');
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  // Generate config.json from answers
  try {
    const { loadConfig, saveConfig } = await import('@/lib/workspace-config');
    const config = loadConfig(workspacePath);

    const orgStyle = (answers.q11 || '').toLowerCase();
    if (orgStyle.includes('project')) config.organizationStyle = 'project';
    else if (orgStyle.includes('time')) config.organizationStyle = 'time';
    else if (orgStyle.includes('topic')) config.organizationStyle = 'topic';
    else config.organizationStyle = 'mixed';

    if (answers.q12) {
      let capture = answers.q12.trim();
      if (path.isAbsolute(capture) || capture.startsWith('~') || capture.includes('..')) {
        capture = 'Inbox';
      }
      config.captureDefault = capture;
    }

    saveConfig(workspacePath, config);
  } catch {
    // config module not available, skip
  }

  // Generate taxonomy from existing directories
  try {
    const { loadTaxonomy, saveTaxonomy, inferTaxonomyFromDirs } = await import('@/lib/workspace-taxonomy');
    const taxonomy = loadTaxonomy(workspacePath);
    if (taxonomy.categories.length === 0) {
      const inferred = inferTaxonomyFromDirs(workspacePath);
      if (inferred.length > 0) {
        taxonomy.categories = inferred;
        saveTaxonomy(workspacePath, taxonomy);
      }
    }
  } catch {
    // taxonomy module not available, skip
  }

  // Generate root docs
  generateRootDocs(workspacePath);

  // Update state
  const today = getLocalDateString();
  const state = loadState(workspacePath);
  state.onboardingComplete = true;
  state.lastCheckInDate = today;
  state.schemaVersion = 3;
  saveState(workspacePath, state);
}
