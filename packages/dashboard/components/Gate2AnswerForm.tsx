import { Button } from "@/components/ui/button";

/** The fixed, safe answer for a parked Gate 2 review checkpoint. */
export function Gate2AnswerForm({ runId, checkpointId, redirectTo }: { runId: string; checkpointId: string; redirectTo: string }) {
  return (
    <form
      action={`/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/answer`}
      method="post"
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="answer" value="reviewed" />
      <input type="hidden" name="effect" value="continue_within_approved_plan" />
      <input type="hidden" name="redirectTo" value={redirectTo} />
      <Button type="submit" size="sm">
        Mark PR reviewed
      </Button>
    </form>
  );
}
