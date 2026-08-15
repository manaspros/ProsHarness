import * as React from "react";

import { cn } from "@/lib/utils";

const elevationClasses = {
  base: "bg-surface-base shadow-none",
  raised: "bg-surface-raised shadow-panel-raised",
  overlay: "bg-surface-overlay shadow-panel-overlay",
} as const;

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Elevation level, from the page ground up:
   *  - "base": lightly-lifted background fill (e.g. a full-bleed section)
   *  - "raised": the default panel/card level -- most content lives here
   *  - "overlay": popovers/dialogs/sheets, the lightest, topmost level
   */
  elevation?: keyof typeof elevationClasses;
  /** Render the subtle paper-grain noise texture on this surface. Default true. */
  grain?: boolean;
  as?: React.ElementType;
}

/**
 * Surface/Panel -- the shared "paper" wrapper for every card-like block in
 * the dashboard. Bakes in:
 *  - one of three elevation levels (see `elevation`)
 *  - a hairline 1px low-opacity border
 *  - a soft drop shadow plus an inset top highlight (via the
 *    shadow-panel-raised/overlay Tailwind shadows) to read as material
 *    rather than a flat div
 *  - an optional static SVG grain texture (`.paper-grain`, ~3.5% opacity)
 *
 * Usage:
 *   <Surface elevation="raised" className="p-6">...</Surface>
 *   <Surface elevation="overlay" grain={false}>...</Surface>
 */
export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(
  (
    { className, elevation = "raised", grain = true, as: Comp = "div", ...props },
    ref,
  ) => {
    return (
      <Comp
        ref={ref}
        className={cn(
          "relative rounded-lg border border-border",
          elevationClasses[elevation],
          grain && "paper-grain",
          className,
        )}
        {...props}
      />
    );
  },
);
Surface.displayName = "Surface";

export const Panel = Surface;
