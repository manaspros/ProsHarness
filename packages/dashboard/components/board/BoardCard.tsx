import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Radio } from "lucide-react";

import { cn } from "@/lib/utils";
import { Surface } from "@/components/Surface";
import { StatusPill, type Status } from "@/components/StatusPill";
import type { LivenessLabel } from "@/lib/run-status";

export interface BoardCardData {
  runId: string;
  href: string;
  pillStatus: Status;
  pillLabel: string;
  healthy: boolean;
  healthIssueCount: number;
  unresolvedObjectionCount: number;
  hasMajorUnresolvedObjection: boolean;
  relativeTime: string | undefined;
  fenceEpoch: number;
  /** B9: "active" | "stale" | "n/a" -- see lib/run-status.ts's deriveLiveness. Only meaningful while a run has a live attempt; "n/a" for every other stage (no live attempt to be stale). */
  liveness: LivenessLabel;
}

/**
 * One run card on the home-page board. Plain <a> (via next/link) so the
 * board's roving-tabindex keyboard nav (BoardClient) gets Enter-to-open for
 * free from native anchor semantics -- no separate keydown handling needed
 * for activation, only for arrow-key focus movement between cards.
 */
export const BoardCard = React.forwardRef<HTMLAnchorElement, { data: BoardCardData; colIndex: number; rowIndex: number; tabIndex: number }>(
  ({ data, colIndex, rowIndex, tabIndex }, ref) => {
    const risky = !data.healthy || data.hasMajorUnresolvedObjection;
    return (
      <Link
        ref={ref}
        href={data.href}
        data-board-card
        data-col={colIndex}
        data-row={rowIndex}
        tabIndex={tabIndex}
        className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Surface
          elevation="raised"
          className={cn(
            "border-l-4 p-3 transition-colors hover:bg-white/[0.03]",
            risky ? "border-l-status-fail" : "border-l-transparent",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-foreground" title={data.runId}>
              {data.runId}
            </span>
            {!data.healthy && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-status-fail"
                aria-label={`${data.healthIssueCount} health issue(s)`}
              >
                <title>{`${data.healthIssueCount} journal health issue(s)`}</title>
              </AlertTriangle>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusPill status={data.pillStatus} label={data.pillLabel} />
            {data.liveness === "stale" && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-status-fail/15 px-2 py-0.5 text-[11px] font-semibold text-status-fail"
                title="No new output written to this run's log in a while -- it may be wedged on a tool call rather than actually running."
              >
                <Radio className="h-3 w-3" />
                possibly wedged
              </span>
            )}
            {data.unresolvedObjectionCount > 0 && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  data.hasMajorUnresolvedObjection
                    ? "bg-status-fail/15 text-status-fail"
                    : "bg-status-parked/15 text-status-parked",
                )}
                title={`${data.unresolvedObjectionCount} unresolved objection(s)${data.hasMajorUnresolvedObjection ? ", including a major one" : ""}`}
              >
                {data.unresolvedObjectionCount} objection{data.unresolvedObjectionCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>fence {data.fenceEpoch}</span>
            {data.relativeTime && <span>{data.relativeTime}</span>}
          </div>
        </Surface>
      </Link>
    );
  },
);
BoardCard.displayName = "BoardCard";
