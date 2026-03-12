import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FieldRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  separator?: boolean;
  className?: string;
}

export function FieldRow({ label, description, children, separator, className }: FieldRowProps) {
  return (
    <div className={cn(
      "flex items-center justify-between gap-4",
      separator && "border-t border-border/30 pt-4",
      className
    )}>
      <div className="space-y-0.5 flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
