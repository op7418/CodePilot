import { type ReactElement, forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface IconActionProps extends Omit<ComponentPropsWithoutRef<typeof Button>, "variant" | "size" | "children"> {
  icon: ReactElement;
  tooltip?: string;
  size?: "sm" | "md";
}

export const IconAction = forwardRef<HTMLButtonElement, IconActionProps>(
  function IconAction({ icon, tooltip, size = "md", className, ...props }, ref) {
    const button = (
      <Button
        ref={ref}
        variant="ghost"
        size="icon"
        className={cn(
          size === "sm" ? "h-7 w-7" : "h-8 w-8",
          className
        )}
        {...props}
      >
        {icon}
      </Button>
    );

    if (tooltip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      );
    }

    return button;
  }
);
