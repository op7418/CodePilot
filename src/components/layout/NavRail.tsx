"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChatCircle,
  Lightning,
  Plug,
  Image,
  Gear,
  WifiHigh,
  Terminal,
} from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";


interface NavRailProps {
  chatListOpen: boolean;
  onToggleChatList: () => void;
  hasUpdate?: boolean;
  readyToInstall?: boolean;
  skipPermissionsActive?: boolean;
}

const navItems = [
  { href: "/chat", label: "Chats", icon: ChatCircle },
  { href: "/skills", label: "Skills", icon: Lightning },
  { href: "/mcp", label: "MCP", icon: Plug },
  { href: "/cli-tools", label: "CLI Tools", icon: Terminal },
  { href: "/gallery", label: "Gallery", icon: Image },
  { href: "/bridge", label: "Bridge", icon: WifiHigh },
] as const;

export function NavRail({ onToggleChatList, hasUpdate, readyToInstall, skipPermissionsActive }: NavRailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation();
  const navLabelKeys: Record<string, TranslationKey> = {
    'Chats': 'nav.chats',
    'Skills': 'extensions.skills',
    'MCP': 'extensions.mcpServers',
    'Gallery': 'gallery.title',
    'Bridge': 'nav.bridge',
    'CLI Tools': 'nav.cliTools',
  };
  const isChatRoute = pathname === "/chat" || pathname.startsWith("/chat/");
  const isSettingsActive = pathname === "/settings" || pathname.startsWith("/settings/");

  return (
    <aside className="flex w-14 shrink-0 flex-col items-center bg-sidebar/80 backdrop-blur-xl pb-3 pt-10">
      {/* Nav icons */}
      <nav className="flex flex-1 flex-col items-center gap-1">
        {navItems.map((item) => {
          const isActive =
            item.href === "/chat"
              ? pathname === "/chat" || pathname.startsWith("/chat/")
              : pathname === item.href || pathname.startsWith(item.href + "/") || pathname.startsWith(item.href + "?");

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
                    <item.icon size={16} weight={isActive ? "fill" : "regular"} />
                    <span className="sr-only">{t(navLabelKeys[item.label] ?? item.label as TranslationKey)}</span>
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
                        <item.icon size={16} weight={isActive ? "fill" : "regular"} />
                        <span className="sr-only">{t(navLabelKeys[item.label] ?? item.label as TranslationKey)}</span>
                      </Link>
                    </Button>
                  </div>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">{t(navLabelKeys[item.label] ?? item.label as TranslationKey)}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {/* Bottom: skip-permissions indicator + settings */}
      <div className="mt-auto flex flex-col items-center gap-2">
        {skipPermissionsActive && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex h-8 w-8 items-center justify-center">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-warning opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-status-warning" />
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">{t('nav.autoApproveOn')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="relative">
              <Button
                asChild
                variant="ghost"
                size="icon"
                className={cn(
                  "h-9 w-9",
                  isSettingsActive && "bg-sidebar-accent text-sidebar-accent-foreground"
                )}
              >
                <Link href="/settings">
                  <Gear size={16} weight={isSettingsActive ? "fill" : "regular"} />
                  <span className="sr-only">{t('nav.settings')}</span>
                </Link>
              </Button>
              {hasUpdate && (
                <span className={cn(
                  "absolute top-0.5 right-0.5 h-2 w-2 rounded-full",
                  readyToInstall ? "bg-status-success animate-pulse" : "bg-primary"
                )} />
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">{t('nav.settings')}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
