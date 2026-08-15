# 14 - The dashboard design system

A visual and UX overhaul of `packages/dashboard`, replacing the original
"deliberately plain... an internal operator tool, not a product" inline
`<style>` block (light background, hand-rolled tables, no component
library -- see the old `app/layout.tsx`) with a dark, "paper"-textured
design system built on Tailwind + shadcn/ui, a Linear-style sessions board,
a real trigger/new-session front door, and a live WebGL shader backdrop.

Built by parallel subagents in stages (foundation first, then pages in
parallel, then a coherence pass), each stage verified by an actual build +
`pnpm -r test` + `pnpm -r typecheck` + real screenshots of the running app
against seeded demo data (`pnpm run seed:demo`) -- not just "it compiles."

## Visual language

**Colour.** Deep near-black grounds drawn from the shader's own palette so
the UI and the backdrop feel like one system: `#02010A` (deepest ground),
`#04052E`, `#3D2C8D`, `#916BBF` (the restrained accent, used sparingly --
primary actions, active nav, focus rings). These are wired as HSL custom
properties in `app/globals.css` under shadcn's standard token names
(`--background`, `--foreground`, `--card`, `--border`, `--ring`, etc), plus
a 4-level elevation ramp (`--surface-ground` / `--surface-base` /
`--surface-raised` / `--surface-overlay`) and a fixed set of status-colour
tokens (`--status-parked`/`-running`/`-done`/`-idle`/`-pass`/`-fail`) so
every page's status colouring comes from the same small palette.

**Type.** A real scale (Tailwind theme extension, `xs` through `3xl`, real
line-height pairings) for UI chrome, and a separate long-form reading
utility, `.prose-plan`, for plan markdown: ~72ch measure, 1.75 line-height,
a proper heading hierarchy, styled blockquotes/code/tables. Plan documents
render through `<PlanMarkdown>` (react-markdown + remark-gfm), not a raw
`<pre>` dump of markdown source.

**Elevation / "paper."** Panels use `Surface`/`Panel`
(`components/Surface.tsx`): a hairline low-opacity border, a soft shadow +
subtle inset top highlight (`inset 0 1px 0 rgba(255,255,255,.04)`-style),
and a static SVG `feTurbulence` grain texture at ~3.5% opacity -- static,
not animated, so it reads as material rather than a flat div without
costing a frame. Three elevation levels (`base`/`raised`/`overlay`) cover
full-bleed section backgrounds, the default card/panel level, and
popovers/dialogs/sheets respectively.

**Motion.** Deliberately restrained: shadcn's default Radix transitions for
dialogs/dropdowns/collapsibles, no page-level animation, the shader itself
is the only continuous motion in the UI and it sits behind opaque content.

## The Silk WebGL shader background

`components/SilkBackground.tsx`, mounted once in `app/layout.tsx` as the
first child of `<body>`, sibling to (not wrapping) the rest of the shell.

- Plain WebGL1 (`canvas.getContext("webgl")`), a fullscreen triangle, no
  libraries. The fragment shader is reproduced verbatim from the supplied
  spec (colour ramp `#02010A -> #04052E -> #3D2C8D -> #916BBF`, `u_scene`/
  `u_shape`/`u_surface`/`u_finish`/`u_transform`/`u_space`/`u_cursor`
  uniforms exactly as specified, cursor off).
- `devicePixelRatio` capped at 2; canvas is `position: fixed; inset: 0;
  z-index: 0; pointer-events: none`.
- The RAF loop pauses on `document.hidden` (Page Visibility API) and
  resumes on return.
- **Accessibility fallbacks**: under `prefers-reduced-motion: reduce`, it
  renders a single static frame instead of animating; if
  `getContext("webgl")` returns null, it falls back to a static CSS
  radial-gradient using the same four colours rather than crashing or
  blanking the page.
- **Legibility**: the shader is only ever visible in the gutters around the
  app shell. `app/layout.tsx` wraps all page content in an opaque
  `Surface elevation="base"` panel (`max-w-[1800px]`, generous padding) --
  the shader never sits directly behind text. This was a real bug caught
  during verification: a leftover legacy CSS rule (`main { max-width:
  1000px }`, from before the app shell existed) was silently capping the
  real shell's `<main>`, which also broke the sessions board's column
  width -- found via screenshot inspection at a wide viewport, fixed by
  deleting the entire dead legacy-class CSS block once every page had been
  migrated off it.

## Component inventory

Full prop-level docs live in `packages/dashboard/components/README.md` --
read that before building a new page. Summary:

| Primitive | Purpose |
|---|---|
| `components/ui/*` | shadcn/ui base (button, badge, card, separator, tabs, dialog, dropdown-menu, tooltip, scroll-area, collapsible, textarea, input, label, sheet, command, avatar, skeleton), themed to the dark palette. |
| `Surface` / `Panel` | The paper panel wrapper (elevation + grain + hairline border + inset highlight). |
| `StatusPill` | Colour-coded status/severity badge, one fixed palette (`parked`/`running`/`done`/`idle`/`pass`/`fail`/`blocked`) reused everywhere -- run status, board stage, review verdicts. |
| `SectionHeading` | Title + optional description + right-aligned action, for every page/section header. |
| `EmptyState` | Centered icon + title + description + optional CTA, used for every "nothing here yet" case across all 12 routes. |
| `ListRow` | Dense hoverable row (leading/title+subtitle/trailing meta) for run lists, sidebar recents, queued/running lists. |
| `PlanMarkdown` | Styled long-form markdown rendering for plan documents. |
| `Alert` | Warning/error banner for genuine safety signals (unhealthy journals, query-param errors). |
| `SilkBackground` | The shader backdrop, see above. |
| `SidebarShell` | The persistent collapsible left sidebar (nav, New session, recent sessions, status counts, ⌘K trigger) -- client component wrapping server-fetched data from `app/layout.tsx`. |
| `board/BoardCard`, `board/BoardClient` | The sessions board's card + horizontally-scrolling, roving-tabindex (arrow keys + Enter) column container. Deliberately not drag-and-drop -- stage is derived from real journal/event state (`lib/board-data.ts`), so a "move card to change stage" interaction would be decorative and misleading. |

## Information architecture

| Route | Answers |
|---|---|
| `/` (Sessions board) | "What's the state of everything, at a glance?" Linear-style Kanban, one card per run, columns = lifecycle stage (`finding -> planning -> awaiting_gate1 -> implementing -> verifying -> awaiting_gate2 -> shipped`, derived in `lib/board-data.ts`; the terminal column is honestly labelled "PR opened," never "Merged" -- this system never observes an actual merge, see that file's comment). Risk/attention signalled via card border colour and an objection-count badge. This is the app's home. |
| `/new` | "How do I start something?" The trigger front door: repo path, a finding description, a trigger-source selector (Manual/Sweep/Linear/Slack/Granola, each with an honest readiness note), a confirm-gated "Launch plan run" that calls the real `runPlanPipeline`, and a "queued and running" list. |
| `/runs/<id>/plan` | "What's being proposed, and should I approve it?" The Gate 1 surface -- three columns: the persistent sidebar, the plan document as readable prose with metadata chips, and a right rail of severity-tagged objection cards + a direct-run composer + Approve/Amend/Reject. |
| `/runs/<id>/review` | "What actually changed, and is it safe?" The Gate 2 surface -- risk-ranked diff hunks with a visual risk meter, and a focus checklist grouped by category. |
| `/runs/<id>/graph` | "What did the agent actually do?" A vertical timeline/diagram (per-attempt, per-kind icons), not a force-directed graph -- every node traces to a real `raw_events` row. |
| `/runs/<id>/questions` | Free-text `ask_human` checkpoints specifically (distinct from the Gate 1/Gate 2 surfaces above). |
| `/runs/<id>` | Run overview: manifest, attempts, checkpoints, health issues. |
| `/runs` | Flat list of every run, for scanning/searching outside the board's stage grouping. |
| `/loops`, `/schedule`, `/skills` | Informational pages (mined workflow/preference proposals, scheduled-job status, ranked skill proposals). Proposal application/install remains read-only; `/loops` and `/skills` also expose explicit local regeneration actions. |

`⌘K` opens a command palette (shadcn `Command`) for jumping to any nav
route or starting a new session without leaving the keyboard.

## Verification

Every stage: `pnpm --filter @pros/dashboard exec tsc --noEmit`, `next
build`, and (for `/loops`, `/schedule`, `/skills`) the static-inspection
tests confirming proposal application/install remains non-mutating. At integration: full `pnpm -r
test` (all 19 packages, 73 passing in `@pros/dashboard` alone, up from 63
before this pass) and `pnpm -r typecheck` (18 of 19 packages clean; the
pre-existing `@pros/notify` gap from concurrent, unrelated credential work
is untouched, per the brief). Every route was screenshotted against seeded
demo data (`demo-parked-gate1`, `demo-completed`) at both a standard and a
wide viewport and visually inspected -- this is how the `main { max-width:
1000px }` legacy-CSS bug above was actually caught, not by reading code.

## Post-redesign QA pass

A follow-up pass, done after the redesign above landed (commit `195bcc7`)
and after the zero-token trigger-source rework (commit `d08e5cb`, see
`docs/13-zero-token-rework.md`). Every route was re-screenshotted with
Playwright/Chromium at 1600x1000 and 1280x800 against freshly reseeded demo
data, and every screenshot was actually read, not just captured. Four real
defects were found and fixed; one gap (the `/new` trigger sources going
stale against the landed MCP work) was reconciled.

**Fixed:**

1. **Plan page objections were unreadable.** `ObjectionCard`
   (`app/runs/[runId]/plan/page.tsx`) truncated the objection claim to a
   single line with CSS `truncate`, and the expanded content never repeated
   it -- so a reviewer could never read the full objection on the app's most
   important decision surface. Changed to `whitespace-normal break-words`
   so the full claim always wraps and reads in full.
2. **The sessions board clipped cards with zero scroll affordance.**
   `BoardClient`'s 7 fixed-width columns scroll horizontally, but at common
   viewport widths only 3-4 fit and a card could be hard-clipped mid-card
   with no visual signal more columns existed off-screen. Added a
   scroll-position-aware right-edge fade (`components/board/BoardClient.tsx`)
   that appears only when there's more to scroll to.
3. **A false "unhealthy" alarm on every completed run.**
   `lib/health.ts`'s hand-maintained `KNOWN_JOURNAL_KINDS` predates the Gate
   2/M4 pipeline and was missing `verify_verdict`, `review_completed`,
   `pr_create_intent`, `pr_created` -- kinds `packages/implement` legitimately
   writes and this same dashboard's `board-data.ts`/`review-data.ts` already
   render correctly. Every successfully-completed run showed a large red
   "may be INCOMPLETE -- do not treat as healthy" banner for no real reason.
   Added the missing kinds; the banner now only fires on genuine gaps.
4. **Next's default 404 was unstyled and low-contrast.** Any stale/guessed
   route (e.g. the old top-level `/questions`, which is actually per-run at
   `/runs/<id>/questions`) fell through to Next's built-in "This page could
   not be found," dark grey on near-black. Added `app/not-found.tsx` using
   the existing `EmptyState`/`Surface` components so a 404 reads as an
   on-brand, legible empty state with a way back to Sessions.

**Reconciled:** `/new`'s trigger-source tabs (Sweep/Linear/Slack/Granola)
were still all blanket-labelled "not wired up from this UI yet," which
`d08e5cb` made factually wrong -- those sources have real, credential-free
(Sweep) or MCP-backed (Linear/Slack/Granola) `fetchSignals()` paths. `/new`
now has a "Scan for TODOs"/"Scan Linear issues"/etc. action per non-manual
tab (`app/new/NewSessionForm.tsx`, new `app/api/new/scan/route.ts`) that
runs the real source server-side and lets the user pick a found signal to
pre-fill the finding description, then launch through the existing
confirm-gated manual flow. Sweep's scan is local/free and runs without
confirmation; Linear/Slack/Granola's scan spends a real read-only Claude/MCP
call and is gated behind its own confirmation dialog. A thrown
"MCP not connected" error from a source is surfaced verbatim to the user
instead of a generic message. Verified via `pnpm --filter @pros/dashboard
test`/`typecheck`, a real (local-only) sweep scan against this repo, and
reading the Linear/Slack/Granola tab copy -- never by triggering a real
Linear/Slack/Granola/MCP call, per the hard constraint against contacting
external services during this pass.

**Verification:** `pnpm -r test` -- 320 passing, 1 skipped (the pre-existing
self-flaking real-`claude`-CLI acceptance test in `@pros/plan`, confirmed
flaky by immediate retry, not a regression), 0 failing, across all 19
packages. `pnpm -r typecheck` -- 18/18 typechecked packages clean. Every
route re-screenshotted post-fix and re-read to confirm each defect above is
actually gone, not just changed.
