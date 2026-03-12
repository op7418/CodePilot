import { type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const variantStyles = {
  success: "bg-status-success-muted text-status-success-foreground",
  warning: "bg-status-warning-muted text-status-warning-foreground",
  error: "bg-status-error-muted text-status-error-foreground",
  info: "bg-status-info-muted text-status-info-foreground",
} as const;

interface StatusBannerProps {
  variant: "success" | "warning" | "error" | "info";
  icon?: ReactElement;
  children: ReactNode;
  className?: string;
}

export function StatusBanner({ variant, icon, children, className }: StatusBannerProps) {
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md px-3 py-2 text-xs",
      variantStyles[variant],
      className
    )}>
      {icon && <div className="flex-shrink-0">{icon}</div>}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
