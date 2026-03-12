'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PluginCard, type SkillInfo } from './PluginCard';
import { MagnifyingGlass, Globe, FolderOpen, Plug } from "@/components/ui/icon";

interface PluginListProps {
  plugins: SkillInfo[];
  onSelect: (plugin: SkillInfo) => void;
}

export function PluginList({ plugins, onSelect }: PluginListProps) {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'global' | 'project' | 'plugin'>('all');

  const filtered = plugins.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase());
    if (sourceFilter === 'all') return matchesSearch;
    return matchesSearch && p.source === sourceFilter;
  });

  const globalCount = plugins.filter((p) => p.source === 'global').length;
  const projectCount = plugins.filter((p) => p.source === 'project').length;
  const pluginCount = plugins.filter((p) => p.source === 'plugin').length;

  return (
    <div className="space-y-4">
      <div className="relative">
        <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills by name..."
          className="pl-9"
        />
      </div>

      <Tabs
        value={sourceFilter}
        onValueChange={(v) => setSourceFilter(v as 'all' | 'global' | 'project' | 'plugin')}
      >
        <TabsList>
          <TabsTrigger value="all">
            All ({plugins.length})
          </TabsTrigger>
          <TabsTrigger value="global" className="gap-1.5">
            <Globe size={14} />
            Global ({globalCount})
          </TabsTrigger>
          <TabsTrigger value="project" className="gap-1.5">
            <FolderOpen size={14} />
            Project ({projectCount})
          </TabsTrigger>
          {pluginCount > 0 && (
            <TabsTrigger value="plugin" className="gap-1.5">
              <Plug size={14} />
              Plugin ({pluginCount})
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value={sourceFilter} className="mt-4">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <p className="text-sm">
                {plugins.length === 0
                  ? 'No skills found'
                  : 'No matching skills'}
              </p>
              <p className="text-xs mt-1">
                {plugins.length === 0
                  ? 'Add .md files to ~/.claude/commands/ or .claude/commands/ to create skills'
                  : 'Try adjusting your search or filter'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((plugin) => (
                <PluginCard
                  key={plugin.name}
                  plugin={plugin}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
