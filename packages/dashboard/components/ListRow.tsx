import * as React from "react";

import { cn } from "@/lib/utils";

export interface ListRowProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Leading slot: a status dot, icon, or StatusPill. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Trailing slot: timestamp, count, chevron, etc. */
  meta?: React.ReactNode;
  /** Render as an anchor/link-like row (adds cursor-pointer + hover bg). */
  interactive?: boolean;
}

/**
 * ListRow -- dense, hoverable row primitive for lists of runs, sessions,
 * checkpoints, etc. Three slots: leading (icon/status), title+subtitle
 * (grows, truncates), and trailing meta.
 *
 * Usage:
 *   <ListRow
 *     leading={<StatusPill status="running" dot label="" />}
 *     title="run-2026-08-14-01"
 *     subtitle="started 2h ago"
 *     meta="3 checkpoints"
 *     interactive
 *   />
 * Wrap in a Next.js <Link> for navigation -- ListRow itself renders a div,
 * so it composes cleanly as a Link's child via `asChild`-style usage:
 *   <Link href={...} className="block"><ListRow ... /></Link>
 */
export const ListRow = React.forwardRef<HTMLDivElement, ListRowProps>(
  ({ leading, title, subtitle, meta, interactive = true, className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center gap-3 rounded-md border border-transparent px-3 py-2.5 transition-colors",
          interactive && "cursor-pointer hover:border-border hover:bg-white/[0.03]",
          className,
        )}
        {...props}
      >
        {leading && <div className="flex shrink-0 items-center">{leading}</div>}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {title}
          </div>
          {subtitle && (
            <div className="truncate text-xs text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
        {meta && (
          <div className="shrink-0 text-xs text-muted-foreground">{meta}</div>
        )}
      </div>
    );
  },
);
ListRow.displayName = "ListRow";
