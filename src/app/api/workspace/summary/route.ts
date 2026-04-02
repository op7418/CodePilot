import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const { getSetting } = await import('@/lib/db');
    const workspacePath = getSetting('assistant_workspace_path');

    if (!workspacePath) {
      return NextResponse.json({ configured: false });
    }

    const fs = await import('fs');
    const path = await import('path');
    const { loadState } = await import('@/lib/assistant-workspace');

    // Check path exists
    if (!fs.existsSync(workspacePath)) {
      return NextResponse.json({ configured: false });
    }

    const state = loadState(workspacePath);

    // Extract assistant name from soul.md
    // Supports multiple formats:
    //   - "My name is Toki" / "name is Toki" / "名字是 Toki" / "叫 Toki"
    //   - "- name: Toki" / "name: Toki" (YAML-like)
    //   - "# Toki" (first heading)
    let assistantName = '';
    const soulVariants = ['soul.md', 'Soul.md', 'SOUL.md'];
    for (const variant of soulVariants) {
      const soulPath = path.join(workspacePath, variant);
      if (fs.existsSync(soulPath)) {
        const content = fs.readFileSync(soulPath, 'utf-8');
        // Try YAML-like "- name: XXX" or "name: XXX"
        const yamlMatch = content.match(/^[-*]?\s*name\s*[:：]\s*(.+)$/im);
        if (yamlMatch) {
          assistantName = yamlMatch[1].trim();
          break;
        }
        // Try "My name is XXX"
        const sentenceMatch = content.match(/(?:My name is|name is|名字是|叫)\s+([^.\n,]+)/i);
        if (sentenceMatch) {
          assistantName = sentenceMatch[1].trim().replace(/[.。]$/, '');
          break;
        }
        break;
      }
    }

    // Count memory files
    let memoryCount = 0;
    const dailyDir = path.join(workspacePath, 'memory', 'daily');
    if (fs.existsSync(dailyDir)) {
      memoryCount = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md')).length;
    }
    // Count memory.md as 1
    const memoryVariants = ['memory.md', 'Memory.md', 'MEMORY.md'];
    for (const v of memoryVariants) {
      if (fs.existsSync(path.join(workspacePath, v))) {
        memoryCount++;
        break;
      }
    }

    // Extract style from soul.md
    let styleHint = '';
    for (const variant of soulVariants) {
      const soulPath = path.join(workspacePath, variant);
      if (fs.existsSync(soulPath)) {
        const content = fs.readFileSync(soulPath, 'utf-8');
        const styleMatch = content.match(/^[-*]?\s*style\s*[:：]\s*(.+)$/im)
          || content.match(/## (?:Communication Style|沟通风格)\n+(.+)/m);
        if (styleMatch) {
          styleHint = styleMatch[1].trim().slice(0, 80);
        }
        break;
      }
    }

    // Recent daily memory dates (last 3)
    const recentDailyDates: string[] = [];
    if (fs.existsSync(dailyDir)) {
      const dailyFiles = fs.readdirSync(dailyDir)
        .filter((f: string) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, 3);
      for (const f of dailyFiles) {
        recentDailyDates.push(f.replace('.md', ''));
      }
    }

    // Workspace files health
    const fileHealth: Record<string, boolean> = {};
    for (const [key, variants] of Object.entries({ soul: soulVariants, user: ['user.md', 'User.md', 'USER.md'], claude: ['claude.md', 'Claude.md', 'CLAUDE.md'], memory: memoryVariants })) {
      fileHealth[key] = variants.some(v => fs.existsSync(path.join(workspacePath, v)));
    }
    fileHealth['heartbeat'] = fs.existsSync(path.join(workspacePath, 'HEARTBEAT.md'));

    // Count active scheduled tasks
    let taskCount = 0;
    try {
      const { listScheduledTasks } = await import('@/lib/db');
      taskCount = listScheduledTasks({ status: 'active' }).length;
    } catch { /* scheduled_tasks table may not exist yet */ }

    return NextResponse.json({
      configured: true,
      name: assistantName || '',
      styleHint,
      onboardingComplete: state.onboardingComplete,
      lastHeartbeatDate: state.lastHeartbeatDate,
      heartbeatEnabled: state.heartbeatEnabled,
      memoryCount,
      recentDailyDates,
      fileHealth,
      taskCount,
      buddy: state.buddy || null,
      buddyName: state.buddy?.buddyName || '',
    });
  } catch (e) {
    console.error('[workspace/summary] GET failed:', e);
    return NextResponse.json({ configured: false });
  }
}
