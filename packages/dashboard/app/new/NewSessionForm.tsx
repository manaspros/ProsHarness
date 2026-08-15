"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Surface } from "@/components/Surface";
import { SectionHeading } from "@/components/SectionHeading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_REPO_ROOT = "/home/manas/Code/ProsHarness";

type TriggerSourceId = "manual" | "sweep" | "linear" | "slack" | "granola";

interface TriggerSourceOption {
  id: TriggerSourceId;
  label: string;
  note: string;
}

// Notes reflect what packages/triggers/src/sources/*.ts actually require,
// not aspirational one-click readiness -- see each source file's own
// "READ-ONLY ADAPTER" header comment.
const TRIGGER_SOURCES: TriggerSourceOption[] = [
  {
    id: "manual",
    label: "Manual",
    note: "Describe the finding yourself below -- ready to launch, no extra setup.",
  },
  {
    id: "sweep",
    label: "Sweep",
    note: "Reads TODO/FIXME/XXX comments (with file:line evidence) straight from the repo tree -- the one source needing no credentials, and free/local. Use \"Scan for TODOs\" below to run it for real, then pick a finding to launch with.",
  },
  {
    id: "linear",
    label: "Linear",
    note: "Reads issues via your already-connected Linear MCP server (or a PROS_LINEAR_API_KEY fallback) -- no extra setup needed if Linear is connected in claude.ai. Scanning spends a real, read-only Claude call and fails loudly here if Linear isn't connected.",
  },
  {
    id: "slack",
    label: "Slack",
    note: "Reads channel history via your already-connected Slack MCP server (or an API-key fallback) -- no extra setup needed if Slack is connected in claude.ai. Scanning spends a real, read-only Claude call and fails loudly here if Slack isn't connected.",
  },
  {
    id: "granola",
    label: "Granola",
    note: "Reads meeting notes via your already-connected Granola MCP server -- no extra setup needed if Granola is connected in claude.ai. Scanning spends a real, read-only Claude call and fails loudly here if Granola isn't connected.",
  },
];

const SCAN_LABELS: Record<Exclude<TriggerSourceId, "manual">, string> = {
  sweep: "Scan for TODOs",
  linear: "Scan Linear issues",
  slack: "Scan Slack messages",
  granola: "Scan Granola notes",
};

/** A trimmed-down view of @pros/triggers' Signal, just the fields the form needs. */
interface ScannedSignal {
  sourceId: string;
  externalId: string;
  kind: string;
  title: string;
  body: string;
  url?: string;
  evidence?: { file: string; line: number };
}

function describeSignal(signal: ScannedSignal): string {
  const parts = [`[${signal.sourceId}/${signal.kind}] ${signal.title}`, "", signal.body];
  if (signal.evidence) {
    parts.push("", `Evidence: ${signal.evidence.file}:${signal.evidence.line}`);
  }
  if (signal.url) {
    parts.push("", `Source reference (read-only, do not post to): ${signal.url}`);
  }
  return parts.join("\n").trim();
}

export interface NewSessionFormProps {
  /** True when there are literally zero runs anywhere yet -- widens the framing copy. */
  isFirstRun: boolean;
}

export function NewSessionForm({ isFirstRun }: NewSessionFormProps) {
  const router = useRouter();
  const [repoRoot, setRepoRoot] = React.useState(DEFAULT_REPO_ROOT);
  const [description, setDescription] = React.useState("");
  const [source, setSource] = React.useState<TriggerSourceId>("manual");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [launching, setLaunching] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [notice, setNotice] = React.useState<string | undefined>(undefined);

  const [scanning, setScanning] = React.useState(false);
  const [scanSignals, setScanSignals] = React.useState<ScannedSignal[] | undefined>(undefined);
  // Only linear/slack/granola scans go through this -- they spend a real,
  // read-only Claude/MCP call. Sweep's scan is local/free and skips it.
  const [scanConfirmOpen, setScanConfirmOpen] = React.useState(false);

  const selected = TRIGGER_SOURCES.find((s) => s.id === source)!;
  const canSubmit = repoRoot.trim().length > 0 && description.trim().length > 0 && !launching;

  async function launch() {
    setLaunching(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await fetch("/api/new/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Once a description exists -- typed by hand, or pre-filled from a
        // scanned finding below -- launching is always a manual finding
        // submission: the trigger-source tabs choose *how the description
        // got here*, not a different launch mechanism from this form.
        body: JSON.stringify({ repoRoot, description, source: "manual" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `launch failed (HTTP ${res.status})`);
        setLaunching(false);
        return;
      }
      if (data.ok === false) {
        setNotice(data.message ?? "launch failed");
        setLaunching(false);
        return;
      }
      // data.ok === true, data.runId present -- land on the run page right
      // away; the pipeline keeps running in the background.
      router.push(`/runs/${encodeURIComponent(data.runId)}`);
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setLaunching(false);
    }
  }

  async function runScan() {
    setScanning(true);
    setError(undefined);
    setNotice(undefined);
    setScanSignals(undefined);
    try {
      const res = await fetch("/api/new/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoRoot, source }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `scan failed (HTTP ${res.status})`);
        setScanning(false);
        return;
      }
      if (data.ok === false) {
        // The source itself threw a specific, honest error (e.g. MCP
        // unavailable) -- surface it verbatim, never a generic message.
        setError(data.message ?? "scan failed");
        setScanning(false);
        return;
      }
      const signals: ScannedSignal[] = data.signals ?? [];
      setScanSignals(signals);
      if (signals.length === 0) {
        setNotice(
          source === "sweep"
            ? "no TODO/FIXME/XXX found in this repo tree."
            : `no signals found from ${selected.label}.`,
        );
      }
      setScanning(false);
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setScanning(false);
    }
  }

  function onScanClick() {
    if (source === "sweep") {
      // Local/free -- no confirmation needed.
      void runScan();
      return;
    }
    // linear/slack/granola: a real, read-only Claude/MCP call -- gate it
    // behind its own confirmation, same spirit as the launch dialog below.
    setScanConfirmOpen(true);
  }

  function pickSignal(signal: ScannedSignal) {
    setDescription(describeSignal(signal));
    setNotice(undefined);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    // Every submission launches a real plan run (finding + debate, real
    // Claude/Codex usage) regardless of which trigger-source tab was used
    // to arrive at the description -- so every submission goes through the
    // same confirmation dialog as Manual, always.
    setConfirmOpen(true);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <SectionHeading
        as="h1"
        title="New session"
        description={
          isFirstRun
            ? "Start here: describe a finding (or paste one), and this launches a real plan run -- finding → draft plan → Codex critique/debate → parked at Gate 1 for your approval. Nothing lands or ships without that approval."
            : "Pick or enter a repo, describe a finding, choose a trigger source, and launch a plan run."
        }
      />

      <Surface elevation="raised" className="p-6 md:p-8">
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="repoRoot">Repository</Label>
            <Input
              id="repoRoot"
              value={repoRoot}
              onChange={(e) => setRepoRoot(e.target.value)}
              placeholder="/home/you/code/some-repo"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Any local repo path works -- defaults to this repo
              (<code>{DEFAULT_REPO_ROOT}</code>).
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Describe a finding, or paste one</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                'e.g. "sumAll() returns NaN for some inputs -- looks like an off-by-one loop bound" ' +
                "or paste an issue/incident description verbatim."
              }
              rows={6}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Trigger source</Label>
            <Tabs
              value={source}
              onValueChange={(v) => {
                setSource(v as TriggerSourceId);
                setScanSignals(undefined);
                setNotice(undefined);
              }}
            >
              <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
                {TRIGGER_SOURCES.map((s) => (
                  <TabsTrigger key={s.id} value={s.id} className="text-xs">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">{selected.note}</p>

            {source !== "manual" && (
              <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    Run this source for real and pick a finding to launch with.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={scanning || (source === "sweep" && repoRoot.trim().length === 0)}
                    onClick={onScanClick}
                  >
                    {scanning ? "Scanning…" : SCAN_LABELS[source]}
                  </Button>
                </div>

                {scanSignals && scanSignals.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {scanSignals.map((signal) => (
                      <li key={`${signal.sourceId}-${signal.externalId}`}>
                        <button
                          type="button"
                          onClick={() => pickSignal(signal)}
                          className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-left text-xs hover:bg-muted"
                        >
                          <span className="font-medium">{signal.title}</span>
                          {signal.evidence && (
                            <span className="text-muted-foreground">
                              {" "}
                              -- {signal.evidence.file}:{signal.evidence.line}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-status-fail/30 bg-status-fail/10 px-3 py-2 text-sm text-status-fail">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-md border border-status-parked/30 bg-status-parked/10 px-3 py-2 text-sm text-status-parked">
              {notice}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <Button type="submit" disabled={!canSubmit} size="lg">
              {launching ? "Launching…" : "Launch plan run"}
            </Button>
          </div>
        </form>
      </Surface>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a real plan session?</DialogTitle>
            <DialogDescription>
              This starts a real plan session and will use Claude/Codex (your
              connected subscriptions) -- a finding pass, a draft plan, and a
              Codex critique/debate round, running against{" "}
              <code>{repoRoot}</code>. It typically takes anywhere from tens
              of seconds to a few minutes, and parks at Gate 1 for your
              approval before anything is implemented.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void launch();
              }}
            >
              Launch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scanConfirmOpen} onOpenChange={setScanConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scan {selected.label} for real?</DialogTitle>
            <DialogDescription>
              This makes a short-lived, read-only Claude call that uses your
              already-connected {selected.label} MCP server (or a configured
              API-key fallback) to fetch signals -- real subscription usage,
              though nothing is written or posted anywhere. It fails loudly
              here if {selected.label} isn&apos;t connected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScanConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setScanConfirmOpen(false);
                void runScan();
              }}
            >
              Scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
