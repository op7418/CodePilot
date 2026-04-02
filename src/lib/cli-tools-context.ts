import { detectAllCliTools } from './cli-tools-detect';
import { CLI_TOOLS_CATALOG, EXTRA_WELL_KNOWN_BINS } from './cli-tools-catalog';
import { getAllCustomCliTools } from './db';

/**
 * Build a concise CLI tools context block for chat system prompt injection.
 * Includes both catalog tools and extra well-known binaries detected on the system.
 * Returns null if no tools are installed.
 */
export async function buildCliToolsContext(): Promise<string | null> {
  try {
    const { catalog, extra } = await detectAllCliTools();

    const catalogLines = catalog
      .filter(t => t.status === 'installed')
      .map(t => {
        const def = CLI_TOOLS_CATALOG.find(c => c.id === t.id);
        if (!def) return null;
        const ver = t.version ? ` (v${t.version})` : '';
        return `- ${def.name}${ver}: ${def.summaryEn}`;
      })
      .filter(Boolean);

    const extraLines = extra.map(t => {
      const entry = EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === t.id);
      const name = entry?.[1] ?? t.id;
      const ver = t.version ? ` (v${t.version})` : '';
      return `- ${name}${ver}`;
    });

    // Custom user-added tools
    const customTools = getAllCustomCliTools();
    const customLines = customTools.map(t => {
      const ver = t.version ? ` (v${t.version})` : '';
      return `- ${t.name}${ver}: ${t.binPath}`;
    });

    const allLines = [...catalogLines, ...extraLines, ...customLines];
    if (allLines.length === 0) return null;

    return `<available_cli_tools>\nThe following CLI tools are installed on this system and available for use:\n${allLines.join('\n')}\n</available_cli_tools>`;
  } catch {
    return null;
  }
}
