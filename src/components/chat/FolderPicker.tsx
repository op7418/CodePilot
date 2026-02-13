'use client';

import { useState, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon, FolderOpenIcon, ArrowRight01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/hooks/useTranslation';

interface FolderEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  current: string;
  parent: string | null;
  directories: FolderEntry[];
  drives?: string[];
}

interface FolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export function FolderPicker({ open, onOpenChange, onSelect, initialPath }: FolderPickerProps) {
  const { t } = useTranslation();
  const [currentDir, setCurrentDir] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [directories, setDirectories] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [drives, setDrives] = useState<string[]>([]);

  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    try {
      const url = dir
        ? `/api/files/browse?dir=${encodeURIComponent(dir)}`
        : '/api/files/browse';
      const res = await fetch(url);
      if (res.ok) {
        const data: BrowseResponse = await res.json();
        setCurrentDir(data.current);
        setParentDir(data.parent);
        setDirectories(data.directories);
        setPathInput(data.current);
        setDrives(data.drives || []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      browse(initialPath || undefined);
    }
  }, [open, initialPath, browse]);

  const handleNavigate = (dir: string) => {
    browse(dir);
  };

  const handleGoUp = () => {
    if (parentDir) browse(parentDir);
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      browse(pathInput.trim());
    }
  };

  const handleSelect = () => {
    onSelect(currentDir);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('folder.selectProjectFolder')}</DialogTitle>
        </DialogHeader>

        {/* Path input */}
        <form onSubmit={handlePathSubmit} className="flex gap-2">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/path/to/project"
            className="flex-1 font-mono text-sm"
          />
          <Button type="submit" variant="outline" size="sm">
            {t('folder.go')}
          </Button>
        </form>

        {/* Directory browser */}
        <div className="rounded-md border border-border">
          {/* Current path + go up + drive switcher */}
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleGoUp}
              disabled={!parentDir}
              className="shrink-0"
            >
              <HugeiconsIcon icon={ArrowUp01Icon} className="h-4 w-4" />
            </Button>
            {drives.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs font-mono shrink-0">
                    {currentDir.charAt(0).toUpperCase()}:
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {drives.map((drive) => {
                    const letter = drive.charAt(0).toUpperCase();
                    const isCurrent = currentDir.toUpperCase().startsWith(letter + ':');
                    return (
                      <DropdownMenuItem
                        key={drive}
                        className="font-mono text-sm gap-2"
                        onClick={() => browse(drive)}
                      >
                        <span className={isCurrent ? 'font-bold' : ''}>{letter}:</span>
                        <span className="text-muted-foreground text-xs">{drive}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <span className="min-w-0 overflow-x-auto whitespace-nowrap text-xs font-mono text-muted-foreground">
              {currentDir}
            </span>
          </div>

          {/* Folder list */}
          <ScrollArea className="h-64">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {t('folder.loading')}
              </div>
            ) : directories.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {t('folder.noSubdirectories')}
              </div>
            ) : (
              <div className="p-1">
                {directories.map((dir) => (
                  <button
                    key={dir.path}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                    onClick={() => handleNavigate(dir.path)}
                  >
                    <HugeiconsIcon icon={Folder01Icon} className="h-4 w-4 shrink-0 text-blue-500" />
                    <span className="truncate">{dir.name}</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('folder.cancel')}
          </Button>
          <Button onClick={handleSelect} className="gap-2">
            <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
            {t('folder.selectThisFolder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
