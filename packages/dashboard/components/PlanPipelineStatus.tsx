"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { Surface } from "@/components/Surface";

type Operation = {
  operation: "plan_pipeline" | "codex_review" | "claude_refinement" | "implementation";
  state: "running" | "success" | "failed" | "stopped";
  error?: string;
};

/**
 * The plan pipeline is intentionally launched in the background because a
 * real finding/debate pass can take minutes. Keep the plan page live during
 * that handoff so the user does not have to guess when Gate 1 is ready.
 */
export function PlanPipelineStatus({ waitingForPlan, waitingForApproval, operation }: {
  waitingForPlan: boolean;
  waitingForApproval: boolean;
  operation?: Operation;
}) {
  const router = useRouter();
  const running = operation?.state === "running";

  React.useEffect(() => {
    if (!waitingForPlan && !waitingForApproval && !running) return;
    const timer = window.setInterval(() => router.refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [router, waitingForPlan, waitingForApproval, running]);

  if (!waitingForPlan && !waitingForApproval && !running && operation?.state !== "failed" && operation?.state !== "stopped") return null;

  const title = operation?.state === "stopped"
    ? "Gate 2 stopped"
    : operation?.state === "failed"
      ? "The operation failed"
    : operation?.operation === "codex_review"
      ? "Codex is challenging this plan…"
      : operation?.operation === "claude_refinement"
        ? "Claude is refining this plan…"
        : operation?.operation === "implementation"
          ? "Implementation is starting in a fresh context…"
          : waitingForPlan
            ? "Building your plan…"
            : "Preparing plan approval…";

  const terminal = operation?.state === "failed" || operation?.state === "stopped";
  return (
    <Surface elevation="raised" grain={false} className={`flex items-center gap-3 p-4 ${terminal ? "border-destructive/40 bg-destructive/10" : "border-status-running/30 bg-status-running/10"}`}>
      {terminal ? null : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-status-running" />}
      <div className="text-sm">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {terminal
            ? operation.error ?? "The run recorded a failure. Open the Claude session for the details."
            : "This page updates automatically and shows the new plan when the operation completes."}
        </p>
      </div>
    </Surface>
  );
}
