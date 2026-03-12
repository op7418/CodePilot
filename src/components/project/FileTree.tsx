"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowsClockwise, MagnifyingGlass, FileCode, Code, File } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "@/types";
import {
  FileTree as AIFileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import { useTranslation } from "@/hooks/useTranslation";
import type { ReactNode } from "react";

interface FileTreeProps {
  workingDirectory: string;
  onFileSelect: (path: string) => void;
  onFileAdd?: (path: string) => void;
}

function getFileIcon(extension?: string): ReactNode {
  switch (extension) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "rb":
    case "rs":
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
    case "cs":
    case "swift":
    case "kt":
    case "dart":
    case "lua":
    case "php":
    case "zig":
      return <FileCode size={16} className="text-muted-foreground" />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return <Code size={16} className="text-muted-foreground" />;
    case "md":
    case "mdx":
    case "txt":
    case "csv":
      return <File size={16} className="text-muted-foreground" />;
    default:
      return <File size={16} className="text-muted-foreground" />;
  }
}

function containsMatch(node: FileTreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.children) {
    return node.children.some((child) => containsMatch(child, q));
  }
  return false;
}

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  return nodes
    .filter((node) => containsMatch(node, query))
    .map((node) => ({
      ...node,
      children: node.children ? filterTree(node.children, query) : undefined,
    }));
}

function RenderTreeNodes({ nodes, searchQuery }: { nodes: FileTreeNode[]; searchQuery: string }) {
  const filtered = searchQuery ? filterTree(nodes, searchQuery) : nodes;

  return (
    <>
      {filtered.map((node) => {
        if (node.type === "directory") {
          return (
            <FileTreeFolder key={node.path} path={node.path} name={node.name}>
              {node.children && (
                <RenderTreeNodes nodes={node.children} searchQuery={searchQuery} />
              )}
            </FileTreeFolder>
          );
        }
        return (
          <FileTreeFile
            key={node.path}
            path={node.path}
            name={node.name}
            icon={getFileIcon(node.extension)}
          />
        );
      })}
    </>
  );
}

export function FileTree({ workingDirectory, onFileSelect, onFileAdd }: FileTreeProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const { t } = useTranslation();

  const fetchTree = useCallback(async () => {
    // Always cancel in-flight request first — even when clearing directory,
    // otherwise a stale response from the old project can arrive and repopulate the tree.
    if (abortRef.current) {
      abortRef.current.abort();
    }

    if (!workingDirectory) {
      abortRef.current = null;
      setTree([]);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/files?dir=${encodeURIComponent(workingDirectory)}&baseDir=${encodeURIComponent(workingDirectory)}&depth=4&_t=${Date.now()}`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      if (res.ok) {
        const data = await res.json();
        if (controller.signal.aborted) return;
        setTree(data.tree || []);
      } else {
        const errData = await res.json().catch(() => ({ error: res.statusText }));
        setTree([]);
        setError(errData.error || `Failed to load (${res.status})`);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setTree([]);
      setError('Failed to load file tree');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // Auto-refresh when AI finishes streaming
  useEffect(() => {
    const handler = () => fetchTree();
    window.addEventListener('refresh-file-tree', handler);
    return () => window.removeEventListener('refresh-file-tree', handler);
  }, [fetchTree]);

  // Default to all directories collapsed
  const defaultExpanded = new Set<string>();

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Search + Refresh */}
      <div className="flex items-center gap-1.5 px-4 py-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <MagnifyingGlass size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder={t('fileTree.filterFiles')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={fetchTree}
          disabled={loading}
          className="h-7 w-7 shrink-0"
        >
          <ArrowsClockwise size={12} className={cn(loading && "animate-spin")} />
          <span className="sr-only">{t('fileTree.refresh')}</span>
        </Button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto">
        {loading && tree.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <ArrowsClockwise size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : tree.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {error ? error : workingDirectory ? t('fileTree.noFiles') : t('fileTree.selectFolder')}
          </p>
        ) : (
          <AIFileTree
            defaultExpanded={defaultExpanded}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI Elements FileTree onSelect type conflicts with HTMLAttributes.onSelect
            onSelect={onFileSelect as any}
            onAdd={onFileAdd}
            className="border-0 rounded-none"
          >
            <RenderTreeNodes nodes={tree} searchQuery={searchQuery} />
          </AIFileTree>
        )}
      </div>
    </div>
  );
}
