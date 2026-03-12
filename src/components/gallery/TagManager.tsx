'use client';

import { useState, useCallback, useEffect } from 'react';
import { Plus, X } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';

export interface Tag {
  id: string;
  name: string;
  color?: string;
}

const PRESET_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
];

interface TagManagerProps {
  tags: Tag[];
  selectedTags?: string[];
  onToggleTag?: (tagId: string) => void;
  onAddTag?: (name: string, color?: string) => void;
  onRemoveTag?: (tagId: string) => void;
  editable?: boolean;
  compact?: boolean;
}

export function TagManager({
  tags,
  selectedTags = [],
  onToggleTag,
  onAddTag,
  onRemoveTag,
  editable = false,
  compact = false,
}: TagManagerProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);

  const handleAdd = useCallback(() => {
    if (!newName.trim()) return;
    onAddTag?.(newName.trim(), newColor);
    setNewName('');
    setAdding(false);
  }, [newName, newColor, onAddTag]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => {
          const isSelected = selectedTags.includes(tag.id);
          return (
            <Button
              key={tag.id}
              variant="ghost"
              size="xs"
              onClick={() => onToggleTag?.(tag.id)}
              className="group inline-flex items-center gap-1 h-auto p-0"
            >
              <Badge
                variant={isSelected ? 'default' : 'outline'}
                className={cn(
                  'text-[11px] cursor-pointer transition-colors',
                  compact && 'px-1.5 py-0',
                  isSelected && tag.color && 'border-transparent'
                )}
                style={isSelected && tag.color ? { backgroundColor: `${tag.color}20`, color: tag.color, borderColor: `${tag.color}40` } : undefined}
              >
                {tag.color && (
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                )}
                {tag.name}
                {editable && onRemoveTag && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveTag(tag.id);
                    }}
                    className="ml-0.5 rounded-full h-4 w-4 opacity-0 group-hover:opacity-100 hover:bg-foreground/10"
                  >
                    <X size={10} />
                  </Button>
                )}
              </Badge>
            </Button>
          );
        })}

        {editable && !adding && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setAdding(true)}
            className="h-5 w-5"
          >
            <Plus size={12} />
          </Button>
        )}
      </div>

      {adding && (
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder={t('gallery.newTagPlaceholder' as TranslationKey)}
            className="flex-1 h-7 text-xs"
            autoFocus
          />
          <div className="flex items-center gap-1">
            {PRESET_COLORS.map((color) => (
              <Button
                key={color}
                variant="ghost"
                size="icon-xs"
                onClick={() => setNewColor(color)}
                className={cn(
                  'h-4 w-4 rounded-full p-0',
                  newColor === color ? 'ring-2 ring-offset-1 ring-offset-background' : 'hover:scale-110'
                )}
                style={{ backgroundColor: color, '--tw-ring-color': color } as React.CSSProperties}
              />
            ))}
          </div>
          <Button size="xs" onClick={handleAdd}>
            {t('gallery.addTag' as TranslationKey)}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setAdding(false)}>
            {t('gallery.cancel' as TranslationKey)}
          </Button>
        </div>
      )}
    </div>
  );
}

// Hook to fetch tags from API
export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch('/api/media/tags');
      if (res.ok) {
        const data = await res.json();
        setTags(data.tags || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const addTag = useCallback(async (name: string, color?: string) => {
    try {
      const res = await fetch('/api/media/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (res.ok) {
        const tag = await res.json();
        setTags((prev) => [...prev, tag]);
        return tag;
      }
    } catch {
      // ignore
    }
    return null;
  }, []);

  const removeTag = useCallback(async (tagId: string) => {
    try {
      const res = await fetch(`/api/media/tags/${tagId}`, { method: 'DELETE' });
      if (res.ok) {
        setTags((prev) => prev.filter((t) => t.id !== tagId));
      }
    } catch {
      // ignore
    }
  }, []);

  return { tags, loading, fetchTags, addTag, removeTag };
}
