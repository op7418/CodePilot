import { type ReactNode, type RefObject, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/* ------------------------------------------------------------------ */
/*  CommandList — shared popover/command-list pattern                  */
/*  Pure presentation; no data fetching or business logic.            */
/* ------------------------------------------------------------------ */

// ── Root container ──────────────────────────────────────────────────

interface CommandListProps {
  children: ReactNode;
  className?: string;
}

export function CommandList({ children, className }: CommandListProps) {
  return (
    <div
      className={cn(
        "absolute bottom-full left-0 mb-2 rounded-xl border bg-popover shadow-lg overflow-hidden z-50",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Search input ────────────────────────────────────────────────────

interface CommandListSearchProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function CommandListSearch({
  value,
  onChange,
  onKeyDown,
  placeholder = "Search...",
  inputRef,
}: CommandListSearchProps) {
  return (
    <div className="px-3 py-2 border-b">
      <Input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-auto w-full border-0 bg-transparent p-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground outline-none focus-visible:ring-0 focus-visible:border-transparent"
      />
    </div>
  );
}

// ── Scrollable items area ───────────────────────────────────────────

interface CommandListItemsProps {
  children: ReactNode;
  className?: string;
}

export function CommandListItems({ children, className }: CommandListItemsProps) {
  return (
    <div className={cn("max-h-64 overflow-y-auto py-1", className)}>
      {children}
    </div>
  );
}

// ── Single item ─────────────────────────────────────────────────────

interface CommandListItemProps {
  active?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
  children: ReactNode;
  className?: string;
  itemRef?: (el: HTMLButtonElement | null) => void;
}

export function CommandListItem({
  active,
  onClick,
  onMouseEnter,
  children,
  className,
  itemRef,
}: CommandListItemProps) {
  return (
    <Button
      type="button"
      ref={itemRef}
      variant="ghost"
      size="sm"
      className={cn(
        "flex w-full items-center justify-start gap-2 rounded-none px-3 py-1.5 text-left text-sm font-normal transition-colors h-auto",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        className,
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {children}
    </Button>
  );
}

// ── Group with optional label and separator ─────────────────────────

interface CommandListGroupProps {
  label?: string;
  separator?: boolean;
  children: ReactNode;
}

export function CommandListGroup({ label, separator, children }: CommandListGroupProps) {
  return (
    <div className={cn(separator && "border-t")}>
      {label && (
        <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Footer ──────────────────────────────────────────────────────────

interface CommandListFooterProps {
  children: ReactNode;
}

export function CommandListFooter({ children }: CommandListFooterProps) {
  return (
    <div className="border-t px-3 py-1.5">
      {children}
    </div>
  );
}

// ── Footer action button ────────────────────────────────────────────

interface CommandListFooterActionProps {
  onClick?: () => void;
  children: ReactNode;
}

export function CommandListFooterAction({ onClick, children }: CommandListFooterActionProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="flex w-full items-center justify-start gap-2 rounded-none px-0 py-1 text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-transparent h-auto transition-colors"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// ── Empty state ─────────────────────────────────────────────────────

interface CommandListEmptyProps {
  children: ReactNode;
}

export function CommandListEmpty({ children }: CommandListEmptyProps) {
  return (
    <div className="px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
