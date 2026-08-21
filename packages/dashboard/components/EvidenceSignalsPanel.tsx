import { CircleHelp } from "lucide-react";
import { StatusPill, type Status } from "@/components/StatusPill";
import type { Confidence, EvidenceSignals, SignalState } from "@/lib/evidence-signals";

/**
 * EvidenceSignalsPanel -- the four binary decision-card signals, shared by
 * the Gate 1 and Gate 2 decision cards. No percentages, no model-reported
 * confidence number: see packages/dashboard/lib/evidence-signals.ts for why
 * and for the hard "no Reproduced -> confidence caps at medium" rule this
 * panel visualizes but does not itself compute.
 *
 * "not_established" renders as its OWN distinct pill (`blocked`, a neutral
 * grey token, never `pass` and never `fail`) -- rendering it as pass/fail
 * would recreate the exact defect this phase exists to close.
 */

const SIGNAL_STATUS: Record<SignalState, Status> = {
  pass: "pass",
  fail: "fail",
  not_established: "blocked",
};

const SIGNAL_LABEL: Record<SignalState, string> = {
  pass: "yes",
  fail: "no",
  not_established: "not established",
};

const CONFIDENCE_STATUS: Record<Confidence, Status> = {
  high: "pass",
  medium: "parked",
  low: "fail",
};

function SignalRow({ label, state, hint }: { label: string; state: SignalState; hint: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <StatusPill status={SIGNAL_STATUS[state]} label={SIGNAL_LABEL[state]} className="shrink-0" />
    </div>
  );
}

export function EvidenceSignalsPanel({ signals, confidence }: { signals: EvidenceSignals; confidence: Confidence }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Evidence</p>
        <span className="flex items-center gap-1.5">
          <StatusPill status={CONFIDENCE_STATUS[confidence]} label={`${confidence} confidence`} />
        </span>
      </div>
      {confidence !== "high" && signals.reproduced !== "pass" && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleHelp className="mt-0.5 h-3 w-3 shrink-0" />
          Confidence cannot exceed medium until the failure is Reproduced -- a fix for an undemonstrated bug is a guess
          with a passing test suite.
        </p>
      )}
      <div className="mt-2">
        <SignalRow
          label="Reproduced"
          state={signals.reproduced}
          hint="A command demonstrated the failure before the fix."
        />
        <SignalRow label="Fix proven" state={signals.fixProven} hint="The same command passes after the fix." />
        <SignalRow label="Gates green" state={signals.gatesGreen} hint="Every configured validation command exits 0." />
        <SignalRow
          label="Independently reviewed"
          state={signals.independentlyReviewed}
          hint="Codex read the diff and raised no blocker (advisory only)."
        />
      </div>
    </div>
  );
}
