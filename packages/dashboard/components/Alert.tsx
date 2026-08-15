import * as React from "react";
import { AlertOctagon, AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** "warning" for a cautionary/needs-attention signal, "error" for a hard failure. Default "warning". */
  variant?: "warning" | "error";
  title?: React.ReactNode;
}

/**
 * Alert -- prominent inline banner for warning/error signals (e.g. an
 * unhealthy run, an unresolved blocker, a failed compute). Replaces the
 * legacy `.warning-banner` / `.error-banner` classes with a themed
 * component: an icon + optional title, colour-coded via the `--status-*`
 * tokens, deliberately loud (this is meant to never look accidentally
 * healthy).
 *
 * Usage:
 *   <Alert variant="warning" title="Unresolved blocker(s)">...</Alert>
 *   <Alert variant="error">Could not compute the diff: {message}</Alert>
 */
export function Alert({ variant = "warning", title, className, children, ...props }: AlertProps) {
  const Icon = variant === "error" ? AlertOctagon : AlertTriangle;
  const colorClass = variant === "error" ? "border-status-fail/30 bg-status-fail/10" : "border-status-parked/30 bg-status-parked/10";
  const iconClass = variant === "error" ? "text-status-fail" : "text-status-parked";

  return (
    <div className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", colorClass, className)} {...props}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1 space-y-1.5 text-foreground/90">
        {title && <div className={cn("font-semibold", iconClass)}>{title}</div>}
        {children}
      </div>
    </div>
  );
}
