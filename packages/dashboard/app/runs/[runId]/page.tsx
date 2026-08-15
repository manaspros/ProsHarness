import path from "node:path";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ListChecks, MessageCircleQuestion, Share2 } from "lucide-react";
import { loadRunState, readManifest } from "@pros/barrier";
import { getRunsRoot, getIndexDbPath } from "../../../lib/config";
import { rebuildAndOpenIndex } from "../../../lib/db";
import { rebuildHealthIssues, queryUnknownJournalKinds, isHealthy, type HealthIssue } from "../../../lib/health";
import { deriveRunStatus, RUN_STATUS_LABELS } from "../../../lib/run-status";
import { SectionHeading } from "../../../components/SectionHeading";
import { Surface } from "../../../components/Surface";
import { StatusPill, type Status } from "../../../components/StatusPill";
import { Alert } from "../../../components/Alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  const state = await loadRunState(runDir).catch(() => undefined);
  if (!state) {
    // Either the run doesn't exist, or its journal is entirely unreadable
    // (not merely truncated -- loadRunState still returns a state object for
    // a truncated-but-partially-readable journal; only a hard failure, e.g.
    // permission error, lands here).
    notFound();
  }

  const manifest = await readManifest(runDir).catch(() => undefined);

  const dbPath = getIndexDbPath();
  const { db, report } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let unknownKinds: string[] = [];
  try {
    unknownKinds = queryUnknownJournalKinds(db, runId);
  } finally {
    db.close();
  }

  const issues: HealthIssue[] = [
    ...rebuildHealthIssues(runId, report, state.truncated),
    ...unknownKinds.map((k) => ({
      kind: "unknown_journal_kind" as const,
      detail: `journal entry kind "${k}" is not recognized by this dashboard's copy of @pros/barrier -- it was preserved verbatim in the index but had NO effect on run-state projection. It may be from a newer/different journal writer.`,
    })),
  ];
  const healthy = isHealthy(issues);
  const status = deriveRunStatus(state);
  const pillStatus: Status = status.startsWith("parked") ? "parked" : (status as Status);

  const attempts = [...state.attempts.values()];
  const checkpoints = [...state.checkpoints.values()];

  return (
    <div className="space-y-6">
      <Link href="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> all runs
      </Link>

      <SectionHeading
        title={
          <span className="font-mono text-xl">{runId}</span>
        }
        description={
          <span className="inline-flex items-center gap-2">
            <StatusPill status={pillStatus} label={RUN_STATUS_LABELS[status]} />
          </span>
        }
        action={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              href={`/runs/${encodeURIComponent(runId)}/plan`}
              className="rounded-md border border-border px-3 py-1.5 text-foreground/90 transition-colors hover:bg-white/[0.04]"
            >
              Plan
            </Link>
            <Link
              href={`/runs/${encodeURIComponent(runId)}/questions`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-foreground/90 transition-colors hover:bg-white/[0.04]"
            >
              <MessageCircleQuestion className="h-3.5 w-3.5" /> Questions
            </Link>
            <Link
              href={`/runs/${encodeURIComponent(runId)}/graph`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-foreground/90 transition-colors hover:bg-white/[0.04]"
            >
              <Share2 className="h-3.5 w-3.5" /> Session graph
            </Link>
            <Link
              href={`/runs/${encodeURIComponent(runId)}/review`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-foreground/90 transition-colors hover:bg-white/[0.04]"
            >
              <ListChecks className="h-3.5 w-3.5" /> Review
            </Link>
          </div>
        }
      />

      {!healthy && (
        <Alert variant="error" title="This run's history may be INCOMPLETE or contain UNPARSED events -- do not treat it as healthy">
          <ul className="list-disc space-y-1 pl-5">
            {issues.map((issue, i) => (
              <li key={i}>
                <span className="font-semibold">[{issue.kind}]</span> {issue.detail}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Surface elevation="raised" className="grid grid-cols-2 gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-4">
        <Field label="Fence epoch" value={state.fenceEpoch} />
        <Field label="Last journal seq" value={state.lastSeq} />
        <Field label="Journal truncated" value={state.truncated ? "YES" : "no"} />
        <Field label="Attempts" value={state.attempts.size} />
      </Surface>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">Manifest</h3>
        {manifest ? (
          <Surface elevation="raised" className="divide-y divide-border">
            <ManifestRow label="cwd" value={manifest.cwd} />
            <ManifestRow label="headSha" value={manifest.headSha} />
            <ManifestRow label="baseSha" value={manifest.baseSha} />
            <ManifestRow label="fenceEpoch (at snapshot)" value={String(manifest.fenceEpoch)} />
            <ManifestRow label="createdAt" value={manifest.createdAt} />
          </Surface>
        ) : (
          <p className="text-sm text-muted-foreground">No manifest yet (run has never parked).</p>
        )}
      </section>

      <Tabs defaultValue="attempts">
        <TabsList>
          <TabsTrigger value="attempts">Attempts ({attempts.length})</TabsTrigger>
          <TabsTrigger value="checkpoints">Checkpoints ({checkpoints.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="attempts">
          {attempts.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">None.</p>
          ) : (
            <Surface elevation="raised" className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Attempt ID</th>
                    <th className="px-4 py-2.5 font-medium">cwd</th>
                    <th className="px-4 py-2.5 font-medium">Unit name</th>
                    <th className="px-4 py-2.5 font-medium">Fence epoch at start</th>
                    <th className="px-4 py-2.5 font-medium">Ended reason</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.attemptId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">{a.attemptId}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{a.cwd}</td>
                      <td className="px-4 py-2.5">{a.unitName}</td>
                      <td className="px-4 py-2.5">{a.fenceEpochAtStart}</td>
                      <td className="px-4 py-2.5">
                        {a.endedReason ?? <span className="text-status-running">(still running)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Surface>
          )}
        </TabsContent>
        <TabsContent value="checkpoints">
          {checkpoints.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">None.</p>
          ) : (
            <Surface elevation="raised" className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Checkpoint ID</th>
                    <th className="px-4 py-2.5 font-medium">Gate type</th>
                    <th className="px-4 py-2.5 font-medium">Phase</th>
                    <th className="px-4 py-2.5 font-medium">Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  {checkpoints.map((cp) => (
                    <tr key={cp.checkpointId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">{cp.checkpointId}</td>
                      <td className="px-4 py-2.5">{cp.gateType ?? "ask_human"}</td>
                      <td className="px-4 py-2.5">
                        {cp.phase === "parked" ? <StatusPill status="parked" label="parked" /> : cp.phase}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{cp.prompt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Surface>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium text-foreground">{value}</div>
    </div>
  );
}

function ManifestRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-4 px-5 py-2.5 text-sm">
      <div className="w-48 shrink-0 text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{value}</div>
    </div>
  );
}
