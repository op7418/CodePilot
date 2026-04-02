/**
 * Deterministic avatar generation using boring-avatars.
 * Same name always produces the same avatar.
 *
 * boring-avatars is a React component library, so this module
 * re-exports the configuration for use in AssistantAvatar.tsx.
 */

/**
 * Color palette for assistant avatars.
 * Derived from CodePilot's OKLCH primary color family.
 */
export const AVATAR_COLORS = [
  '#6C5CE7', // purple-blue (primary)
  '#A29BFE', // light purple
  '#74B9FF', // sky blue
  '#55EFC4', // mint
  '#FFEAA7', // warm yellow
];

/**
 * Available avatar variants from boring-avatars.
 * 'beam' is the default — clean, geometric, friendly.
 */
export type AvatarVariant = 'marble' | 'beam' | 'pixel' | 'sunset' | 'ring' | 'bauhaus';

export const DEFAULT_VARIANT: AvatarVariant = 'beam';
