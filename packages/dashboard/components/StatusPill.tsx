import * as React from "react";

import { cn } from "@/lib/utils";

export type Status =
  | "parked"
  | "running"
  | "done"
  | "idle"
  | "pass"
  | "fail"
  | "blocked";

const statusClasses: Record<Status, string> = {
  parked: "bg-status-parked/15 text-status-parked",
  running: "bg-status-running/15 text-status-running",
  done: "bg-status-done/15 text-status-done",
  idle: "bg-status-idle/15 text-status-idle",
  pass: "bg-status-pass/15 text-status-pass",
  fail: "bg-status-fail/15 text-status-fail",
  blocked: "bg-status-blocked/15 text-status-blocked",
};

const statusDotClasses: Record<Status, string> = {
  parked: "bg-status-parked",
  running: "bg-status-running",
  done: "bg-status-done",
  idle: "bg-status-idle",
  pass: "bg-status-pass",
  fail: "bg-status-fail",
  blocked: "bg-status-blocked",
};

export interface StatusPillProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  status: Status;
  /** Text to render. Defaults to the status name, e.g. "running". */
  label?: string;
  /** Show a small coloured dot before the label. Default true. */
  dot?: boolean;
}

/**
 * StatusPill -- consistent colour-coded status/severity badge.
 *
 * Maps the pipeline's recurring run/checkpoint/review states (parked,
 * running, done, idle, pass, fail, blocked) to a fixed colour per state,
 * drawn from the theme's --status-* tokens (app/globals.css) rather than
 * ad hoc colours per page.
 *
 * Usage:
 *   <StatusPill status="running" />
 *   <StatusPill status={outcome === "pass" ? "pass" : "fail"} label="Review" />
 */
export function StatusPill({
  status,
  label,
  dot = true,
  className,
  ...props
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        statusClasses[status],
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", statusDotClasses[status])}
        />
      )}
      {label ?? status}
    </span>
  );
}
