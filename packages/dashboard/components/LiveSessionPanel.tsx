"use client";

import * as React from "react";
import { CheckCircle2, CircleAlert, FileSearch, Loader2, Sparkles, TerminalSquare } from "lucide-react";
import { Surface } from "@/components/Surface";
import type { SessionActivityItem, SessionActivitySnapshot } from "@/lib/session-activity";

const ICONS = {
  claude: Sparkles,
  codex: FileSearch,
  done: CheckCircle2,
  error: CircleAlert,
  info: TerminalSquare,
  working: Loader2,
} as const;

function ActivityRow({ item, latest }: { item: SessionActivityItem; latest: boolean }) {
  const Icon = item.state === "error" ? ICONS.error : item.state === "done" ? ICONS.done : item.state === "working" ? ICONS.working : item.provider === "claude" ? ICONS.claude : ICONS.info;
  return (
    <li className={`flex gap-3 rounded-lg px-3 py-2.5 ${latest ? "bg-white/[0.05]" : ""}`}>
      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${item.state === "error" ? "bg-destructive/15 text-destructive" : item.state === "done" ? "bg-status-pass/15 text-status-pass" : "bg-status-running/15 text-status-running"}`}>
        <Icon className={`h-3.5 w-3.5 ${item.state === "working" ? "animate-spin" : ""}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{item.label}</span>
        {item.detail && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.detail}</span>}
      </span>
    </li>
  );
}

export function LiveSessionPanel({ runId, initial }: { runId: string; initial: SessionActivitySnapshot }) {
  const [snapshot, setSnapshot] = React.useState(initial);
  const active = snapshot.active;

  React.useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/activity`, { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as SessionActivitySnapshot;
        if (!disposed) setSnapshot(next);
      } catch {
        // The durable journal/raw log remains the source of truth; a missed
        // refresh should never turn the session page into an error state.
      }
    };
    void refresh();
    if (!active) return () => { disposed = true; };
    const timer = window.setInterval(refresh, 1200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, runId]);

  if (!snapshot.active && snapshot.activity.length === 0) return null;
  const recent = snapshot.activity.slice(-7);

  return (
    <Surface elevation="raised" grain={false} className="border-status-running/30 bg-status-running/[0.06] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-status-running/15 text-status-running">
          {active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Claude session</h2>
            {active && <span className="rounded-full bg-status-running/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-status-running">live</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{active ? snapshot.operationLabel ?? "Working in the repository" : "Latest session activity"}</p>
        </div>
      </div>
      {recent.length > 0 ? (
        <ol className="mt-3 space-y-0.5 border-t border-border/70 pt-2">
          {recent.map((item, index) => <ActivityRow key={item.id} item={item} latest={index === recent.length - 1} />)}
        </ol>
      ) : (
        <div className="mt-3 flex items-center gap-2 border-t border-border/70 pt-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Claude is starting the session…
        </div>
      )}
    </Surface>
  );
}
