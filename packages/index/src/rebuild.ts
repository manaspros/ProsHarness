/**
 * Rebuild the SQLite index from the on-disk sources of truth: each run's
 * journal.ndjson (via @pros/barrier's Journal.read) and each run's
 * attempts/<attemptId>/raw.log files. No other input is consulted -- this
 * is the whole point of "SQLite is a rebuildable index, nothing more"
 * (docs/03-architecture.md).
 *
 * Rebuild strategy: delete-and-recreate the db file fresh on every call,
 * then repopulate from scratch. "Rebuildable" is read here as "starting
 * from a clean index", not "merge with whatever was there before" -- a
 * stale row left behind by a run that no longer exists on disk would
 * otherwise linger forever with no way to prove it's stale.
 *
 * Deviation from a literal reading of the task spec: rebuildIndex is async
 * (`Promise<RebuildReport>`), not sync. @pros/barrier's `Journal.read` is
 * itself async (it reads via node:fs/promises and must be, to share the
 * cross-process journal lock machinery M1 built) -- and re-deriving the
 * journal's binary length/checksum framing here to read it synchronously
 * would violate the explicit constraint of using Journal.read as the *only*
 * way to read journal data. Making this function async is the honest
 * choice; better-sqlite3's own calls inside it remain synchronous.
 *
 * Known-event-type lists (used to classify raw.log lines as parse_status
 * "ok" vs "unknown_type"): a small, independent re-implementation, not a
 * call into packages/adapters -- the index must be derivable from raw text
 * alone, without depending on that package's parser.
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Journal, type JournalEntry } from "@pros/barrier";
import { SCHEMA_SQL } from "./schema.js";

const CLAUDE_EVENT_TYPES = new Set(["rate_limit_event", "system", "assistant", "user", "result"]);
const CODEX_EVENT_TYPES = new Set(["thread.started", "turn.started", "item.completed", "turn.completed"]);
const KNOWN_EVENT_TYPES = new Set([...CLAUDE_EVENT_TYPES, ...CODEX_EVENT_TYPES]);

export type ParseStatus = "ok" | "unknown_type" | "malformed";

export interface RawLogParseIssue {
  runId: string;
  attemptId: string;
  seq: number;
  status: ParseStatus;
}

export interface RebuildReport {
  runsProcessed: number;
  truncatedRuns: string[];
  rawEventsInserted: number;
  eventsInserted: number;
  plansInserted: number;
  objectionsInserted: number;
  findingsInserted: number;
  worktreesInserted: number;
  /** Non-"ok" raw.log lines encountered -- useful for a human/test to inspect, not just count. */
  rawLogParseIssues: RawLogParseIssue[];
}

function classifyLine(line: string): { status: ParseStatus; ts: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { status: "malformed", ts: null };
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  let typeField: string | undefined;
  if (obj) {
    if (typeof obj["type"] === "string") typeField = obj["type"] as string;
    else if (typeof obj["kind"] === "string") typeField = obj["kind"] as string;
  }

  // Best-effort per-line timestamp: prefer a timestamp-shaped field inside
  // the parsed JSON itself (see rebuildIndex's doc comment for the
  // documented fallback to file mtime when this isn't present).
  let ts: string | null = null;
  if (obj) {
    for (const key of ["ts", "timestamp", "time"]) {
      const v = obj[key];
      if (typeof v === "string") {
        ts = v;
        break;
      }
    }
  }

  if (typeField && KNOWN_EVENT_TYPES.has(typeField)) return { status: "ok", ts };
  return { status: "unknown_type", ts };
}

interface WorktreeState {
  allocationId: string;
  repoRoot: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  fenceEpoch: number | null;
  state: string;
  reason: string | null;
}

interface PlanState {
  version: number;
  planId: string;
  markdown: string;
  structuredJson: string;
  state: string;
  unresolvedObjectionsJson: string | null;
  editedAt: string | null;
  editedBy: string | null;
}

export async function rebuildIndex(dbPath: string, runsRoot: string): Promise<RebuildReport> {
  if (existsSync(dbPath)) unlinkSync(dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);

  const report: RebuildReport = {
    runsProcessed: 0,
    truncatedRuns: [],
    rawEventsInserted: 0,
    eventsInserted: 0,
    plansInserted: 0,
    objectionsInserted: 0,
    findingsInserted: 0,
    worktreesInserted: 0,
    rawLogParseIssues: [],
  };

  const insertRawEvent = db.prepare(
    `INSERT OR IGNORE INTO raw_events (run_id, attempt_id, seq, ts, provider, cli_version, raw_text, parse_status)
     VALUES (@runId, @attemptId, @seq, @ts, @provider, @cliVersion, @rawText, @parseStatus)`,
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (run_id, raw_event_id, kind, role, tool_name, payload_json, is_unknown, seq)
     VALUES (@runId, NULL, @kind, NULL, NULL, @payloadJson, 0, @seq)`,
  );
  const insertFinding = db.prepare(
    `INSERT OR IGNORE INTO findings (run_id, finding_id, kind, title, evidence_json)
     VALUES (@runId, @findingId, @kind, @title, @evidenceJson)`,
  );
  const insertObjection = db.prepare(
    `INSERT INTO objections (plan_id, run_id, round, author, severity, claim, suggested_change, resolution)
     VALUES (@planId, @runId, @round, @author, @severity, @claim, @suggestedChange, @resolution)`,
  );
  const insertPlan = db.prepare(
    `INSERT OR IGNORE INTO plans (run_id, plan_id, version, markdown, structured_json, state, unresolved_objections_json, edited_at, edited_by)
     VALUES (@runId, @planId, @version, @markdown, @structuredJson, @state, @unresolvedObjectionsJson, @editedAt, @editedBy)`,
  );
  const insertWorktree = db.prepare(
    `INSERT OR IGNORE INTO worktrees (run_id, allocation_id, repo_root, worktree_path, branch, base_sha, fence_epoch, state, reason)
     VALUES (@runId, @allocationId, @repoRoot, @worktreePath, @branch, @baseSha, @fenceEpoch, @state, @reason)`,
  );

  function indexJournalEntries(runId: string, entries: JournalEntry[]): void {
    const worktrees = new Map<string, WorktreeState>();
    const plans = new Map<number, PlanState>();

    const tx = db.transaction(() => {
      for (const entry of entries) {
        insertEvent.run({ runId, kind: entry.kind, payloadJson: JSON.stringify(entry), seq: entry.seq });
        report.eventsInserted++;

        switch (entry.kind) {
          case "finding_recorded": {
            insertFinding.run({
              runId,
              findingId: entry.findingId,
              kind: "finding",
              title: entry.title,
              evidenceJson: entry.evidenceJson,
            });
            report.findingsInserted++;
            break;
          }
          case "plan_drafted": {
            plans.set(entry.version, {
              version: entry.version,
              planId: entry.planId,
              markdown: entry.markdown,
              structuredJson: entry.structuredJson,
              state: "drafted",
              unresolvedObjectionsJson: null,
              editedAt: null,
              editedBy: null,
            });
            break;
          }
          case "plan_revised": {
            plans.set(entry.version, {
              version: entry.version,
              planId: entry.planId,
              markdown: entry.markdown,
              structuredJson: entry.structuredJson,
              state: "revised",
              unresolvedObjectionsJson: null,
              editedAt: null,
              editedBy: null,
            });
            break;
          }
          case "plan_finalized": {
            const existing = plans.get(entry.version);
            if (existing) {
              existing.state = "finalized";
              existing.unresolvedObjectionsJson = entry.unresolvedObjectionsJson;
            } else {
              // Out-of-order/partial journal: finalized referenced a version
              // we never saw drafted/revised. Record what we have rather
              // than silently drop it.
              plans.set(entry.version, {
                version: entry.version,
                planId: entry.planId,
                markdown: "",
                structuredJson: "{}",
                state: "finalized",
                unresolvedObjectionsJson: entry.unresolvedObjectionsJson,
                editedAt: null,
                editedBy: null,
              });
            }
            break;
          }
          case "plan_edited": {
            const existing = plans.get(entry.version);
            if (existing) {
              existing.markdown = entry.markdown;
              existing.editedAt = entry.ts;
              existing.editedBy = entry.editedBy;
            } else {
              // Out-of-order journal, same defensive pattern as
              // plan_finalized above: an edit referenced a version we never
              // saw drafted/revised. Record what we have rather than
              // silently drop it.
              plans.set(entry.version, {
                version: entry.version,
                planId: entry.planId,
                markdown: entry.markdown,
                structuredJson: "{}",
                state: "edited",
                unresolvedObjectionsJson: null,
                editedAt: entry.ts,
                editedBy: entry.editedBy,
              });
            }
            break;
          }
          case "critique_objections": {
            let parsed: { objections?: unknown[] } = {};
            try {
              parsed = JSON.parse(entry.objectionsJson);
            } catch {
              parsed = {};
            }
            const objections = Array.isArray(parsed.objections) ? parsed.objections : [];
            for (const o of objections) {
              const obj = (o ?? {}) as Record<string, unknown>;
              insertObjection.run({
                planId: entry.planId,
                runId,
                round: entry.round,
                // Codex is the critique role in this architecture: independent
                // critique + objections always originate from Codex, never
                // from the planning agent itself.
                author: "codex",
                severity: typeof obj["severity"] === "string" ? obj["severity"] : null,
                claim: typeof obj["claim"] === "string" ? obj["claim"] : null,
                suggestedChange: typeof obj["suggested_change"] === "string" ? obj["suggested_change"] : null,
                resolution: typeof obj["resolution"] === "string" ? obj["resolution"] : null,
              });
              report.objectionsInserted++;
            }
            break;
          }
          case "worktree_intent": {
            worktrees.set(entry.allocationId, {
              allocationId: entry.allocationId,
              repoRoot: entry.repoRoot,
              worktreePath: entry.worktreePath,
              branch: entry.branch,
              baseSha: null,
              fenceEpoch: entry.fenceEpoch,
              state: "intent",
              reason: null,
            });
            break;
          }
          case "worktree_allocated": {
            const existing = worktrees.get(entry.allocationId);
            const base: WorktreeState = existing ?? {
              allocationId: entry.allocationId,
              repoRoot: null,
              worktreePath: entry.worktreePath,
              branch: entry.branch,
              baseSha: null,
              fenceEpoch: entry.fenceEpoch,
              state: "intent",
              reason: null,
            };
            base.worktreePath = entry.worktreePath;
            base.branch = entry.branch;
            base.baseSha = entry.baseSha;
            base.fenceEpoch = entry.fenceEpoch;
            base.state = "allocated";
            worktrees.set(entry.allocationId, base);
            break;
          }
          case "worktree_confirmed": {
            const existing = worktrees.get(entry.allocationId);
            if (existing) existing.state = "confirmed";
            else
              worktrees.set(entry.allocationId, {
                allocationId: entry.allocationId,
                repoRoot: null,
                worktreePath: null,
                branch: null,
                baseSha: null,
                fenceEpoch: entry.fenceEpoch,
                state: "confirmed",
                reason: null,
              });
            break;
          }
          case "worktree_rollback": {
            const existing = worktrees.get(entry.allocationId);
            if (existing) {
              existing.state = "rolled_back";
              existing.reason = entry.reason;
            } else
              worktrees.set(entry.allocationId, {
                allocationId: entry.allocationId,
                repoRoot: null,
                worktreePath: null,
                branch: null,
                baseSha: null,
                fenceEpoch: entry.fenceEpoch,
                state: "rolled_back",
                reason: entry.reason,
              });
            break;
          }
          default:
            // Every other JournalEntry kind (attempt_started, checkpoint_*,
            // fence_bumped, etc.) is already fully captured by the generic
            // `events` row inserted above; no dedicated table needed.
            break;
        }
      }

      for (const plan of plans.values()) {
        insertPlan.run({
          runId,
          planId: plan.planId,
          version: plan.version,
          markdown: plan.markdown,
          structuredJson: plan.structuredJson,
          state: plan.state,
          unresolvedObjectionsJson: plan.unresolvedObjectionsJson,
          editedAt: plan.editedAt,
          editedBy: plan.editedBy,
        });
        report.plansInserted++;
      }
      for (const wt of worktrees.values()) {
        insertWorktree.run({
          runId,
          allocationId: wt.allocationId,
          repoRoot: wt.repoRoot,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseSha: wt.baseSha,
          fenceEpoch: wt.fenceEpoch,
          state: wt.state,
          reason: wt.reason,
        });
        report.worktreesInserted++;
      }
    });
    tx();
  }

  // Raw attempt transport logs: attempts/<attemptId>/raw.log, one line of
  // verbatim raw text per event. Provider/cli_version are not encoded in
  // the raw.log path itself, so we look for optional sidecar files written
  // alongside it -- attempts/<attemptId>/provider.txt and
  // attempts/<attemptId>/cli_version.txt. This is a documented convention
  // this package expects; if packages/adapters doesn't write those
  // sidecars, provider falls back to "unknown" and cli_version to null,
  // which is safe (raw_text is still preserved verbatim either way).
  function indexRawLogs(runId: string, runDir: string): void {
    const attemptsDir = path.join(runDir, "attempts");
    if (!existsSync(attemptsDir)) return;

    for (const attemptEnt of readdirSync(attemptsDir, { withFileTypes: true })) {
      if (!attemptEnt.isDirectory()) continue;
      const attemptId = attemptEnt.name;
      const attemptDir = path.join(attemptsDir, attemptId);
      const rawLogPath = path.join(attemptDir, "raw.log");
      if (!existsSync(rawLogPath)) continue;

      const providerPath = path.join(attemptDir, "provider.txt");
      const provider = existsSync(providerPath) ? readFileSync(providerPath, "utf8").trim() : "unknown";
      const cliVersionPath = path.join(attemptDir, "cli_version.txt");
      const cliVersion = existsSync(cliVersionPath) ? readFileSync(cliVersionPath, "utf8").trim() : null;

      // KNOWN LIMITATION: raw.log is plain newline-delimited text, not
      // JSONL-with-a-timestamp-envelope, so there is no reliable per-line
      // timestamp in the general case. We use a best-effort ts/timestamp
      // field found inside a line that does parse as JSON, and otherwise
      // fall back to the raw.log file's mtime -- the SAME fallback value
      // for every line in the file, i.e. not a real per-event clock. A
      // future adapters revision that wraps each raw line with a
      // receive-time envelope would let this be exact; until then this is
      // a documented approximation, not a silent one.
      const fileMtime = statSync(rawLogPath).mtime.toISOString();

      const raw = readFileSync(rawLogPath, "utf8");
      // Split on newlines; drop a single trailing empty element produced by
      // a well-formed trailing "\n" -- but keep a genuinely truncated final
      // fragment (no trailing newline) as its own line, since that is
      // exactly the "process killed mid-write" case we must not drop.
      let lines = raw.split("\n");
      if (raw.endsWith("\n")) lines = lines.slice(0, -1);

      lines.forEach((line, seq) => {
        const { status, ts } = classifyLine(line);
        db.transaction(() => {
          insertRawEvent.run({
            runId,
            attemptId,
            seq,
            ts: ts ?? fileMtime,
            provider,
            cliVersion,
            rawText: line,
            parseStatus: status,
          });
        })();
        report.rawEventsInserted++;
        if (status !== "ok") {
          report.rawLogParseIssues.push({ runId, attemptId, seq, status });
        }
      });
    }
  }

  const runEntries = existsSync(runsRoot) ? readdirSync(runsRoot, { withFileTypes: true }) : [];
  for (const dirEnt of runEntries) {
    if (!dirEnt.isDirectory()) continue;
    const runId = dirEnt.name;
    const runDir = path.join(runsRoot, runId);

    const { entries, truncated } = await Journal.read(runDir);
    if (truncated) report.truncatedRuns.push(runId);

    indexJournalEntries(runId, entries);
    indexRawLogs(runId, runDir);

    report.runsProcessed++;
  }

  db.prepare(
    `INSERT INTO _index_meta (key, value) VALUES ('last_rebuild_at', @ts)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ ts: new Date().toISOString() });

  db.close();
  return report;
}
