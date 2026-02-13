"use client";

import { useState, useEffect, useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon, Search01Icon, SourceCodeIcon, CodeIcon, File01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "@/types";
import {
  FileTree as AIFileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
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
      return <HugeiconsIcon icon={SourceCodeIcon} className="size-4 text-muted-foreground" />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return <HugeiconsIcon icon={CodeIcon} className="size-4 text-muted-foreground" />;
    case "md":
    case "mdx":
    case "txt":
    case "csv":
      return <HugeiconsIcon icon={File01Icon} className="size-4 text-muted-foreground" />;
    default:
      return <HugeiconsIcon icon={File01Icon} className="size-4 text-muted-foreground" />;
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
  const [searchQuery, setSearchQuery] = useState("");

  const fetchTree = useCallback(async () => {
    if (!workingDirectory) {
      setTree([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/files?dir=${encodeURIComponent(workingDirectory)}&depth=4`
      );
      if (res.ok) {
        const data = await res.json();
        setTree(data.tree || []);
      } else {
        setTree([]);
      }
    } catch {
      setTree([]);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // Auto-refresh when AI finishes streaming
  useEffect(() => {
    const handler = () => fetchTree();
    window.addEventListener('refresh-file-tree', handler);
    return () => window.removeEventListener('refresh-file-tree', handler);
  }, [fetchTree]);

  // Build default expanded set from first-level directories
  const defaultExpanded = new Set(
    tree.filter((n) => n.type === "directory").map((n) => n.path)
  );

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 p-2 border-b border-border/30">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={workingDirectory}>
          {workingDirectory || 'No directory selected'}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={fetchTree}
          disabled={loading}
          className="h-6 w-6 shrink-0"
        >
          <HugeiconsIcon icon={RefreshIcon} className={cn("h-3 w-3", loading && "animate-spin")} />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>

      {/* Search */}
      <div className="relative p-2 border-b border-border/30">
        <HugeiconsIcon icon={Search01Icon} className="absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Filter files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-7 pl-7 text-xs"
        />
      </div>

      {/* Tree */}
      <div className="max-h-[400px] overflow-auto">
        {loading && tree.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon icon={RefreshIcon} className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : tree.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {workingDirectory ? 'No files found' : 'Select a project folder to view files'}
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
