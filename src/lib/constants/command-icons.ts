/**
 * Icon assignments for built-in commands.
 *
 * Separated from commands.ts so the constants layer stays presentation-free.
 * Consumed by useSlashCommands to enrich BUILT_IN_COMMANDS before rendering.
 */

import {
  Question,
  Trash,
  Coins,
  FileZip,
  Stethoscope,
  NotePencil,
  ListMagnifyingGlass,
  Brain,
  Terminal,
} from "@/components/ui/icon";
import type { IconComponent } from '@/types';

/** Map from command value (e.g. "/help") to its display icon. */
export const COMMAND_ICONS: Record<string, IconComponent> = {
  '/help': Question,
  '/clear': Trash,
  '/cost': Coins,
  '/compact': FileZip,
  '/doctor': Stethoscope,
  '/init': NotePencil,
  '/review': ListMagnifyingGlass,
  '/terminal-setup': Terminal,
  '/memory': Brain,
};
