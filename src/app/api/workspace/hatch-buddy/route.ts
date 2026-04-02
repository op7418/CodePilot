import { NextResponse } from 'next/server';

/**
 * POST /api/workspace/hatch-buddy
 *
 * Generate a buddy for an existing assistant workspace that doesn't have one.
 * Uses workspace path + current timestamp as seed for deterministic generation.
 */
export async function POST(request: Request) {
  try {
    const { getSetting } = await import('@/lib/db');
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) {
      return NextResponse.json({ error: 'No workspace configured' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const { buddyName } = body as { buddyName?: string };

    const fs = await import('fs');
    const path = await import('path');
    const { loadState, saveState } = await import('@/lib/assistant-workspace');
    const { generateBuddy, getPeakStatHint } = await import('@/lib/buddy');

    const state = loadState(workspacePath);

    // If buddy already exists, update name if provided
    if (state.buddy) {
      if (buddyName) {
        state.buddy.buddyName = buddyName;
        saveState(workspacePath, state);
      }
      return NextResponse.json({ buddy: state.buddy, alreadyHatched: true });
    }

    // Generate buddy
    const seed = workspacePath + ':' + new Date().toISOString();
    const buddy = generateBuddy(seed);

    // Set buddy name if provided
    if (buddyName) buddy.buddyName = buddyName;

    // Save to state
    state.buddy = buddy;
    saveState(workspacePath, state);

    // Append peak stat personality hint to soul.md
    const soulVariants = ['soul.md', 'Soul.md', 'SOUL.md'];
    for (const variant of soulVariants) {
      const soulPath = path.join(workspacePath, variant);
      if (fs.existsSync(soulPath)) {
        const existingSoul = fs.readFileSync(soulPath, 'utf-8');
        if (!existingSoul.includes('## Buddy Trait')) {
          const hint = getPeakStatHint(buddy.peakStat as Parameters<typeof getPeakStatHint>[0]);
          fs.appendFileSync(soulPath, `\n\n## Buddy Trait\n${hint}\n`, 'utf-8');
        }
        break;
      }
    }

    // Insert celebration message with show-widget card into chat
    try {
      const { addMessage, getLatestSessionByWorkingDirectory } = await import('@/lib/db');
      const { SPECIES_LABEL, RARITY_DISPLAY, STAT_LABEL, getBuddyTitle, rarityColor: getRarityColorClass } = await import('@/lib/buddy');
      const session = getLatestSessionByWorkingDirectory(workspacePath);
      if (session) {
        const speciesName = SPECIES_LABEL[buddy.species as keyof typeof SPECIES_LABEL]?.zh || buddy.species;
        const rarityInfo = RARITY_DISPLAY[buddy.rarity as keyof typeof RARITY_DISPLAY];
        const title = getBuddyTitle(buddy as Parameters<typeof getBuddyTitle>[0]);
        const buddyDisplayName = buddy.buddyName || speciesName;

        // Build personality summary from species + peak stat
        const personalitySummary: Record<string, string> = {
          creativity: '富有创意的',
          patience: '耐心温和的',
          insight: '善于洞察的',
          humor: '幽默风趣的',
          precision: '精确严谨的',
        };
        const buddySummary = `一只${personalitySummary[buddy.peakStat] || ''}${speciesName}`;

        // Rarity color
        const rarityColorMap: Record<string, string> = { common: '#94a3b8', uncommon: '#22c55e', rare: '#3b82f6', epic: '#a855f7', legendary: '#f59e0b' };
        const rarityHexColor = rarityColorMap[buddy.rarity] || '#888';
        const lighterRarityColor: Record<string, string> = { common: '#cbd5e1', uncommon: '#86efac', rare: '#93c5fd', epic: '#d8b4fe', legendary: '#fcd34d' };
        const lighterColor = lighterRarityColor[buddy.rarity] || '#bbb';
        const rarityLabels: Record<string, string> = { common: '★ 普通', uncommon: '★★ 稀有', rare: '★★★ 精良', epic: '★★★★ 史诗', legendary: '★★★★★ 传说' };

        // Build stat bars HTML with gradient fills
        const statEntries = Object.entries(buddy.stats) as [string, number][];
        const statBarsHtml = statEntries.map(([stat, val]) => {
          const label = STAT_LABEL[stat as keyof typeof STAT_LABEL]?.zh || stat;
          const isPeak = stat === buddy.peakStat;
          const barBg = `linear-gradient(90deg, ${rarityHexColor}, ${lighterColor})`;
          const peakStyle = isPeak ? 'font-weight:700;color:#4c1d95' : 'color:#888';
          return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><span style="width:32px;font-size:11px;${peakStyle}">${label}${isPeak ? ' ⭐' : ''}</span><div style="flex:1;height:8px;border-radius:4px;background:#eee;overflow:hidden"><div style="height:100%;border-radius:4px;background:${barBg};width:${val}%"></div></div><span style="width:24px;text-align:right;font-size:11px;color:#888">${val}</span></div>`;
        }).join('');

        // Legendary shimmer animation
        const legendaryShimmer = buddy.rarity === 'legendary' ? 'background-image:linear-gradient(90deg, transparent, rgba(245,158,11,0.1), transparent);background-size:200% 100%;animation:shimmer 3s linear infinite;' : '';
        const borderStyle = `border:2px solid ${rarityHexColor}33`;
        const legendaryBorderOverride = buddy.rarity === 'legendary' ? `border:2px solid #f59e0b;box-shadow:0 0 16px rgba(245,158,11,0.25);` : '';

        // Widget HTML — gamified card
        const widgetHtml = `<div style="text-align:center;padding:28px 20px;font-family:system-ui;background:linear-gradient(135deg, #fafafa 0%, #f5f0ff 100%);border-radius:16px;${borderStyle};${legendaryBorderOverride}${legendaryShimmer}"><style>@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes shimmer{0%{background-position:-200% center}100%{background-position:200% center}}</style><div style="font-size:64px;animation:fadeIn 0.5s ease-out;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.1))">${buddy.emoji}</div>${buddyDisplayName ? `<div style="font-size:18px;font-weight:700;margin:8px 0 2px;color:#1e1b4b;animation:fadeIn 0.6s ease-out">${buddyDisplayName}</div>` : ''}<div style="display:inline-block;padding:4px 16px;border-radius:20px;background:linear-gradient(135deg,${rarityHexColor}22,${lighterColor}22);color:${rarityHexColor};font-size:12px;font-weight:600;margin:6px 0">${rarityLabels[buddy.rarity] || buddy.rarity}</div><div style="font-size:13px;color:#555;margin:4px 0 16px;animation:fadeIn 0.7s ease-out">${buddySummary}</div><div style="max-width:240px;margin:0 auto;animation:fadeIn 0.8s ease-out">${statBarsHtml}</div><div style="margin-top:20px"><input id="buddy-name-input" type="text" placeholder="给你的伙伴起个名字..." style="width:80%;max-width:200px;padding:8px 16px;border-radius:20px;border:1px solid #ddd;text-align:center;font-size:14px;outline:none" onfocus="this.style.borderColor='#6C5CE7'" onblur="this.style.borderColor='#ddd'"/><br/><button onclick="var n=document.getElementById('buddy-name-input').value;window.parent.postMessage({type:'widget:name-buddy',buddyName:n},'*');this.textContent='✓ 已保存';this.disabled=true" style="margin-top:8px;background:#6C5CE7;color:white;border:none;padding:8px 24px;border-radius:16px;font-size:13px;cursor:pointer">确认名字</button></div></div>`;

        const widgetJson = JSON.stringify({ title: 'buddy_reveal', widget_code: widgetHtml });
        const message = `🎉 **孵化成功！**\n\n你的助理伙伴诞生了！来认识一下吧：\n\n\`\`\`show-widget\n${widgetJson}\n\`\`\`\n\n${buddy.emoji} **${buddyDisplayName}** 是一只${title ? `"${title}"的` : ''}${speciesName}，稀有度为 ${rarityInfo?.stars || ''} ${rarityInfo?.label.zh || buddy.rarity}。\n\n从现在开始，${buddyDisplayName} 将作为你的助理伙伴，陪伴你的每一次对话。随着你们互动越多，它还会成长和进化哦！`;

        addMessage(session.id, 'assistant', message);
      }
    } catch { /* best effort */ }

    return NextResponse.json({ buddy, alreadyHatched: false });
  } catch (e) {
    console.error('[workspace/hatch-buddy] POST failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
