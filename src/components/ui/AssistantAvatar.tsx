'use client';

import { cn } from '@/lib/utils';
import Avatar from 'boring-avatars';
import { AVATAR_COLORS, DEFAULT_VARIANT, type AvatarVariant } from '@/lib/identicon';
import { SPECIES_AVATAR_VARIANT, RARITY_AVATAR_COLORS, type Species, type Rarity } from '@/lib/buddy';

interface AssistantAvatarProps {
  /** Name to generate avatar from */
  name: string;
  /** Size in pixels (default 32) */
  size?: number;
  /** Avatar style variant (default 'beam') */
  variant?: AvatarVariant;
  /** Buddy species — uses species-specific variant + emoji overlay */
  buddySpecies?: string;
  /** Buddy rarity — uses rarity-specific color palette */
  buddyRarity?: string;
  /** Buddy emoji — shown as overlay on the avatar */
  buddyEmoji?: string;
  /** Additional CSS classes */
  className?: string;
}

export function AssistantAvatar({
  name,
  size = 32,
  variant = DEFAULT_VARIANT,
  buddySpecies,
  buddyRarity,
  buddyEmoji,
  className,
}: AssistantAvatarProps) {
  // If buddy data provided, use species-specific variant and rarity colors
  let finalVariant = variant;
  let finalColors = AVATAR_COLORS;

  if (buddySpecies) {
    finalVariant = SPECIES_AVATAR_VARIANT[buddySpecies as Species] || variant;
    if (buddyRarity) {
      finalColors = RARITY_AVATAR_COLORS[buddyRarity as Rarity] || AVATAR_COLORS;
    }
  }

  return (
    <div
      className={cn('shrink-0 relative', className)}
      aria-label={`Avatar for ${name}`}
    >
      <Avatar
        size={size}
        name={name || 'assistant'}
        variant={finalVariant}
        colors={finalColors}
      />
      {/* Emoji overlay for buddy */}
      {buddyEmoji && size >= 24 && (
        <span
          className="absolute -bottom-0.5 -right-0.5 leading-none"
          style={{ fontSize: Math.max(10, size * 0.4) }}
        >
          {buddyEmoji}
        </span>
      )}
    </div>
  );
}
