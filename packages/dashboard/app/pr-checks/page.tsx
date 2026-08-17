import Link from "next/link";
import { ArrowUpRight, CheckCircle2, CircleAlert, GitPullRequest, Inbox, ShieldCheck } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { SectionHeading } from "@/components/SectionHeading";
import { StatusPill, type Status } from "@/components/StatusPill";
import { Surface } from "@/components/Surface";
import { getIndexDbPath, getRunsRoot } from "@/lib/config";
import { listRuns } from "@/lib/list-runs";
import {
  parseLatestEventOfKind,
  type PrCreatedPayload,
  type ReviewCompletedPayload,
  type VerifyVerdictPayload,
} from "@/lib/review-data";
import { rebuildAndOpenIndex } from "@/lib/db";
import { deriveRunStatus, RUN_STATUS_LABELS } from "@/lib/run-status";
import { getPlanOperationStatus } from "@/lib/review-data";
import { gate2ReviewDecision, isGate2StoppedOperation } from "@/lib/gate2";

export const dynamic = "force-dynamic";

interface PrCheckEntry {
  runId: string;
  status: Status;
  label: string;
  detail: string;
  pr?: PrCreatedPayload;
  verification?: VerifyVerdictPayload;
  review?: ReviewCompletedPayload;
  operationError?: string;
  runStatus: string;
}

export default async function PrChecksPage() {
  const runsRoot = getRunsRoot();
  const { db } = await rebuildAndOpenIndex(getIndexDbPath(), runsRoot);
  let entries: PrCheckEntry[] = [];
  try {
    const runs = await listRuns(runsRoot);
    entries = runs
      .map((run) => {
        const verification = parseLatestEventOfKind<VerifyVerdictPayload>(db, run.runId, "verify_verdict");
        const review = parseLatestEventOfKind<ReviewCompletedPayload>(db, run.runId, "review_completed");
        const pr = parseLatestEventOfKind<PrCreatedPayload>(db, run.runId, "pr_created");
        const operation = getPlanOperationStatus(db, run.runId);
        const gate1Checkpoint = [...run.state.checkpoints.values()].find((checkpoint) => checkpoint.gateType === "plan_approval");
        const gate2Checkpoint = [...run.state.checkpoints.values()].find((checkpoint) => checkpoint.gateType === "pr_review");
        const gate2Stopped = isGate2StoppedOperation(operation);

        if (gate1Checkpoint?.phase === "answered" && gate1Checkpoint.effect === "abort") {
          return {
            runId: run.runId,
            status: "fail" as Status,
            label: "Gate 1 aborted",
            detail: "The plan was rejected; Gate 2 did not start.",
            verification,
            review,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }

        if (gate1Checkpoint?.phase === "answered" && gate1Checkpoint.effect === "requires_plan_amendment") {
          return {
            runId: run.runId,
            status: "blocked" as Status,
            label: "Gate 1 amendment required",
            detail: "The amendment flow is unavailable; no implementation will start.",
            verification,
            review,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }

        if (gate2Stopped) {
          const operationError = operation?.error ?? "Gate 2 stopped before producing a PR";
          return {
            runId: run.runId,
            status: "fail" as Status,
            label: "Gate 2 stopped",
            detail: operationError,
            verification,
            review,
            operationError,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }

        if (operation?.operation === "implementation" && operation.state === "failed") {
          const operationError = operation.error ?? "Gate 2 failed before producing a PR";
          return {
            runId: run.runId,
            status: "fail" as Status,
            label: "Gate 2 failed",
            detail: operationError,
            verification,
            review,
            operationError,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }

        if (operation?.operation === "implementation" && operation.state === "running") {
          return {
            runId: run.runId,
            status: "running" as Status,
            label: "Gate 2 running",
            detail: "Implementation and review are still in progress",
            verification,
            review,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }

        if (pr) {
          const reviewDecision = gate2ReviewDecision(gate2Checkpoint);
          const awaitingReview = reviewDecision === "awaiting_review" || reviewDecision === "not_recorded";
          const invalidAnswer = reviewDecision === "invalid_answer";
          return {
            runId: run.runId,
            status: (invalidAnswer ? "fail" : awaitingReview ? "parked" : "pass") as Status,
            label: invalidAnswer ? "Gate 2 answer invalid" : awaitingReview ? "Gate 2 review" : "Reviewed",
            detail: invalidAnswer
              ? "The recorded answer does not confirm a reviewed PR"
              : awaitingReview
                ? `Draft PR #${pr.number} is waiting for your review`
                : `Draft PR #${pr.number} was reviewed`,
            pr,
            verification,
            review,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }
        if (review) {
          const blocked = review.verdict !== "approve";
          return {
            runId: run.runId,
            status: (blocked ? "fail" : "parked") as Status,
            label: blocked ? "Blocked" : "Automated review passed",
            detail: blocked ? "Review found unresolved blockers" : "Waiting for the implementation handoff; human Gate 2 review is not recorded",
            verification,
            review,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }
        if (verification) {
          const failed = verification.outcome !== "pass";
          return {
            runId: run.runId,
            status: (failed ? "fail" : "running") as Status,
            label: failed ? "Verification failed" : "Verification passed",
            detail: verification.summary,
            verification,
            runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
          };
        }
        return {
          runId: run.runId,
          status: "idle" as Status,
          label: "Not started",
          detail: "This session has not reached the PR check yet",
          runStatus: RUN_STATUS_LABELS[deriveRunStatus(run.state)],
        };
      })
      .reverse();
  } finally {
    db.close();
  }

  const ready = entries.filter((entry) => entry.pr && entry.status === "parked").length;
  const blocked = entries.filter((entry) => entry.status === "fail" || entry.status === "blocked").length;
  const inProgress = entries.filter((entry) => entry.status === "running" || entry.status === "parked").length;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="PR checks"
        description="One review queue for every session that has reached verification or a draft pull request."
        action={
          <Link href="/" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground/90 transition-colors hover:bg-white/[0.04]">
            Sessions <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard icon={<GitPullRequest className="h-4 w-4" />} value={ready} label="ready to review" tone="text-status-pass" />
        <SummaryCard icon={<CircleAlert className="h-4 w-4" />} value={blocked} label="blocked" tone="text-status-fail" />
        <SummaryCard icon={<ShieldCheck className="h-4 w-4" />} value={inProgress} label="in progress" tone="text-status-parked" />
      </div>

      {entries.length === 0 ? (
        <Surface elevation="raised">
          <EmptyState icon={<Inbox className="h-8 w-8" />} title="No PR checks yet" description="When a session reaches verification, its check will appear here independently of the session workspace." />
        </Surface>
      ) : (
        <Surface elevation="raised" className="overflow-hidden p-2">
          <div className="hidden grid-cols-[minmax(0,1.25fr)_minmax(180px,1fr)_auto] gap-4 border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:grid">
            <span>Session</span><span>Check</span><span>Action</span>
          </div>
          <div className="divide-y divide-border/70">
            {entries.map((entry) => (
              <Link key={entry.runId} href={`/pr-checks/${encodeURIComponent(entry.runId)}`} className="group grid gap-3 rounded-md px-4 py-4 transition-colors hover:bg-accent/50 md:grid-cols-[minmax(0,1.25fr)_minmax(180px,1fr)_auto] md:items-center md:gap-4">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-foreground">{entry.runId}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">Session status: {entry.runStatus}</div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <StatusPill status={entry.status} label={entry.label} />
                  <span className="truncate text-xs text-muted-foreground">{entry.detail}</span>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
                  {entry.pr ? `Open PR #${entry.pr.number}` : "Open check"}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))}
          </div>
        </Surface>
      )}
    </div>
  );
}

function SummaryCard({ icon, value, label, tone }: { icon: React.ReactNode; value: number; label: string; tone: string }) {
  return (
    <Surface elevation="base" grain={false} className="flex items-center gap-3 p-3.5">
      <span className={`grid h-8 w-8 place-items-center rounded-md bg-current/10 ${tone}`}>{icon}</span>
      <div><div className="text-lg font-semibold leading-none text-foreground">{value}</div><div className="mt-1 text-[11px] text-muted-foreground">{label}</div></div>
    </Surface>
  );
}
