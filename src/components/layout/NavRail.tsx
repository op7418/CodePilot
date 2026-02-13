"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Message02Icon,
  PlusSignIcon,
  GridIcon,
  Settings02Icon,
  Moon02Icon,
  Sun02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavRailProps {
  chatListOpen: boolean;
  onToggleChatList: () => void;
  hasUpdate?: boolean;
  skipPermissionsActive?: boolean;
}

const navItems = [
  { href: "/chat", label: "Chats", icon: Message02Icon },
  { href: "/extensions", label: "Extensions", icon: GridIcon },
  { href: "/settings", label: "Settings", icon: Settings02Icon },
] as const;

export function NavRail({ chatListOpen, onToggleChatList, hasUpdate, skipPermissionsActive }: NavRailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const emptySubscribe = useCallback(() => () => {}, []);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const isChatRoute = pathname === "/chat" || pathname.startsWith("/chat/");

  return (
    <aside className="flex w-14 shrink-0 flex-col items-center bg-sidebar pb-3 pt-10">
      {/* New Chat */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="mb-2 h-9 w-9"
          >
            <Link href="/chat">
              <HugeiconsIcon icon={PlusSignIcon} className="h-4 w-4" />
              <span className="sr-only">New Chat</span>
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">New Chat</TooltipContent>
      </Tooltip>

      {/* Divider */}
      <div className="mx-auto mb-2 h-px w-6 bg-border/50" />

      {/* Nav icons */}
      <nav className="flex flex-1 flex-col items-center gap-1">
        {navItems.map((item) => {
          const isActive =
            item.href === "/chat"
              ? pathname === "/chat" || pathname.startsWith("/chat/")
              : item.href === "/extensions"
                ? pathname.startsWith("/extensions")
                : pathname === item.href || pathname.startsWith(item.href + "?");

          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>
                {item.href === "/chat" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-9 w-9",
                      isActive && "bg-sidebar-accent text-sidebar-accent-foreground"
                    )}
                    onClick={() => {
                      if (!isChatRoute) {
                        // Navigate to chat page first, then open chat list
                        router.push("/chat");
                        onToggleChatList();
                      } else {
                        onToggleChatList();
                      }
                    }}
                  >
                    <HugeiconsIcon icon={item.icon} className="h-4 w-4" />
                    <span className="sr-only">{item.label}</span>
                  </Button>
                ) : (
                  <div className="relative">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-9 w-9",
                        isActive && "bg-sidebar-accent text-sidebar-accent-foreground"
                      )}
                    >
                      <Link href={item.href}>
                        <HugeiconsIcon icon={item.icon} className="h-4 w-4" />
                        <span className="sr-only">{item.label}</span>
                      </Link>
                    </Button>
                    {item.href === "/settings" && hasUpdate && (
                      <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-blue-500" />
                    )}
                  </div>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {/* Bottom: skip-permissions indicator + theme toggle */}
      <div className="mt-auto flex flex-col items-center gap-2">
        {skipPermissionsActive && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex h-8 w-8 items-center justify-center">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-orange-500" />
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">Auto-approve is ON</TooltipContent>
          </Tooltip>
        )}
        {mounted && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="h-8 w-8"
              >
                {theme === "dark" ? (
                  <HugeiconsIcon icon={Sun02Icon} className="h-4 w-4" />
                ) : (
                  <HugeiconsIcon icon={Moon02Icon} className="h-4 w-4" />
                )}
                <span className="sr-only">Toggle theme</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </aside>
  );
}
