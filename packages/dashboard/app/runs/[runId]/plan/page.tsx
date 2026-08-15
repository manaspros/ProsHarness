import path from "node:path";
import Link from "next/link";
import type React from "react";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FileText,
  FolderGit2,
  GitBranch,
  ListTree,
  MessageSquarePlus,
  ShieldCheck,
} from "lucide-react";
import { loadRunState } from "@pros/barrier";
import { getPlans, getObjections, type ObjectionRow } from "@pros/index";
import { getRunsRoot, getIndexDbPath } from "../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../lib/db";
import { resolveCurrentPlan } from "../../../../lib/plan-doc";
import { PLAN_APPROVAL_ACTIONS } from "../../../../lib/gate-actions";
import { getWorktreeInfo } from "../../../../lib/review-data";
import { splitMarkdownIntoSections, findMatchingSection } from "./plan-sections";
import { Surface } from "@/components/Surface";
import { StatusPill, type Status } from "@/components/StatusPill";
import { SectionHeading } from "@/components/SectionHeading";
import { EmptyState } from "@/components/EmptyState";
import { PlanMarkdown } from "@/components/PlanMarkdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export const dynamic = "force-dynamic";

const PLAN_STATE_TO_STATUS: Record<string, Status> = {
  drafted: "idle",
  revised: "idle",
  edited: "idle",
  finalized: "done",
};

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { runId } = await params;
  const { error, notice } = await searchParams;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  const state = await loadRunState(runDir).catch(() => undefined);

  const dbPath = getIndexDbPath();
  const { db } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let plans, objections, worktree;
  try {
    plans = getPlans(db, runId);
    const current = resolveCurrentPlan(plans);
    objections = current ? getObjections(db, current.plan_id) : [];
    worktree = getWorktreeInfo(db, runId);
  } finally {
    db.close();
  }

  const current = resolveCurrentPlan(plans);
  // "Unresolved" = no resolution recorded yet, or explicitly not accepted.
  const unresolvedObjections = objections.filter((o) => !o.resolution || o.resolution !== "accepted");

  // Find a parked plan_approval checkpoint for this run, if any -- the
  // Approve/Amendment/Reject buttons only appear when one exists, and use
  // ITS OWN questionId/idempotencyKey (never invented ones), per the brief.
  const parkedApprovalCheckpoint = state
    ? [...state.checkpoints.values()].find((cp) => cp.gateType === "plan_approval" && cp.phase === "parked")
    : undefined;

  return (
    <div className="space-y-5">
      <Link
        href={`/runs/${encodeURIComponent(runId)}`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        run overview
      </Link>
      <SectionHeading
        as="h1"
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            Plan review
            <Badge variant="outline" className="gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]">
              Gate 1
            </Badge>
          </span>
        }
        description={
          <>
            Decide what should happen next for <code className="text-xs">{runId}</code>
          </>
        }
      />

      {error && (
        <Surface elevation="raised" grain={false} className="mt-6 border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Error: {error}
        </Surface>
      )}
      {notice && (
        <Surface elevation="raised" grain={false} className="mt-6 border-status-parked/40 bg-status-parked/10 p-4 text-sm text-status-parked">
          {notice}
        </Surface>
      )}

      {!current ? (
        <div className="mt-6">
          <EmptyState
            icon={<FileText className="h-6 w-6" />}
            title="No plan has been drafted for this run yet"
            description="Once Gate 1's plan/critique/debate loop runs, the current plan document will appear here."
          />
        </div>
      ) : (
        <PlanContent
          runId={runId}
          current={current}
          unresolvedObjections={unresolvedObjections}
          worktree={worktree}
          parkedApprovalCheckpoint={parkedApprovalCheckpoint}
        />
      )}
    </div>
  );
}

function PlanContent({
  runId,
  current,
  unresolvedObjections,
  worktree,
  parkedApprovalCheckpoint,
}: {
  runId: string;
  current: { plan_id: string; version: number; state: string; markdown: string; edited_at: string | null; edited_by: string | null };
  unresolvedObjections: ObjectionRow[];
  worktree: { repoRoot: string; worktreePath: string | null; branch: string | null; baseSha: string | null } | undefined;
  parkedApprovalCheckpoint: { checkpointId: string; prompt: string } | undefined;
}) {
  const sections = splitMarkdownIntoSections(current.markdown);
  const encodedRunId = encodeURIComponent(runId);

  return (
    <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-[176px_minmax(0,1fr)_340px]">
      {/* Left rail: the document outline keeps a long plan spatially legible. */}
      <PlanOutline sections={sections} />

      {/* Centre: the plan document itself -- a reading surface. */}
      <Surface elevation="raised" className="min-w-0 p-6 sm:p-8 xl:p-10">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Working document
            </p>
            <p className="mt-1 font-mono text-xs text-foreground/80">
              {current.plan_id} <span className="text-muted-foreground">· v{current.version}</span>
            </p>
            {current.edited_at && (
              <p className="mt-1 text-xs text-muted-foreground">
                last edited {current.edited_at} by <strong className="text-foreground">{current.edited_by}</strong>
              </p>
            )}
          </div>
          <StatusPill status={PLAN_STATE_TO_STATUS[current.state] ?? "idle"} label={current.state} />
        </div>

        {/* Metadata chips -- real data only. Model/cost/token usage is
            computed in-memory by @pros/plan's debate() (see ModelUsage in
            packages/plan/src/model-session.ts) but is never journaled
            anywhere the index can query, so there is genuinely nothing
            honest to show for it here -- it is omitted rather than
            fabricated. Worktree/branch chips render only when a worktree
            allocation has actually been recorded for this run. */}
        {worktree && (
          <div className="mt-4 flex flex-wrap gap-2">
            {worktree.branch && (
              <Badge variant="outline" className="gap-1.5 font-normal">
                <GitBranch className="h-3 w-3" />
                {worktree.branch}
              </Badge>
            )}
            {worktree.worktreePath && (
              <Badge variant="outline" className="gap-1.5 font-mono font-normal">
                <FolderGit2 className="h-3 w-3" />
                {truncateMiddle(worktree.worktreePath, 40)}
              </Badge>
            )}
            {worktree.baseSha && (
              <Badge variant="outline" className="gap-1.5 font-mono font-normal">
                base {worktree.baseSha.slice(0, 7)}
              </Badge>
            )}
          </div>
        )}

        <div className="mt-7">
          {sections.map((section) => (
            <div key={section.id} id={section.id}>
              <PlanMarkdown>{section.markdown}</PlanMarkdown>
            </div>
          ))}
        </div>

        <EditPlanPanel runId={runId} current={current} />
      </Surface>

      {/* Right rail: Codex critique + composer + Gate 1 actions. */}
      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
        <Surface elevation="base" className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Review signal</p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {unresolvedObjections.length === 0 ? "Ready for approval" : "Needs your attention"}
              </p>
            </div>
            {unresolvedObjections.length === 0 ? (
              <span className="grid h-8 w-8 place-items-center rounded-full bg-status-pass/15 text-status-pass">
                <Check className="h-4 w-4" />
              </span>
            ) : (
              <span className="grid h-8 w-8 place-items-center rounded-full bg-status-parked/15 text-status-parked">
                <CircleAlert className="h-4 w-4" />
              </span>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3">
            <div>
              <div className="text-lg font-semibold text-foreground">{unresolvedObjections.length}</div>
              <div className="text-[11px] text-muted-foreground">open objections</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-foreground">v{current.version}</div>
              <div className="text-[11px] text-muted-foreground">plan version</div>
            </div>
          </div>
        </Surface>

        <Surface elevation="raised" className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Codex objections</h2>
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
              {unresolvedObjections.length} open
            </Badge>
          </div>
          <div className="mt-4">
            {unresolvedObjections.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck className="h-6 w-6" />}
                title="None outstanding"
                description="Codex has no unresolved objections against this plan."
              />
            ) : (
              <div className="flex flex-col gap-3">
                {unresolvedObjections.map((o) => {
                  const jumpTarget = findMatchingSection(o.claim, sections);
                  return (
                    <ObjectionCard key={o.id} objection={o} jumpTargetId={jumpTarget?.id} />
                  );
                })}
              </div>
            )}
          </div>
        </Surface>

        <Surface elevation="raised" className="p-5">
          <h2 className="text-sm font-semibold text-foreground">Run an instruction directly</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Records the instruction against this plan. Does not yet launch a live pipeline run -- see the confirmation
            banner after submitting.
          </p>
          <form action={`/api/runs/${encodedRunId}/plan/direct-run`} method="post" className="mt-3">
            <input type="hidden" name="redirectTo" value={`/runs/${encodedRunId}/plan`} />
            <Textarea
              name="instruction"
              rows={3}
              placeholder="e.g. Re-check the call-site audit objection and expand the risk section..."
              required
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                as
                <input
                  type="text"
                  name="requestedBy"
                  defaultValue="human"
                  className="w-20 rounded border border-input bg-transparent px-1.5 py-0.5 text-xs"
                />
              </label>
              <Button type="submit" variant="secondary" size="sm" className="gap-1.5">
                <MessageSquarePlus className="h-3.5 w-3.5" />
                Run
              </Button>
            </div>
          </form>
        </Surface>

        {parkedApprovalCheckpoint && (
          <Surface elevation="raised" className="p-5">
            <h2 className="text-sm font-semibold text-foreground">Gate 1: plan approval</h2>
            <p className="mt-2 text-sm text-muted-foreground">{parkedApprovalCheckpoint.prompt}</p>

            <div className="mt-4 flex flex-col gap-2">
              <GateActionForm
                runId={runId}
                checkpointId={parkedApprovalCheckpoint.checkpointId}
                action="approve"
                label="Approve"
                buttonProps={{ variant: "default", size: "lg", className: "w-full font-semibold" }}
              />
              <div className="flex gap-2">
                <GateActionForm
                  runId={runId}
                  checkpointId={parkedApprovalCheckpoint.checkpointId}
                  action="request_amendment"
                  label="Request Amendment"
                  buttonProps={{ variant: "outline", size: "sm", className: "flex-1" }}
                />
                <GateActionForm
                  runId={runId}
                  checkpointId={parkedApprovalCheckpoint.checkpointId}
                  action="reject"
                  label="Reject"
                  buttonProps={{ variant: "destructive", size: "sm", className: "flex-1" }}
                />
              </div>
            </div>
          </Surface>
        )}
      </div>
    </div>
  );
}

function PlanOutline({ sections }: { sections: ReturnType<typeof splitMarkdownIntoSections> }) {
  return (
    <aside className="hidden min-w-0 xl:block">
      <div className="sticky top-6">
        <div className="flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" />
          In this plan
        </div>
        <nav className="mt-3 border-l border-border pl-3" aria-label="Plan sections">
          <div className="flex flex-col gap-0.5">
            {sections.map((section, index) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="group rounded-r-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <span className="mr-1.5 font-mono text-[10px] text-muted-foreground/60 group-hover:text-accent-foreground/70">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="break-words">{section.heading ?? "Overview"}</span>
              </a>
            ))}
          </div>
        </nav>
        <div className="mt-8 border-t border-border px-2 pt-4">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Decision rule
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Approve only when the plan is clear enough to implement and verify.
          </p>
        </div>
      </div>
    </aside>
  );
}

function GateActionForm({
  runId,
  checkpointId,
  action,
  label,
  buttonProps,
}: {
  runId: string;
  checkpointId: string;
  action: (typeof PLAN_APPROVAL_ACTIONS)[number];
  label: string;
  buttonProps: React.ComponentProps<typeof Button>;
}) {
  return (
    <form
      action={`/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/answer`}
      method="post"
    >
      <input type="hidden" name="planAction" value={action} />
      <input type="hidden" name="answer" value={action} />
      <input type="hidden" name="redirectTo" value={`/runs/${encodeURIComponent(runId)}/plan`} />
      <Button type="submit" {...buttonProps}>
        {label}
      </Button>
    </form>
  );
}

const SEVERITY_STATUS: Record<string, Status> = {
  major: "fail",
  blocker: "fail",
  minor: "parked",
};

function ObjectionCard({ objection, jumpTargetId }: { objection: ObjectionRow; jumpTargetId?: string }) {
  const severity = objection.severity ?? "unknown";
  const status = SEVERITY_STATUS[severity] ?? "idle";
  return (
    <Collapsible defaultOpen className="rounded-md border border-border bg-surface-base/60 p-3">
      <CollapsibleTrigger className="flex w-full items-start justify-between gap-2 text-left">
        <span className="flex min-w-0 items-start gap-2">
          <StatusPill status={status} label={severity} />
          <span className="whitespace-normal break-words text-sm font-medium text-foreground">
            {objection.claim ?? "(no claim recorded)"}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        {objection.suggested_change && (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Suggested change: </span>
            {objection.suggested_change}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          round {objection.round} &middot; {objection.author}
        </p>
        {jumpTargetId && (
          <a href={`#${jumpTargetId}`} className="text-xs text-primary underline underline-offset-2">
            &rarr; jump to section
          </a>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function EditPlanPanel({
  runId,
  current,
}: {
  runId: string;
  current: { plan_id: string; version: number; markdown: string };
}) {
  return (
    <Collapsible className="mt-8 border-t border-border pt-6">
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm">
          Edit plan document
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-4">
        <p className="mb-3 text-xs text-muted-foreground">
          Saving an edit rewrites plan.md and appends a <code>plan_edited</code> journal entry. It does NOT touch the
          fence epoch or any attempt/checkpoint state -- it works whether or not a checkpoint is currently parked.
        </p>
        <form action={`/api/runs/${encodeURIComponent(runId)}/plan/edit`} method="post">
          <input type="hidden" name="planId" value={current.plan_id} />
          <input type="hidden" name="version" value={current.version} />
          <input type="hidden" name="redirectTo" value={`/runs/${encodeURIComponent(runId)}/plan`} />
          <Textarea name="markdown" rows={16} defaultValue={current.markdown} className="font-mono text-xs" />
          <div className="mt-3 flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Edited by
              <input
                type="text"
                name="editedBy"
                defaultValue="human"
                className="w-28 rounded border border-input bg-transparent px-1.5 py-0.5 text-xs"
              />
            </label>
            <Button type="submit" size="sm">
              Save edit
            </Button>
          </div>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}
