import path from "node:path";
import Link from "next/link";
import { ArrowLeft, MessageCircleQuestion } from "lucide-react";
import { loadRunState } from "@pros/barrier";
import { getRunsRoot } from "../../../../lib/config";
import { ANSWER_EFFECTS, DEFAULT_ANSWER_EFFECT } from "../../../../lib/gate-actions";
import { SectionHeading } from "../../../../components/SectionHeading";
import { Surface } from "../../../../components/Surface";
import { EmptyState } from "../../../../components/EmptyState";
import { StatusPill } from "../../../../components/StatusPill";
import { Alert } from "../../../../components/Alert";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Gate2AnswerForm } from "../../../../components/Gate2AnswerForm";

export const dynamic = "force-dynamic";

const selectClass =
  "flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export default async function QuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { runId } = await params;
  const { error } = await searchParams;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  const backLink = (
    <Link href={`/runs/${encodeURIComponent(runId)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" /> run overview
    </Link>
  );

  const state = await loadRunState(runDir).catch(() => undefined);
  if (!state) {
    return (
      <div className="space-y-6">
        {backLink}
        <SectionHeading title="Questions" />
        <Alert variant="error">Could not read this run&apos;s state.</Alert>
      </div>
    );
  }

  const questions = [...state.checkpoints.values()].filter(
    (cp) => (cp.gateType ?? "ask_human") === "ask_human" || cp.gateType === "pr_review",
  );

  return (
    <div className="space-y-6">
      {backLink}
      <SectionHeading title="Questions" description={<code>{runId}</code>} />

      {error && <Alert variant="error">Error: {error}</Alert>}

      {questions.length === 0 ? (
        <Surface elevation="raised">
          <EmptyState
            icon={<MessageCircleQuestion className="h-8 w-8" />}
            title="No ask_human checkpoints"
            description="This run has no questions for a human yet."
          />
        </Surface>
      ) : (
        <div className="space-y-4">
          {questions.map((cp) => (
            <Surface key={cp.checkpointId} elevation="raised" className="space-y-3 p-5">
              <p className="text-sm font-medium text-foreground">{cp.prompt}</p>
              {cp.gateType === "pr_review" && cp.prRef && (
                <a href={cp.prRef.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                  Open draft PR #{cp.prRef.number} →
                </a>
              )}

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {cp.phase === "parked" && <StatusPill status="parked" />}
                <span>
                  Options: {cp.options.length > 0 ? cp.options.join(", ") : "(none -- free text only)"}
                </span>
              </div>

              {cp.answer !== undefined ? (
                <p className="text-sm">
                  <span className="font-semibold text-foreground">Answer:</span> {cp.answer}{" "}
                  <em className="text-muted-foreground">[{cp.effect}]</em>
                </p>
              ) : cp.gateType === "pr_review" && cp.phase === "parked" ? (
                <Gate2AnswerForm
                  runId={runId}
                  checkpointId={cp.checkpointId}
                  redirectTo={`/runs/${encodeURIComponent(runId)}/questions`}
                />
              ) : cp.phase === "parked" ? (
                <form
                  action={`/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(cp.checkpointId)}/answer`}
                  method="post"
                  className="space-y-3 border-t border-border pt-3"
                >
                  <input type="hidden" name="redirectTo" value={`/runs/${encodeURIComponent(runId)}/questions`} />
                  <div className="flex flex-wrap items-center gap-2">
                    {cp.options.length > 0 ? (
                      <select name="answer" defaultValue={cp.options[0]} className={selectClass}>
                        {cp.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <span className="text-sm text-muted-foreground">or free text:</span>
                    <Input
                      type="text"
                      name="answerFreeText"
                      placeholder="(used if no option selected above matches)"
                      className="max-w-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Effect:</span>
                    <select name="effect" defaultValue={DEFAULT_ANSWER_EFFECT} className={selectClass}>
                      {ANSWER_EFFECTS.map((e) => (
                        <option key={e} value={e}>
                          {e}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" size="sm">
                      Submit answer
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">Not currently parked (phase: {cp.phase}) -- nothing to answer right now.</p>
              )}
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
