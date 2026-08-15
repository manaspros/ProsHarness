"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Calendar,
  ChevronsLeft,
  ChevronsRight,
  Command as CommandIcon,
  ListTree,
  Plus,
  Repeat,
  Rows3,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ListRow } from "@/components/ListRow";
import { StatusPill, type Status } from "@/components/StatusPill";

const COLLAPSE_STORAGE_KEY = "pros:sidebar-collapsed";

export interface SidebarRecentRun {
  runId: string;
  /** Already mapped down to StatusPill's Status union. */
  status: Status;
  statusLabel: string;
}

export interface SidebarCounts {
  parked: number;
  running: number;
  done: number;
  idle: number;
}

const NAV_ITEMS = [
  { href: "/", label: "Sessions", icon: Rows3 },
  { href: "/runs", label: "Runs", icon: ListTree },
  { href: "/loops", label: "Loops", icon: Repeat },
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/skills", label: "Skills", icon: Wrench },
] as const;

const NAV_GROUPS = [
  { label: "Workspace", items: NAV_ITEMS.slice(0, 2) },
  { label: "Signals", items: NAV_ITEMS.slice(2) },
] as const;

export function SidebarShell({
  recentRuns,
  counts,
}: {
  recentRuns: SidebarRecentRun[];
  counts: SidebarCounts;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const pathname = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (stored === "1") setCollapsed(true);
    setHydrated(true);
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const runPaletteAction = React.useCallback(
    (href: string) => {
      setPaletteOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <>
      <aside
        className={cn(
          "sticky top-0 z-10 flex h-screen shrink-0 flex-col border-r border-white/[0.07] bg-surface-ground/95 transition-[width] duration-150 ease-out",
          collapsed ? "w-[64px]" : "w-[264px]",
          // Avoid a jarring transition before we've read localStorage.
          !hydrated && "transition-none",
        )}
        data-testid="app-sidebar"
        data-collapsed={collapsed}
      >
        {/* Header: brand + collapse toggle + command palette trigger */}
        <div className="flex items-center gap-2 px-3 py-3.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-primary/30 bg-primary/15 text-[11px] font-bold tracking-tight text-primary">
            p/
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-1 flex-col truncate">
              <span className="truncate text-sm font-semibold tracking-tight text-foreground">pros</span>
              <span className="truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground">operator workspace</span>
            </span>
          )}
          {!collapsed && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 border-white/[0.08] px-2 text-[11px] text-muted-foreground"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <CommandIcon className="h-3.5 w-3.5" />
              K
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" />
            ) : (
              <ChevronsLeft className="h-4 w-4" />
            )}
          </Button>
        </div>

        {collapsed && (
          <div className="flex justify-center px-2 pb-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <CommandIcon className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* Primary "new session" action */}
        <div className="px-3 pb-4">
          <Button asChild className={cn("w-full gap-2 shadow-none", collapsed && "px-0")}>
            <Link href="/new" aria-label="New session">
              <Plus className="h-4 w-4 shrink-0" />
              {!collapsed && <span>New session</span>}
            </Link>
          </Button>
        </div>

        {/* Nav links */}
        <nav className="flex flex-col gap-4 px-2" aria-label="Primary">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              {!collapsed && (
                <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                  {group.label}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href || pathname?.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "border-border/40 bg-accent text-accent-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                        collapsed && "justify-center px-0",
                      )}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="my-4 border-t border-white/[0.07]" />

        {/* Recent sessions -- short, scrollable */}
        {!collapsed && (
          <div className="flex min-h-0 flex-1 flex-col px-2">
            <div className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              Recent sessions
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-0.5 pb-2 pr-2">
                {recentRuns.length === 0 && (
                  <p className="px-1.5 py-2 text-xs text-muted-foreground">
                    No runs yet.
                  </p>
                )}
                {recentRuns.map((run) => (
                  <Link key={run.runId} href={`/runs/${encodeURIComponent(run.runId)}`}>
                    <ListRow
                      className="px-1.5 py-1.5"
                      leading={<StatusPill status={run.status} dot label="" />}
                      title={run.runId}
                      meta={undefined}
                    />
                  </Link>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
        {collapsed && <div className="flex-1" />}

        {/* Status summary footer */}
        <div className="border-t border-border px-3 py-3">
          {collapsed ? (
            <div className="flex flex-col items-center gap-1 text-[10px] text-muted-foreground">
              <span>{counts.running + counts.parked + counts.done + counts.idle}</span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-status-parked" />
                {counts.parked} parked
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-status-running" />
                {counts.running} running
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-status-done" />
                {counts.done} done
              </span>
            </div>
          )}
        </div>
      </aside>

      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <CommandInput placeholder="Jump to..." />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Navigate">
            <CommandItem onSelect={() => runPaletteAction("/new")}>
              New session
            </CommandItem>
            <CommandItem onSelect={() => runPaletteAction("/runs")}>
              Runs
            </CommandItem>
            <CommandItem onSelect={() => runPaletteAction("/loops")}>
              Loops
            </CommandItem>
            <CommandItem onSelect={() => runPaletteAction("/schedule")}>
              Schedule
            </CommandItem>
            <CommandItem onSelect={() => runPaletteAction("/skills")}>
              Skills
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
