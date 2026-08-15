import "./globals.css";

import { SilkBackground } from "@/components/SilkBackground";
import { Surface } from "@/components/Surface";
import { SidebarShell, type SidebarCounts, type SidebarRecentRun } from "@/components/SidebarShell";
import type { Status } from "@/components/StatusPill";
import { getRunsRoot } from "@/lib/config";
import { listRuns } from "@/lib/list-runs";
import { deriveRunStatus, RUN_STATUS_LABELS, type RunStatusLabel } from "@/lib/run-status";

export const metadata = {
  title: "pros dashboard",
  description: "ProsHarness operator console -- runs, plans, questions",
};

// How many recent runs to surface in the sidebar's scrollable list.
const RECENT_RUNS_LIMIT = 15;

function toPillStatus(label: RunStatusLabel): Status {
  if (label.startsWith("parked")) return "parked";
  return label as Status; // "running" | "idle" | "done" all match Status directly.
}

// Stage 3 app shell: a persistent collapsible left sidebar (SidebarShell,
// client component for the collapse/localStorage/⌘K chrome) fed by a
// server-side listRuns() call here, plus a main content area sitting on an
// opaque Surface so the SilkBackground shader is only visible in the
// gutters around the shell, not behind page content. Individual pages
// (app/runs, app/loops, app/schedule, app/skills, app/runs/[runId]/*) are
// intentionally left unstyled inside <main> -- that's the next stage's job.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const runsRoot = getRunsRoot();
  // Defensive: layout renders on every page, so a bad runs root must never
  // crash the whole app shell -- fall back to an empty list like listRuns
  // itself already does for a missing directory.
  const runs = await listRuns(runsRoot).catch(() => []);

  const statuses = runs.map((r) => deriveRunStatus(r.state));

  const counts: SidebarCounts = statuses.reduce(
    (acc, status) => {
      if (status.startsWith("parked")) acc.parked += 1;
      else if (status === "running") acc.running += 1;
      else if (status === "done") acc.done += 1;
      else acc.idle += 1;
      return acc;
    },
    { parked: 0, running: 0, done: 0, idle: 0 } satisfies SidebarCounts,
  );

  const recentRuns: SidebarRecentRun[] = [...runs]
    .reverse() // listRuns sorts ascending by id; most-recent-first for the sidebar
    .slice(0, RECENT_RUNS_LIMIT)
    .map((r) => {
      const status = deriveRunStatus(r.state);
      return {
        runId: r.runId,
        status: toPillStatus(status),
        statusLabel: RUN_STATUS_LABELS[status],
      };
    });

  return (
    <html lang="en" className="dark">
      <body>
        <SilkBackground />
        <div className="relative z-[1] flex min-h-screen">
          <SidebarShell recentRuns={recentRuns} counts={counts} />
          <main className="min-w-0 flex-1 p-6 md:p-8">
            <Surface elevation="base" className="mx-auto min-h-[calc(100vh-3rem)] max-w-[1800px] p-6 md:p-8">
              {children}
            </Surface>
          </main>
        </div>
      </body>
    </html>
  );
}
