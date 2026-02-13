'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  File01Icon,
  FileEditIcon,
  CommandLineIcon,
  Search01Icon,
  Wrench01Icon,
  Loading02Icon,
  CheckmarkCircle02Icon,
  CancelCircleIcon,
} from "@hugeicons/core-free-icons";
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolAction {
  id?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}

interface ToolActionsGroupProps {
  tools: ToolAction[];
  isStreaming?: boolean;
  streamingToolOutput?: string;
}

// ---------------------------------------------------------------------------
// Tool categorisation
// ---------------------------------------------------------------------------

type ToolCategory = 'read' | 'write' | 'bash' | 'search' | 'other';

function getToolCategory(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file') return 'read';
  if (
    lower === 'write' || lower === 'edit' || lower === 'writefile' ||
    lower === 'write_file' || lower === 'create_file' || lower === 'createfile' ||
    lower === 'notebookedit' || lower === 'notebook_edit'
  ) return 'write';
  if (
    lower === 'bash' || lower === 'execute' || lower === 'run' ||
    lower === 'shell' || lower === 'execute_command'
  ) return 'bash';
  if (
    lower === 'search' || lower === 'glob' || lower === 'grep' ||
    lower === 'find_files' || lower === 'search_files' ||
    lower === 'websearch' || lower === 'web_search'
  ) return 'search';
  return 'other';
}

function getToolIcon(category: ToolCategory): IconSvgElement {
  switch (category) {
    case 'read':   return File01Icon;
    case 'write':  return FileEditIcon;
    case 'bash':   return CommandLineIcon;
    case 'search': return Search01Icon;
    case 'other':  return Wrench01Icon;
  }
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function extractFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getToolSummary(name: string, input: unknown, category: ToolCategory): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return name;

  switch (category) {
    case 'read':
    case 'write': {
      const path = (inp.file_path || inp.path || inp.filePath || '') as string;
      return path ? extractFilename(path) : name;
    }
    case 'bash': {
      const cmd = (inp.command || inp.cmd || '') as string;
      if (cmd) return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
      return name;
    }
    case 'search': {
      const pattern = (inp.pattern || inp.query || inp.glob || '') as string;
      return pattern ? `"${pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern}"` : name;
    }
    default:
      return name;
  }
}

function getFilePath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return '';
  return (inp.file_path || inp.path || inp.filePath || '') as string;
}

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return '...' + path.slice(path.length - maxLen + 3);
}

// ---------------------------------------------------------------------------
// Status indicator — running: gray, completed: green, error: red
// ---------------------------------------------------------------------------

type ToolStatus = 'running' | 'success' | 'error';

function getStatus(tool: ToolAction): ToolStatus {
  if (tool.result === undefined) return 'running';
  return tool.isError ? 'error' : 'success';
}

function StatusDot({ status }: { status: ToolStatus }) {
  switch (status) {
    case 'running':
      return (
        <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/50" />
      );
    case 'success':
      return <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-3.5 w-3.5 shrink-0 text-green-500" />;
    case 'error':
      return <HugeiconsIcon icon={CancelCircleIcon} className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
}

// ---------------------------------------------------------------------------
// Compact row for a single tool action
// ---------------------------------------------------------------------------

function ToolActionRow({ tool }: { tool: ToolAction }) {
  const category = getToolCategory(tool.name);
  const icon = getToolIcon(category);
  const summary = getToolSummary(tool.name, tool.input, category);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool);

  const label = category === 'bash' ? '' : tool.name;

  return (
    <div className="flex items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors">
      <HugeiconsIcon icon={icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

      {label && (
        <span className="font-medium text-muted-foreground shrink-0">{label}</span>
      )}

      <span className="font-mono text-muted-foreground/60 truncate flex-1">
        {summary}
      </span>

      {filePath && (category === 'read' || category === 'write') && (
        <span className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[200px] hidden sm:inline">
          {truncatePath(filePath)}
        </span>
      )}

      <StatusDot status={status} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header summary helper — build running task description
// ---------------------------------------------------------------------------

function getRunningDescription(tools: ToolAction[]): string {
  const running = tools.filter((t) => t.result === undefined);
  if (running.length === 0) return '';
  const last = running[running.length - 1];
  const category = getToolCategory(last.name);
  return getToolSummary(last.name, last.input, category);
}

// ---------------------------------------------------------------------------
// Main group component
// ---------------------------------------------------------------------------

export function ToolActionsGroup({
  tools,
  isStreaming = false,
  streamingToolOutput: _streamingToolOutput,
}: ToolActionsGroupProps) {
  const hasRunningTool = tools.some((t) => t.result === undefined);

  // Track whether user has manually toggled and their chosen state
  const [userExpandedState, setUserExpandedState] = useState<boolean | null>(null);

  // Derived: if user has toggled, use their choice; otherwise auto-expand based on streaming state
  const expanded = userExpandedState !== null ? userExpandedState : (hasRunningTool || isStreaming);

  if (tools.length === 0) return null;

  const runningCount = tools.filter((t) => t.result === undefined).length;
  const doneCount = tools.length - runningCount;
  const runningDesc = getRunningDescription(tools);

  const handleToggle = () => {
    setUserExpandedState((prev) => prev !== null ? !prev : !expanded);
  };

  // Build summary text parts
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (doneCount > 0) summaryParts.push(`${doneCount} completed`);
  if (runningCount === 0 && isStreaming) summaryParts.push('generating response');
  if (summaryParts.length === 0) summaryParts.push(`${tools.length} actions`);

  return (
    <div className="w-[min(100%,48rem)]">
      {/* Header — minimal: chevron + count + gray summary */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-1 text-xs rounded-sm hover:bg-muted/30 transition-colors"
      >
        <ChevronRightIcon
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            expanded && "rotate-90"
          )}
        />

        <span className="inline-flex items-center justify-center rounded bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground/70 tabular-nums">
          {tools.length}
        </span>

        <span className="text-muted-foreground/60 truncate">
          {summaryParts.join(' · ')}
        </span>

        {/* Show running task description on the right */}
        {runningDesc && (
          <span className="ml-auto text-muted-foreground/40 text-[11px] font-mono truncate max-w-[40%]">
            {runningDesc}
          </span>
        )}
      </button>

      {/* Expanded list — left vertical line like blockquote */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden', transformOrigin: 'top' }}
          >
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
            >
              <div className="ml-1.5 mt-0.5 border-l-2 border-border/50 pl-2">
                {tools.map((tool, i) => (
                  <ToolActionRow key={tool.id || `tool-${i}`} tool={tool} />
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
