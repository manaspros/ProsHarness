import path from "node:path";
import Link from "next/link";
import { MessageCircleQuestion } from "lucide-react";
import { listRuns } from "../../lib/list-runs";
import { getRunsRoot } from "../../lib/config";
import { ANSWER_EFFECTS, DEFAULT_ANSWER_EFFECT } from "../../lib/gate-actions";
import { SectionHeading } from "../../components/SectionHeading";
import { Surface } from "../../components/Surface";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Gate2AnswerForm } from "../../components/Gate2AnswerForm";

export const dynamic = "force-dynamic";

const selectClass =
  "flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** Workspace-level inbox for parked human checkpoints, including Gate 2 PR reviews. */
export default async function QuestionsInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const runs = await listRuns(getRunsRoot());
  const questions = runs.flatMap((run) =>
    [...run.state.checkpoints.values()]
      .filter((cp) => ((cp.gateType ?? "ask_human") === "ask_human" || cp.gateType === "pr_review") && cp.phase === "parked")
      .map((checkpoint) => ({ runId: run.runId, checkpoint })),
  );

  return (
    <div className="space-y-6">
      <SectionHeading
        as="h1"
        title="Questions"
        description="Questions from active sessions that need a human answer."
      />

      {error && <Alert variant="error">Error: {error}</Alert>}

      {questions.length === 0 ? (
        <Surface elevation="raised">
          <EmptyState
            icon={<MessageCircleQuestion className="h-8 w-8" />}
            title="No unanswered questions"
            description="When a session needs input, its question will appear here."
          />
        </Surface>
      ) : (
        <div className="space-y-4">
          {questions.map(({ runId, checkpoint }) => (
            <Surface key={`${runId}-${checkpoint.checkpointId}`} elevation="raised" className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/runs/${encodeURIComponent(runId)}`} className="font-mono text-xs text-primary hover:underline">
                  {runId}
                </Link>
                <StatusPill status="parked" label="Needs answer" />
              </div>
              <p className="text-sm font-medium text-foreground">{checkpoint.prompt}</p>
              {checkpoint.gateType === "pr_review" && checkpoint.prRef && (
                <a href={checkpoint.prRef.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                  Open draft PR #{checkpoint.prRef.number} →
                </a>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Options: {checkpoint.options.length > 0 ? checkpoint.options.join(", ") : "(none -- free text only)"}
                </span>
                <Link href={`/runs/${encodeURIComponent(runId)}/questions`} className="text-primary hover:underline">
                  Open session questions →
                </Link>
              </div>
              {checkpoint.gateType === "pr_review" ? (
                <div className="border-t border-border pt-3">
                  <Gate2AnswerForm
                    runId={runId}
                    checkpointId={checkpoint.checkpointId}
                    redirectTo="/questions"
                  />
                </div>
              ) : (
                <form
                  action={`/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpoint.checkpointId)}/answer`}
                  method="post"
                  className="space-y-3 border-t border-border pt-3"
                >
                  <input type="hidden" name="redirectTo" value="/questions" />
                  <div className="flex flex-wrap items-center gap-2">
                    {checkpoint.options.length > 0 ? (
                      <select name="answer" defaultValue={checkpoint.options[0]} className={selectClass}>
                        {checkpoint.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <span className="text-sm text-muted-foreground">or free text:</span>
                    <Input type="text" name="answerFreeText" placeholder="Type an answer" className="max-w-sm" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Effect:</span>
                    <select name="effect" defaultValue={DEFAULT_ANSWER_EFFECT} className={selectClass}>
                      {ANSWER_EFFECTS.map((effect) => (
                        <option key={effect} value={effect}>
                          {effect}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" size="sm">
                      Submit answer
                    </Button>
                  </div>
                </form>
              )}
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
