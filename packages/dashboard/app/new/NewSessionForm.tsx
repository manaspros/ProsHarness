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
    note: "Reads TODO/FIXME/XXX comments (with file:line evidence) from the repo tree -- the one source needing no credentials, but this UI doesn't run the scan for you yet.",
  },
  {
    id: "linear",
    label: "Linear",
    note: "Reads issues via an already-connected Linear MCP server (or a PROS_LINEAR_API_KEY fallback) -- not wired up from this UI yet.",
  },
  {
    id: "slack",
    label: "Slack",
    note: "Reads channel history via an already-connected Slack MCP server (or an API-key fallback) -- not wired up from this UI yet.",
  },
  {
    id: "granola",
    label: "Granola",
    note: "Reads meeting notes via an already-connected Granola MCP server -- not wired up from this UI yet.",
  },
];

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
        body: JSON.stringify({ repoRoot, description, source }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `launch failed (HTTP ${res.status})`);
        setLaunching(false);
        return;
      }
      if (data.ok === false) {
        // Non-manual source, honestly reported as not wired up.
        setNotice(data.message ?? "not wired yet");
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (source !== "manual") {
      // Non-manual sources no-op honestly -- no need for the "this spends
      // real usage" confirmation since nothing real fires.
      void launch();
      return;
    }
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
            <Tabs value={source} onValueChange={(v) => setSource(v as TriggerSourceId)}>
              <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
                {TRIGGER_SOURCES.map((s) => (
                  <TabsTrigger key={s.id} value={s.id} className="text-xs">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">{selected.note}</p>
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
    </div>
  );
}
