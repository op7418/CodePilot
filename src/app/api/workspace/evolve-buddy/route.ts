import { NextResponse } from 'next/server';
import type { BuddyData } from '@/lib/buddy';

export async function POST() {
  try {
    const { getSetting } = await import('@/lib/db');
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) {
      return NextResponse.json({ error: 'No workspace' }, { status: 400 });
    }

    const fs = await import('fs');
    const path = await import('path');
    const { loadState, saveState } = await import('@/lib/assistant-workspace');
    const { checkEvolution, evolveBuddy, getRarityAbilities, getEnhancedPersonalityTraits, getBuddyTitle, SPECIES_LABEL, RARITY_DISPLAY } = await import('@/lib/buddy');

    const state = loadState(workspacePath);
    if (!state.buddy) {
      return NextResponse.json({ error: 'No buddy to evolve' }, { status: 400 });
    }

    // Count memories
    let memoryCount = 0;
    const dailyDir = path.join(workspacePath, 'memory', 'daily');
    if (fs.existsSync(dailyDir)) {
      memoryCount = fs.readdirSync(dailyDir).filter((f: string) => f.endsWith('.md')).length;
    }
    const memoryVariants = ['memory.md', 'Memory.md', 'MEMORY.md'];
    for (const v of memoryVariants) {
      if (fs.existsSync(path.join(workspacePath, v))) { memoryCount++; break; }
    }

    const buddy = state.buddy as BuddyData;
    const check = checkEvolution(buddy, memoryCount);
    if (!check.canEvolve) {
      return NextResponse.json({ evolved: false, check });
    }

    // Evolve!
    const evolved = evolveBuddy(buddy);
    state.buddy = evolved;
    saveState(workspacePath, state);

    // Update soul.md with enhanced traits
    const abilities = getRarityAbilities(evolved.rarity);
    if (abilities.enhancedPersonality) {
      const soulVariants = ['soul.md', 'Soul.md', 'SOUL.md'];
      for (const variant of soulVariants) {
        const soulPath = path.join(workspacePath, variant);
        if (fs.existsSync(soulPath)) {
          const content = fs.readFileSync(soulPath, 'utf-8');
          const traits = getEnhancedPersonalityTraits(evolved);
          // Replace existing Buddy Trait section
          const newSection = `## Buddy Trait\n${traits.join('\n')}\n`;
          const updated = content.includes('## Buddy Trait')
            ? content.replace(/## Buddy Trait[\s\S]*?(?=\n##|$)/, newSection)
            : content + '\n\n' + newSection;
          fs.writeFileSync(soulPath, updated, 'utf-8');
          break;
        }
      }
    }

    // Celebration message
    try {
      const { addMessage, getLatestSessionByWorkingDirectory } = await import('@/lib/db');
      const session = getLatestSessionByWorkingDirectory(workspacePath);
      if (session) {
        const speciesName = SPECIES_LABEL[evolved.species as keyof typeof SPECIES_LABEL]?.zh || evolved.species;
        const rarityInfo = RARITY_DISPLAY[evolved.rarity as keyof typeof RARITY_DISPLAY];
        const title = getBuddyTitle(evolved);
        const titleText = title ? `"${title}"` : '';

        addMessage(session.id, 'assistant',
          `\u{1F31F} **\u8FDB\u5316\u6210\u529F\uFF01**\n\n${evolved.emoji} ${titleText} **${speciesName}** \u8FDB\u5316\u4E3A ${rarityInfo?.stars || ''} ${rarityInfo?.label.zh || evolved.rarity}\uFF01\n\n\u5C5E\u6027\u5168\u9762\u63D0\u5347\uFF01`
        );
      }
    } catch { /* best effort */ }

    return NextResponse.json({ evolved: true, buddy: evolved, check });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
