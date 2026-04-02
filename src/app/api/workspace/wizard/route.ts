import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userName, userRole, assistantName, style, boundaries } = body as {
      userName: string;
      userRole: string;
      assistantName: string;
      style: string;
      boundaries: string;
    };

    // Always use the configured workspace path from settings — never trust client input
    const { getSetting } = await import('@/lib/db');
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) {
      return NextResponse.json({ error: 'No workspace path configured. Set it in Settings → Assistant.' }, { status: 400 });
    }

    const fs = await import('fs');
    const path = await import('path');
    const { initializeWorkspace, loadState, saveState } = await import('@/lib/assistant-workspace');
    const { HEARTBEAT_TEMPLATE } = await import('@/lib/heartbeat');
    const { getLocalDateString } = await import('@/lib/utils');
    const { createSession } = await import('@/lib/db');

    // Ensure workspace is initialized (creates dirs + default template files)
    initializeWorkspace(workspacePath);

    // Don't overwrite existing files (respect user customizations)
    const writeIfMissing = (filePath: string, content: string): boolean => {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
      }
      return false; // File already exists, preserved
    };

    // Write user.md
    const userContent = `# User Profile

## Basic Info
- Name: ${userName || 'User'}
- Role: ${userRole || 'General'}

## Current Goals
(To be filled during conversations)

## Preferences
(Will be learned over time)

## Workspace Organization
(Will be configured during use)
`;
    writeIfMissing(path.join(workspacePath, 'user.md'), userContent);

    // Write soul.md
    const styleMap: Record<string, string> = {
      concise: '简洁直接，不啰嗦，直奔主题。回答问题先给结论再展开。',
      detailed: '详细耐心，步骤清晰，适当举例。确保用户完全理解。',
      casual: '轻松友好，语气自然，像朋友聊天。适当使用口语化表达。',
    };
    const soulContent = `# Soul

## Core Personality
${assistantName ? `My name is ${assistantName}.` : 'I am your personal assistant.'} I help you manage tasks, organize information, and think through problems.

## Communication Style
${styleMap[style] || styleMap.concise}

## Behavioral Boundaries
${boundaries || 'No specific boundaries set. Will respect user preferences as they emerge.'}

## Relationship
${userName ? `I address the user as ${userName}.` : 'I use a friendly, respectful tone.'} I proactively help but don't over-explain.
`;
    writeIfMissing(path.join(workspacePath, 'soul.md'), soulContent);

    // claude.md is already created by initializeWorkspace with system preset rules
    // memory.md is already created by initializeWorkspace

    // Write HEARTBEAT.md if not exists
    const heartbeatPath = path.join(workspacePath, 'HEARTBEAT.md');
    if (!fs.existsSync(heartbeatPath)) {
      fs.writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE, 'utf-8');
    }

    // Update state
    const today = getLocalDateString();
    const state = loadState(workspacePath);
    state.onboardingComplete = true;
    state.lastHeartbeatDate = today;
    state.heartbeatEnabled = true;
    state.schemaVersion = 5;
    // Generate buddy companion
    const { generateBuddy, getPeakStatHint } = await import('@/lib/buddy');
    const buddySeed = workspacePath + ':' + new Date().toISOString();
    const buddy = generateBuddy(buddySeed);
    state.buddy = buddy;

    // Append peak stat personality hint to soul.md
    const soulPath = path.join(workspacePath, 'soul.md');
    if (fs.existsSync(soulPath)) {
      const existingSoul = fs.readFileSync(soulPath, 'utf-8');
      if (!existingSoul.includes('## Buddy Trait')) {
        const hint = getPeakStatHint(buddy.peakStat as Parameters<typeof getPeakStatHint>[0]);
        fs.appendFileSync(soulPath, `\n\n## Buddy Trait\n${hint}\n`, 'utf-8');
      }
    }

    saveState(workspacePath, state);

    // Create session
    const { addMessage } = await import('@/lib/db');
    const session = createSession(undefined, '', undefined, workspacePath, 'code', '');

    // Insert celebration message into the newly created session
    try {
      const { SPECIES_LABEL, RARITY_DISPLAY, STAT_LABEL } = await import('@/lib/buddy');
      const speciesName = SPECIES_LABEL[buddy.species as keyof typeof SPECIES_LABEL]?.zh || buddy.species;
      const rarityInfo = RARITY_DISPLAY[buddy.rarity as keyof typeof RARITY_DISPLAY];
      const statsText = Object.entries(buddy.stats)
        .map(([stat, val]) => `${STAT_LABEL[stat as keyof typeof STAT_LABEL]?.zh || stat}: ${val}`)
        .join(' \u00B7 ');

      const message = `\uD83C\uDF89 **\u4F60\u7684\u52A9\u7406\u4F19\u4F34\u5B75\u5316\u4E86\uFF01**\n\n${buddy.emoji} **${speciesName}** ${rarityInfo?.stars || ''} ${rarityInfo?.label.zh || buddy.rarity}\n\n${statsText}\n\n\u4ECE\u73B0\u5728\u5F00\u59CB\uFF0C\u8FD9\u4E2A ${speciesName} \u5C06\u4F5C\u4E3A\u4F60\u7684\u52A9\u7406\u4F19\u4F34\uFF0C\u966A\u4F34\u4F60\u7684\u6BCF\u4E00\u6B21\u5BF9\u8BDD\u3002`;

      addMessage(session.id, 'assistant', message);
    } catch { /* best effort */ }

    return NextResponse.json({
      success: true,
      session,
      assistantName: assistantName || 'Personal Assistant',
      buddy,
    });
  } catch (e) {
    console.error('[workspace/wizard] POST failed:', e);
    const message = e instanceof Error ? e.message : 'Wizard setup failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
