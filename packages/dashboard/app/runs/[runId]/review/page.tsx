import Link from "next/link";
import {
  ArrowLeft,
  ClipboardList,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Square,
} from "lucide-react";

import { getRunsRoot, getIndexDbPath } from "../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../lib/db";
import {
  parseLatestEventOfKind,
  getWorktreeInfo,
  computeReviewData,
  type VerifyVerdictPayload,
  type ReviewCompletedPayload,
  type PrCreatedPayload,
} from "../../../../lib/review-data";
import type { ChecklistItem } from "@pros/review";
import { SectionHeading } from "../../../../components/SectionHeading";
import { Surface } from "../../../../components/Surface";
import { EmptyState } from "../../../../components/EmptyState";
import { StatusPill } from "../../../../components/StatusPill";
import { Alert } from "../../../../components/Alert";
import { cn } from "../../../../lib/utils";

export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<ChecklistItem["category"], string> = {
  untested_branch: "Untested branch",
  error_handling_changed: "Error handling changed",
  new_external_call: "New external call",
  concurrency_change: "Concurrency change",
  verification_flag: "Verification flag",
  review_objection: "Review objection",
};

export default async function ReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const runsRoot = getRunsRoot();
  const dbPath = getIndexDbPath();

  const { db } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let worktree, verdict, review, prCreated;
  try {
    worktree = getWorktreeInfo(db, runId);
    verdict = parseLatestEventOfKind<VerifyVerdictPayload>(db, runId, "verify_verdict");
    review = parseLatestEventOfKind<ReviewCompletedPayload>(db, runId, "review_completed");
    prCreated = parseLatestEventOfKind<PrCreatedPayload>(db, runId, "pr_created");
  } finally {
    db.close();
  }

  const backLink = (
    <Link href={`/runs/${encodeURIComponent(runId)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" /> run overview
    </Link>
  );

  // Case 1: Gate 2 hasn't started for this run at all.
  if (!worktree) {
    return (
      <div className="space-y-6">
        {backLink}
        <SectionHeading title="Review" description={<code>{runId}</code>} />
        <Surface elevation="raised">
          <EmptyState
            icon={<GitBranch className="h-8 w-8" />}
            title="No implementation yet"
            description="Gate 2 hasn't started for this run -- no worktree or PR has been created yet."
          />
        </Surface>
      </div>
    );
  }

  const unresolvedBlockers: string[] = review ? safeParseArray<string>(review.unresolvedBlockersJson) : [];

  // Case 2: worktree exists but no PR yet (verification may have failed, or
  // review found blockers -- either way, per the M3/M5 "never look healthy"
  // invariant, we show whatever verdict/review we DO have, including a
  // failing one, rather than hiding it behind a generic "in progress".
  if (!prCreated) {
    return (
      <div className="space-y-6">
        {backLink}
        <SectionHeading title="Review" description={<code>{runId}</code>} />

        <Surface elevation="raised">
          <EmptyState
            icon={<GitPullRequest className="h-8 w-8" />}
            title="No PR opened yet"
            description="This run's implementation has a worktree, but no PR has been opened for it yet."
          />
        </Surface>

        {(verdict || review) && (
          <Surface elevation="raised" className="flex flex-wrap items-center gap-x-6 gap-y-2 p-5 text-sm">
            {verdict && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Verification:</span>
                <StatusPill status={verdict.outcome === "pass" ? "pass" : "fail"} label={verdict.outcome} />
                <span className="text-muted-foreground">-- {verdict.summary}</span>
              </div>
            )}
            {review && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Review:</span>
                <StatusPill status={review.verdict === "approve" ? "pass" : "fail"} label={review.verdict} />
              </div>
            )}
          </Surface>
        )}
        {!verdict && !review && <p className="text-sm text-muted-foreground">No verification verdict recorded yet.</p>}

        {unresolvedBlockers.length > 0 && (
          <Alert variant="warning" title="Unresolved blocker(s)">
            <ul className="list-disc space-y-1 pl-5">
              {unresolvedBlockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </Alert>
        )}
      </div>
    );
  }

  // Case 3: full case -- a PR exists. Rank hunks against repoRoot (the
  // ORIGINAL parent repo), never worktreePath -- see the detailed comment
  // in lib/review-data.ts's ComputeReviewDataOptions for why this is
  // correct even after the worktree directory itself has been reaped.
  let riskRankedDiff, checklist;
  try {
    ({ riskRankedDiff, checklist } = computeReviewData({
      repoRoot: worktree.repoRoot,
      baseSha: worktree.baseSha ?? prCreated.headSha,
      headSha: prCreated.headSha,
      verdict,
      review,
    }));
  } catch (err) {
    // rankHunks shells out to real git -- if the recorded shas are somehow
    // no longer resolvable (e.g. repoRoot itself was deleted), don't crash
    // the whole page; surface the failure plainly instead.
    return (
      <div className="space-y-6">
        {backLink}
        <SectionHeading title="Review" description={<code>{runId}</code>} />
        <Alert variant="error">
          Could not compute the risk-ranked diff for this PR: {err instanceof Error ? err.message : String(err)}
        </Alert>
      </div>
    );
  }

  // Group the focus checklist by category, preserving the lib's
  // deterministic (category, file, line) ordering within each group and
  // first-seen category order across groups.
  const checklistGroups: Array<{ category: ChecklistItem["category"]; items: ChecklistItem[] }> = [];
  for (const item of checklist) {
    let group = checklistGroups.find((g) => g.category === item.category);
    if (!group) {
      group = { category: item.category, items: [] };
      checklistGroups.push(group);
    }
    group.items.push(item);
  }

  return (
    <div className="space-y-6">
      {backLink}
      <SectionHeading
        title="Review"
        description={<code>{runId}</code>}
        action={
          <a
            href={prCreated.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground/90 transition-colors hover:bg-white/[0.04]"
          >
            <GitPullRequest className="h-3.5 w-3.5" /> PR #{prCreated.number}
          </a>
        }
      />

      <Surface elevation="raised" className="space-y-3 p-5">
        <p className="text-sm text-foreground/90">
          {/* There is no separately-recorded free-text "why" paragraph in
              this milestone's data model (see docs/03-architecture.md's
              "Intent + risk badge -- one paragraph on why"). Rather than
              invent prose the model never actually produced, we label the
              closest honest substitute plainly: the verification summary.
              This gap (no recorded free-text "why" paragraph exists yet) is
              intentional -- see the final report for this milestone's
              deviations from the brief; the brief's Definition of Done
              forbids touching any docs file from this change. */}
          <span className="text-muted-foreground">Verification summary:</span>{" "}
          {verdict ? verdict.summary : "(no verification verdict recorded)"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {verdict && (
            <span className="inline-flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">Verification:</span>
              <StatusPill status={verdict.outcome === "pass" ? "pass" : "fail"} label={verdict.outcome} />
            </span>
          )}
          {review && (
            <span className="inline-flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">Review:</span>
              <StatusPill status={review.verdict === "approve" ? "pass" : "fail"} label={review.verdict} />
            </span>
          )}
        </div>
      </Surface>

      {unresolvedBlockers.length > 0 && (
        <Alert variant="warning" title="Unresolved blocker(s) -- a human must look closely">
          <ul className="list-disc space-y-1 pl-5">
            {unresolvedBlockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </Alert>
      )}

      <section className="space-y-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
          <FileDiff className="h-4 w-4 text-muted-foreground" />
          Risk-ranked hunks
          <span className="text-sm font-normal text-muted-foreground">
            ({riskRankedDiff.hunks.length} across {riskRankedDiff.totalFiles} file(s), +{riskRankedDiff.totalAddedLines}/-
            {riskRankedDiff.totalRemovedLines})
          </span>
        </h3>

        {riskRankedDiff.hunks.length === 0 ? (
          <Surface elevation="raised">
            <EmptyState icon={<FileDiff className="h-8 w-8" />} title="No hunks in this diff" />
          </Surface>
        ) : (
          <div className="space-y-3">
            {riskRankedDiff.hunks.map((hunk, i) => {
              const body = (
                <div className="space-y-3 border-t border-border p-4">
                  {hunk.riskFactors.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {hunk.riskFactors.map((f, fi) => (
                        <span
                          key={fi}
                          className="inline-flex items-center rounded-full border border-border bg-white/[0.03] px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                  <DiffView patchText={hunk.patchText} />
                </div>
              );
              const header = (
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="truncate font-mono text-sm text-foreground">{hunk.file}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      +{hunk.addedLines}/-{hunk.removedLines}
                    </span>
                  </div>
                  <RiskMeter score={hunk.riskScore} />
                </div>
              );
              return (
                <Surface key={i} elevation="raised" className="overflow-hidden p-0">
                  {hunk.collapsedByDefault ? (
                    <details>
                      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{header}</summary>
                      {body}
                    </details>
                  ) : (
                    <div>
                      {header}
                      {body}
                    </div>
                  )}
                </Surface>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          Focus checklist
          <span className="text-sm font-normal text-muted-foreground">({checklist.length})</span>
        </h3>

        {checklist.length === 0 ? (
          <Surface elevation="raised">
            <EmptyState icon={<ClipboardList className="h-8 w-8" />} title="Nothing flagged" />
          </Surface>
        ) : (
          <div className="space-y-4">
            {checklistGroups.map((group) => (
              <Surface key={group.category} elevation="raised" className="p-5">
                <h4 className="mb-3 text-sm font-semibold text-foreground">{CATEGORY_LABELS[group.category]}</h4>
                <ul className="space-y-2.5">
                  {group.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm">
                      <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="text-foreground/90">{item.description}</span>{" "}
                        <code className="text-xs text-muted-foreground">
                          {item.file}
                          {item.line !== undefined ? `:${item.line}` : ""}
                        </code>
                      </span>
                    </li>
                  ))}
                </ul>
              </Surface>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Simple, dependency-free +/- colour split of a unified-diff hunk's patch text. */
function DiffView({ patchText }: { patchText: string }) {
  const lines = patchText.split("\n");
  return (
    <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-surface-base p-3 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        let lineClass = "text-foreground/80";
        if (line.startsWith("@@")) lineClass = "text-primary/80";
        else if (line.startsWith("+")) lineClass = "bg-status-pass/10 text-status-pass";
        else if (line.startsWith("-")) lineClass = "bg-status-fail/10 text-status-fail";
        return (
          <div key={i} className={cn("whitespace-pre px-1", lineClass)}>
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </pre>
  );
}

/** Visual risk-score strength indicator: a labelled 5-segment bar rather than a bare number. */
function RiskMeter({ score }: { score: number }) {
  let label: string;
  let level: number;
  let colorClass: string;
  if (score < 10) {
    label = "Minimal";
    level = 1;
    colorClass = "bg-status-pass";
  } else if (score < 30) {
    label = "Low";
    level = 2;
    colorClass = "bg-status-pass";
  } else if (score < 60) {
    label = "Medium";
    level = 3;
    colorClass = "bg-status-parked";
  } else if (score < 100) {
    label = "High";
    level = 4;
    colorClass = "bg-status-fail";
  } else {
    label = "Critical";
    level = 5;
    colorClass = "bg-status-fail";
  }

  return (
    <div className="flex items-center gap-2" title={`risk score ${score}`}>
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((seg) => (
          <span
            key={seg}
            className={cn("h-2.5 w-1.5 rounded-sm", seg <= level ? colorClass : "bg-white/[0.08]")}
          />
        ))}
      </div>
      <span className="text-xs font-medium text-muted-foreground">
        {label} <span className="text-muted-foreground/70">({score})</span>
      </span>
    </div>
  );
}

function safeParseArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
