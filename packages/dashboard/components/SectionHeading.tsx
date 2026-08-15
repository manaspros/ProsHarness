import * as React from "react";

import { cn } from "@/lib/utils";

export interface SectionHeadingProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned slot, e.g. a primary action button or filter control. */
  action?: React.ReactNode;
  /** Heading element to render `title` in. Default "h2". */
  as?: "h1" | "h2" | "h3";
}

/**
 * SectionHeading -- consistent page/section header: title + optional
 * description on the left, an optional action slot pinned to the right.
 *
 * Usage:
 *   <SectionHeading
 *     title="Runs"
 *     description="All pipeline runs, most recent first."
 *     action={<Button>New run</Button>}
 *   />
 */
export function SectionHeading({
  title,
  description,
  action,
  as = "h2",
  className,
  ...props
}: SectionHeadingProps) {
  const Heading = as;
  const titleClass =
    as === "h1" ? "text-2xl" : as === "h3" ? "text-lg" : "text-xl";

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-border pb-4",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <Heading
          className={cn(
            titleClass,
            "font-semibold leading-tight tracking-tight text-foreground",
          )}
        >
          {title}
        </Heading>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
