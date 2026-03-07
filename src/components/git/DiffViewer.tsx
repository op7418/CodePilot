"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { GitDiff, GitDiffLine } from "@/types/git";

interface DiffViewerProps {
  diff: GitDiff;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  // Calculate line numbers width
  const maxOldLine = useMemo(() => {
    let max = 0;
    diff.hunks.forEach(hunk => {
      hunk.lines.forEach(line => {
        if (line.oldLineNumber && line.oldLineNumber > max) max = line.oldLineNumber;
      });
    });
    return max;
  }, [diff]);

  const maxNewLine = useMemo(() => {
    let max = 0;
    diff.hunks.forEach(hunk => {
      hunk.lines.forEach(line => {
        if (line.newLineNumber && line.newLineNumber > max) max = line.newLineNumber;
      });
    });
    return max;
  }, [diff]);

  const lineNumberWidth = Math.max(
    String(maxOldLine).length,
    String(maxNewLine).length
  ) * 0.6 + 1;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2">
        <span className="truncate text-sm font-medium">{diff.file}</span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="text-green-500">+{diff.additions}</span>
          <span className="text-red-500">-{diff.deletions}</span>
        </div>
      </div>

      {/* Diff Content */}
      <div className="flex-1 overflow-auto font-mono text-xs">
        {diff.hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex}>
            {/* Hunk Header */}
            <div className="sticky top-0 bg-muted/50 px-4 py-1 text-xs text-muted-foreground">
              {hunk.header}
            </div>

            {/* Lines */}
            <div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLine
                  key={`${hunkIndex}-${lineIndex}`}
                  line={line}
                  lineNumberWidth={lineNumberWidth}
                />
              ))}
            </div>
          </div>
        ))}

        {diff.hunks.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            No changes
          </div>
        )}
      </div>
    </div>
  );
}

interface DiffLineProps {
  line: GitDiffLine;
  lineNumberWidth: number;
}

function DiffLine({ line, lineNumberWidth }: DiffLineProps) {
  const bgColor = {
    add: "bg-green-500/10",
    delete: "bg-red-500/10",
    context: "",
  }[line.type];

  const linePrefix = {
    add: "+",
    delete: "-",
    context: " ",
  }[line.type];

  const textColor = {
    add: "text-green-600 dark:text-green-400",
    delete: "text-red-600 dark:text-red-400",
    context: "text-foreground",
  }[line.type];

  return (
    <div className={cn("flex hover:bg-accent/30", bgColor)}>
      {/* Old Line Number */}
      <div
        className="shrink-0 text-right text-muted-foreground/50 select-none border-r border-border/30 pr-2 mr-2"
        style={{ width: `${lineNumberWidth}rem` }}
      >
        {line.oldLineNumber || ""}
      </div>

      {/* New Line Number */}
      <div
        className="shrink-0 text-right text-muted-foreground/50 select-none border-r border-border/30 pr-2 mr-2"
        style={{ width: `${lineNumberWidth}rem` }}
      >
        {line.newLineNumber || ""}
      </div>

      {/* Content */}
      <pre className={cn("flex-1 whitespace-pre-wrap break-all pl-1", textColor)}>
        <span className="opacity-50">{linePrefix}</span>
        {line.content}
      </pre>
    </div>
  );
}
