# components/

Design-system primitives for the ProsHarness dashboard, built on top of the
shadcn/ui base in `components/ui/`. Later stages restyling individual pages
should reach for these first instead of ad hoc markup.

Theme tokens (colours, elevation, status colours, type scale) live in
`app/globals.css` and `tailwind.config.ts` -- see those files for the
palette and naming.

## `components/ui/*` -- shadcn/ui base

Standard shadcn/ui components (Radix primitives + `cva` variants), themed
to the dashboard's dark palette via the CSS custom properties in
`globals.css`. Installed: `button`, `badge`, `card`, `separator`, `tabs`,
`dialog`, `dropdown-menu`, `tooltip`, `scroll-area`, `collapsible`,
`textarea`, `input`, `label`, `sheet`, `command`, `avatar`, `skeleton`.
Use these directly for anything generic (buttons, inputs, dialogs, a
future ⌘K command palette via `command.tsx`, etc). Import from
`@/components/ui/<name>`.

## `Surface` / `Panel` (`components/Surface.tsx`)

The shared "paper" panel wrapper. Bakes in a hairline low-opacity border, a
soft shadow + inset top highlight, and (by default) a static SVG grain
texture, so panels read as material rather than flat divs.

```tsx
import { Surface } from "@/components/Surface";

<Surface elevation="raised" className="p-6">
  ...
</Surface>;
```

Props:
- `elevation?: "base" | "raised" | "overlay"` -- default `"raised"`.
  `"base"` for full-bleed section backgrounds, `"raised"` for the default
  card/panel level (most content), `"overlay"` for popovers/dialogs/sheets
  (shadcn's `dialog`/`sheet`/`dropdown-menu`/`tooltip` already use the
  `surface-overlay` token directly).
- `grain?: boolean` -- default `true`. Set `false` to omit the noise
  texture (e.g. on very small chips where it'd be imperceptible anyway).
- `as?: React.ElementType` -- render as a different element, default `"div"`.
- Anything else is forwarded to the underlying element (`className`,
  `onClick`, etc). `Panel` is an alias of the same component.

## `StatusPill` (`components/StatusPill.tsx`)

Colour-coded status/severity badge for the pipeline's recurring states.

```tsx
import { StatusPill } from "@/components/StatusPill";

<StatusPill status="running" />
<StatusPill status={outcome === "pass" ? "pass" : "fail"} label="Review" />
```

Props:
- `status: "parked" | "running" | "done" | "idle" | "pass" | "fail" | "blocked"`
  -- selects the colour (from the `--status-*` tokens in `globals.css`).
- `label?: string` -- text to render; defaults to the status name.
- `dot?: boolean` -- show a small coloured dot before the label, default `true`.

## `SectionHeading` (`components/SectionHeading.tsx`)

Consistent page/section header: title (+ optional description) on the
left, an optional right-aligned action slot.

```tsx
import { SectionHeading } from "@/components/SectionHeading";

<SectionHeading
  title="Runs"
  description="All pipeline runs, most recent first."
  action={<Button>New run</Button>}
/>;
```

Props:
- `title: React.ReactNode` (required).
- `description?: React.ReactNode`.
- `action?: React.ReactNode` -- rendered right-aligned, e.g. a button or
  filter control.
- `as?: "h1" | "h2" | "h3"` -- controls both the rendered heading element
  and its size; default `"h2"`.

## `EmptyState` (`components/EmptyState.tsx`)

Centered placeholder for empty lists/tables/panels.

```tsx
import { EmptyState } from "@/components/EmptyState";
import { Inbox } from "lucide-react";

<EmptyState
  icon={<Inbox className="h-8 w-8" />}
  title="No runs yet"
  description="Kick off a run from the CLI to see it here."
  action={<Button variant="outline">Refresh</Button>}
/>;
```

Props: `icon?`, `title` (required), `description?`, `action?` -- all
`React.ReactNode`.

## `ListRow` (`components/ListRow.tsx`)

Dense, hoverable row primitive for lists of runs/sessions/checkpoints.
Three slots: leading (icon/status), title + subtitle (grows, truncates),
trailing meta.

```tsx
import { ListRow } from "@/components/ListRow";
import { StatusPill } from "@/components/StatusPill";
import Link from "next/link";

<Link href={`/runs/${run.id}`} className="block">
  <ListRow
    leading={<StatusPill status="running" dot label="" />}
    title={run.id}
    subtitle={`started ${run.startedAgo}`}
    meta={`${run.checkpointCount} checkpoints`}
  />
</Link>;
```

Props: `leading?`, `title` (required), `subtitle?`, `meta?` -- all
`React.ReactNode`; `interactive?: boolean` (default `true`) adds a pointer
cursor + hover border/background, set `false` for non-clickable rows.
`ListRow` does not render a link itself -- wrap it in Next's `<Link>` (or
an `onClick` handler) for navigation.

## `PlanMarkdown` (`components/PlanMarkdown.tsx`)

Renders a plan markdown document (headings, lists, tables, blockquotes,
code, GFM strikethrough/tables) using the `.prose-plan` typography
utility in `globals.css` (comfortable ~72ch measure, 1.75 line-height,
styled heading hierarchy). Use this instead of dumping raw markdown into a
`<pre>` tag.

```tsx
import { PlanMarkdown } from "@/components/PlanMarkdown";

<PlanMarkdown>{planMarkdownSource}</PlanMarkdown>;
```

Props: `children: string` (the raw markdown source), `className?: string`.

## `SilkBackground` (`components/SilkBackground.tsx`)

The ambient WebGL shader background. Mounted once in `app/layout.tsx` as
the first child of `<body>` -- later stages should not need to touch this
directly. Fixed, `z-index: 0`, `pointer-events: none`; page content sits on
opaque panels above it. Pauses on tab-hidden, renders a single static frame
under `prefers-reduced-motion: reduce`, and falls back to a static CSS
gradient if WebGL is unavailable.

## `Alert` (`components/Alert.tsx`)

Warning/error banner, replacing the old `.warning-banner`/`.error-banner`
classes (now removed). Used for genuine safety signals -- unhealthy run
journals, error query params -- that must stay visually loud, not buried.

```tsx
import { Alert } from "@/components/Alert";

<Alert variant="error">Could not compute the risk-ranked diff: {message}</Alert>;
```

Props: `variant: "warning" | "error"`, `children: React.ReactNode`.

## `board/BoardCard`, `board/BoardClient` (`components/board/`)

The home-page sessions board's card + horizontally-scrolling, roving-tabindex
column container. Stage is derived, not draggable -- see
`lib/board-data.ts`'s file comment for the full lifecycle-stage priority
order and why drag-and-drop would be misleading here (there is no "move
this card" backend; the column is a read-out of real journal state).

## No legacy classes remain

Every page has been migrated onto the primitives above; the old
inline-`<style>` shim (`nav`/`main`/`table`/`.badge`/`.warning-banner`/
`.error-banner`/`pre.plan-markdown`) has been removed from `app/globals.css`
entirely -- notably, its bare `main { max-width: 1000px; margin: 0 auto; }`
rule was silently capping the real app-shell `<main>` (`app/layout.tsx`)
until it was found and deleted during the coherence pass. New code should
never reintroduce bare-tag global selectors like that; keep styling scoped
to Tailwind utility classes or the primitives above.
