"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronUp, Folder, FolderOpen, Loader2, Paperclip, Send, SlidersHorizontal, Sparkles } from "lucide-react";

import { Surface } from "@/components/Surface";
import { SectionHeading } from "@/components/SectionHeading";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseLaunchResponse, parseScanResponse, responseError, type ScannedSignal } from "@/lib/new-session-response";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

const DEFAULT_SESSION_PROMPT = "Explore the codebase with a Sonnet subagent, gather the findings and surrounding context, always use subagents when available, then verify the findings before planning.";

/** A trimmed-down view of @pros/triggers' Signal, just the fields the form needs. */
interface BrowseDirectoryEntry {
  name: string;
  path: string;
}

interface BrowseDirectoryResponse {
  ok: true;
  currentPath: string;
  parentPath?: string;
  isGitRepo: boolean;
  directories: BrowseDirectoryEntry[];
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
  /** Server-resolved default target, so the form works when launched from another checkout. */
  defaultRepoRoot: string;
  /** Optional context passed from the session workspace's Linear ticket picker. */
  initialDescription?: string;
  initialWorkspace?: string;
  ticketIdentifier?: string;
}

export function NewSessionForm({ isFirstRun, defaultRepoRoot, initialDescription, initialWorkspace, ticketIdentifier }: NewSessionFormProps) {
  const router = useRouter();
  const [repoRoot, setRepoRoot] = React.useState(initialWorkspace || defaultRepoRoot);
  const [description, setDescription] = React.useState(initialDescription || "");
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

  const [folderPickerOpen, setFolderPickerOpen] = React.useState(false);
  const [browse, setBrowse] = React.useState<BrowseDirectoryResponse | undefined>(undefined);
  const [browsing, setBrowsing] = React.useState(false);
  const [browseError, setBrowseError] = React.useState<string | undefined>(undefined);

  const selected = TRIGGER_SOURCES.find((s) => s.id === source)!;
  const canSubmit = repoRoot.trim().length > 0 && description.trim().length > 0 && !launching;

  React.useEffect(() => {
    if (!initialWorkspace) {
      const savedWorkspace = window.localStorage.getItem("pros:default-workspace");
      if (savedWorkspace) setRepoRoot(savedWorkspace);
    }
    if (initialDescription) setDescription(initialDescription);
  }, [initialDescription, initialWorkspace]);

  async function browseTo(directory: string) {
    setBrowsing(true);
    setBrowseError(undefined);
    try {
      const res = await fetch(`/api/new/browse?path=${encodeURIComponent(directory)}`);
      const data = await res.json();
      if (!res.ok || data.ok !== true) {
        setBrowseError(data?.error ?? `could not browse folder (HTTP ${res.status})`);
        return;
      }
      setBrowse(data as BrowseDirectoryResponse);
    } catch (err: any) {
      setBrowseError(err?.message ?? String(err));
    } finally {
      setBrowsing(false);
    }
  }

  function openFolderPicker() {
    setFolderPickerOpen(true);
    void browseTo(repoRoot.trim() || defaultRepoRoot);
  }

  function saveDefaultWorkspace() {
    const value = repoRoot.trim();
    if (!value) {
      setError("Choose or enter a workspace folder first.");
      return;
    }
    window.localStorage.setItem("pros:default-workspace", value);
    setNotice("Default workspace saved on this device.");
    setError(undefined);
  }

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
        body: JSON.stringify({ repoRoot, description, source: "manual", dangerouslySkipPermissions: true }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        setError(responseError(data, `launch failed (HTTP ${res.status})`));
        setLaunching(false);
        return;
      }
      const launchResponse = parseLaunchResponse(data);
      if (launchResponse.ok === false) {
        setNotice(launchResponse.message);
        setLaunching(false);
        return;
      }
      // data.ok === true, data.runId present -- land on Plan Review right
      // away. The plan pipeline keeps running in the background, and the
      // plan page refreshes itself until Gate 1 is ready.
      router.push(`/runs/${encodeURIComponent(launchResponse.runId)}/plan?pending=1`);
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
      const data: unknown = await res.json();
      if (!res.ok) {
        setError(responseError(data, `scan failed (HTTP ${res.status})`));
        setScanning(false);
        return;
      }
      const scanResponse = parseScanResponse(data);
      if (scanResponse.ok === false) {
        // The source itself threw a specific, honest error (e.g. MCP
        // unavailable) -- surface it verbatim, never a generic message.
        setError(scanResponse.message);
        setScanning(false);
        return;
      }
      const signals: ScannedSignal[] = scanResponse.signals;
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
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <SectionHeading
        as="h1"
        className="border-0 pb-0"
        title={<span className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> New session</span>}
        description={
          ticketIdentifier
            ? `Ready to work on ${ticketIdentifier}. Review the context, then send it to the planning agents.`
            : isFirstRun
              ? "Describe what you want to change. Pros will investigate, draft a plan, and pause for your approval before implementation."
              : "Give the agents a finding, bug, or ticket to investigate."
        }
      />

      <Surface elevation="raised" className="overflow-hidden border-primary/20 p-0 shadow-panel-overlay">
        <form onSubmit={onSubmit}>
          <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-medium text-primary">Planning session</span>
              <span className="hidden sm:inline">Claude + Codex will investigate before anything changes</span>
            </div>
            <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">private workspace</span>
          </div>

          <div className="p-5 md:p-7">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-1.5 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30">
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
                <input
                  aria-label="Session workspace folder"
                  value={repoRoot}
                  onChange={(event) => setRepoRoot(event.target.value)}
                  placeholder="/Users/you/Code/project"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button type="button" onClick={openFolderPicker} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                  Browse
                </button>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={saveDefaultWorkspace} className="shrink-0">
                Save as default
              </Button>
            </div>

            <Textarea
              id="description"
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What would you like to work on? Describe the bug, feature, ticket, or question…"
              rows={9}
              className="min-h-[230px] resize-y border-0 bg-transparent px-0 py-2 text-base leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
            />

            <div className="mt-4 flex items-start gap-3 rounded-md border border-primary/20 bg-primary/[0.06] px-3 py-2.5">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">Default agent workflow is always included</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{DEFAULT_SESSION_PROMPT}</p>
              </div>
            </div>
          </div>

          <div className="border-t border-border/70 px-5 py-3 md:px-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                  <Paperclip className="h-3.5 w-3.5" /> Integrations
                  <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-foreground">Linear</span>
                  <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-foreground">Slack</span>
                  <span className="hidden rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-foreground sm:inline">Granola</span>
                  <SlidersHorizontal className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{selected.label}</span>
                </summary>
                <div className="mt-3 rounded-md border border-border/70 bg-background/40 p-3">
                  <Tabs
                    value={source}
                    onValueChange={(v) => {
                      setSource(v as TriggerSourceId);
                      setScanSignals(undefined);
                      setNotice(undefined);
                    }}
                  >
                    <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
                      {TRIGGER_SOURCES.map((s) => <TabsTrigger key={s.id} value={s.id} className="text-xs">{s.label}</TabsTrigger>)}
                    </TabsList>
                  </Tabs>
                  <p className="mt-2 text-xs text-muted-foreground">{selected.note}</p>
                  {source !== "manual" && (
                    <div className="mt-3 flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">Run this source and pick a finding to add above.</span>
                        <Button type="button" variant="outline" size="sm" disabled={scanning || (source === "sweep" && repoRoot.trim().length === 0)} onClick={onScanClick}>
                          {scanning ? "Scanning…" : SCAN_LABELS[source]}
                        </Button>
                      </div>
                      {scanSignals && scanSignals.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {scanSignals.map((signal) => (
                            <li key={`${signal.sourceId}-${signal.externalId}`}>
                              <button type="button" onClick={() => pickSignal(signal)} className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-left text-xs hover:bg-muted">
                                <span className="font-medium">{signal.title}</span>
                                {signal.evidence && <span className="text-muted-foreground"> -- {signal.evidence.file}:{signal.evidence.line}</span>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </details>
              <Button type="submit" disabled={!canSubmit} size="lg" className="gap-2 rounded-full px-5">
                {launching ? "Starting…" : "Start working"}
                {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {error && (
            <div className="mx-5 mb-4 rounded-md border border-status-fail/30 bg-status-fail/10 px-3 py-2 text-sm text-status-fail md:mx-7">
              {error}
            </div>
          )}
          {notice && (
            <div className="mx-5 mb-4 rounded-md border border-status-parked/30 bg-status-parked/10 px-3 py-2 text-sm text-status-parked md:mx-7">
              {notice}
            </div>
          )}
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
              <span className="mt-2 block text-status-parked">
                Claude will run with permission checks disabled for this session.
              </span>
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

      <Dialog open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choose a repository folder</DialogTitle>
            <DialogDescription>
              Browse folders on the machine running ProsHarness, then select the current folder as the repository.
            </DialogDescription>
          </DialogHeader>

          {browseError && (
            <div className="rounded-md border border-status-fail/30 bg-status-fail/10 px-3 py-2 text-sm text-status-fail">
              {browseError}
            </div>
          )}

          <div className="rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <code className="min-w-0 flex-1 truncate">{browse?.currentPath ?? "Loading folder…"}</code>
              {browse?.isGitRepo && (
                <span className="shrink-0 rounded-full bg-status-pass/15 px-2 py-0.5 text-[10px] font-medium text-status-pass">
                  Git repo
                </span>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border border-border/60">
            {browsing && !browse ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading folders…
              </div>
            ) : (
              <div className="p-1">
                {browse?.parentPath && (
                  <button
                    type="button"
                    onClick={() => void browseTo(browse.parentPath!)}
                    disabled={browsing}
                    className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >
                    <ChevronUp className="h-4 w-4" /> ..
                  </button>
                )}
                {browse && browse.directories.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No child folders.</p>
                )}
                {browse?.directories.map((directory) => (
                  <button
                    key={directory.path}
                    type="button"
                    onClick={() => void browseTo(directory.path)}
                    disabled={browsing}
                    className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{directory.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderPickerOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!browse || browsing}
              onClick={() => {
                if (!browse) return;
                setRepoRoot(browse.currentPath);
                setFolderPickerOpen(false);
              }}
            >
              Use this folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
