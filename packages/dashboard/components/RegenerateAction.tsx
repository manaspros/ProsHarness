"use client";

import { AlertCircle, Check, Loader2, RefreshCw, Sparkles, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";

type RegenerationKind = "miner" | "skillrank";

const ACTIONS: Record<RegenerationKind, { endpoint: string; emptyLabel: string; rerunLabel: string }> = {
  miner: {
    endpoint: "/api/loops/regenerate",
    emptyLabel: "Mine Claude history",
    rerunLabel: "Re-run mining",
  },
  skillrank: {
    endpoint: "/api/skills/regenerate",
    emptyLabel: "Generate skill proposals",
    rerunLabel: "Regenerate proposals",
  },
};

interface RegenerateActionProps {
  kind: RegenerationKind;
  compact?: boolean;
}

type ActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function RegenerateAction({ kind, compact = false }: RegenerateActionProps) {
  const router = useRouter();
  const [state, setState] = React.useState<ActionState>({ status: "idle" });
  const action = ACTIONS[kind];

  async function regenerate() {
    setState({ status: "pending" });
    try {
      const response = await fetch(action.endpoint, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        proposalCount?: number;
      };
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `Request failed (${response.status})`);
      }

      const noun = kind === "miner" ? "mined proposals" : "skill proposals";
      const count = typeof payload.proposalCount === "number" ? ` (${payload.proposalCount} found)` : "";
      setState({ status: "success", message: `Updated ${noun}${count}.` });
      router.refresh();
    } catch (error: unknown) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  const pending = state.status === "pending";
  const Icon = kind === "miner" ? Sparkles : Wrench;

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant={compact ? "outline" : "default"}
        size={compact ? "sm" : "default"}
        onClick={regenerate}
        disabled={pending}
        aria-busy={pending}
        title={
          kind === "miner"
            ? "Reads local Claude Code history only; generated data stays in the configured miner output directory."
            : "Reads local signals and generates proposals only; it never installs a skill."
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : compact ? <RefreshCw /> : <Icon />}
        {pending ? "Working…" : compact ? action.rerunLabel : action.emptyLabel}
      </Button>
      {state.status === "success" && (
        <p className="flex items-center gap-1 text-xs text-emerald-300" role="status">
          <Check className="h-3 w-3" /> {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p className="flex max-w-sm items-start gap-1 text-xs text-red-300" role="alert">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> {state.message}
        </p>
      )}
    </div>
  );
}
