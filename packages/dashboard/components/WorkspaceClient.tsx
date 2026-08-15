"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  CircleDot,
  FolderGit2,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Ticket,
} from "lucide-react";

import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filterLinearTickets, type LinearTicket } from "@/lib/linear";

const WORKSPACE_KEY = "pros:default-workspace";
const LINEAR_TEAM_KEY = "pros:linear-team";

export function WorkspaceClient({ defaultRepoRoot }: { defaultRepoRoot: string }) {
  const router = useRouter();
  const [workspace, setWorkspace] = React.useState(defaultRepoRoot);
  const [team, setTeam] = React.useState("ENG");
  const [tickets, setTickets] = React.useState<LinearTicket[]>([]);
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();

  React.useEffect(() => {
    const savedWorkspace = window.localStorage.getItem(WORKSPACE_KEY);
    const savedTeam = window.localStorage.getItem(LINEAR_TEAM_KEY);
    if (savedWorkspace) setWorkspace(savedWorkspace);
    if (savedTeam) setTeam(savedTeam);
  }, []);

  async function loadTickets(teamKey = team) {
    const normalizedTeam = teamKey.trim();
    if (!normalizedTeam) {
      setError("Enter a Linear team key first.");
      return;
    }

    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(`/api/linear/issues?team=${encodeURIComponent(normalizedTeam)}`, {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        ok?: boolean;
        tickets?: LinearTicket[];
        message?: string;
      };
      if (!response.ok || data.ok !== true) {
        setTickets([]);
        setError(data.message ?? `Linear could not be loaded (HTTP ${response.status}).`);
        return;
      }
      window.localStorage.setItem(LINEAR_TEAM_KEY, normalizedTeam);
      setTeam(normalizedTeam);
      setTickets(data.tickets ?? []);
      setLoaded(true);
      if ((data.tickets ?? []).length === 0) setNotice("No tickets matched this team.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  function saveWorkspace() {
    const value = workspace.trim();
    if (!value) {
      setError("Enter a workspace folder first.");
      return;
    }
    window.localStorage.setItem(WORKSPACE_KEY, value);
    setWorkspace(value);
    setNotice("Default workspace saved for new sessions on this browser.");
    setError(undefined);
  }

  function startFromTicket(ticket: LinearTicket) {
    const parts = [`[linear/issue] ${ticket.identifier}: ${ticket.title}`];
    if (ticket.description.trim()) parts.push("", ticket.description.trim());
    if (ticket.url) parts.push("", `Source reference (read-only, do not post to): ${ticket.url}`);
    const params = new URLSearchParams({
      workspace: workspace.trim(),
      description: parts.join("\n"),
      ticket: ticket.identifier,
    });
    router.push(`/new?${params.toString()}`);
  }

  const statuses = React.useMemo(
    () => Array.from(new Set(tickets.map((ticket) => ticket.status).filter(Boolean))).sort() as string[],
    [tickets],
  );
  const labels = React.useMemo(
    () => Array.from(new Set(tickets.flatMap((ticket) => ticket.labels))).sort(),
    [tickets],
  );
  const visibleTickets = React.useMemo(
    () => filterLinearTickets(tickets, { search, status, label }),
    [tickets, search, status, label],
  );

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(280px,0.34fr)_minmax(0,0.66fr)]" aria-label="Session workspace">
      <Surface elevation="raised" className="p-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
            <h2 className="text-base font-semibold text-foreground">Your working context</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              New sessions use this folder automatically. You can still change it before launch.
            </p>
          </div>
          <Settings2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
        </div>

        <label className="flex flex-col gap-2 text-xs font-medium text-foreground" htmlFor="default-workspace">
          Default workspace folder
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="default-workspace"
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                className="pl-9 font-mono text-xs"
                placeholder="/path/to/repository"
                spellCheck={false}
              />
            </div>
            <Button type="button" size="sm" onClick={saveWorkspace} className="shrink-0 gap-1.5">
              <Check className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </label>

        <div className="mt-5 rounded-md border border-border/70 bg-background/30 p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <CircleDot className="h-3.5 w-3.5 text-status-pass" />
            Browser-local preference
          </div>
          <p className="mt-1.5 leading-5">This setting stays on this device and is applied when you open New session.</p>
        </div>
      </Surface>

      <Surface elevation="raised" className="min-w-0 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Linear queue</p>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Ticket className="h-4 w-4 text-primary" />
              Pick a ticket to start
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Read-only issues from one team, with Linear-style filters.</p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Linear team key"
              value={team}
              onChange={(event) => setTeam(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadTickets();
              }}
              className="h-8 w-24 text-xs uppercase"
              placeholder="TEAM"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void loadTickets()} disabled={loading} className="gap-1.5">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {loaded ? "Refresh" : "Load tickets"}
            </Button>
          </div>
        </div>

        {loaded && (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-y border-border/70 py-3">
            <div className="relative min-w-[190px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 pl-8 text-xs" placeholder="Search tickets…" />
            </div>
            <div className="relative">
              <SlidersHorizontal className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 appearance-none rounded-md border border-input bg-transparent pl-8 pr-8 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring">
                <option value="">Any status</option>
                {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <div className="relative">
              <select value={label} onChange={(event) => setLabel(event.target.value)} className="h-8 appearance-none rounded-md border border-input bg-transparent px-3 pr-8 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring">
                <option value="">Any label</option>
                {labels.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <span className="ml-auto text-[11px] text-muted-foreground">{visibleTickets.length} of {tickets.length}</span>
          </div>
        )}

        {error && <div className="mt-4 rounded-md border border-status-fail/30 bg-status-fail/10 px-3 py-2 text-xs leading-5 text-status-fail">{error}</div>}
        {notice && !error && <div className="mt-4 rounded-md border border-status-parked/30 bg-status-parked/10 px-3 py-2 text-xs leading-5 text-status-parked">{notice}</div>}

        {!loaded ? (
          <div className="mt-5 rounded-md border border-dashed border-border/80 px-4 py-8 text-center">
            <Ticket className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">Load your team&apos;s tickets</p>
            <p className="mt-1 text-xs text-muted-foreground">Enter a Linear team key above. The connection is read-only.</p>
          </div>
        ) : visibleTickets.length === 0 ? (
          <div className="mt-5 rounded-md border border-dashed border-border/80 px-4 py-8 text-center text-xs text-muted-foreground">
            No tickets match these filters.
          </div>
        ) : (
          <div className="mt-4 max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
            {visibleTickets.map((ticket) => (
              <button key={ticket.id} type="button" onClick={() => startFromTicket(ticket)} className="group w-full rounded-md border border-transparent px-3 py-3 text-left transition-colors hover:border-border hover:bg-accent/60">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0 font-mono text-[11px] text-primary">{ticket.identifier}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{ticket.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {ticket.status && <span className="rounded-full bg-muted px-2 py-0.5">{ticket.status}</span>}
                      {ticket.priority && <span>{ticket.priority}</span>}
                      {ticket.assignee && <span>· {ticket.assignee}</span>}
                      {ticket.labels.slice(0, 2).map((item) => <span key={item} className="rounded-full border border-border px-2 py-0.5">{item}</span>)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">Start session →</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Surface>
    </section>
  );
}
