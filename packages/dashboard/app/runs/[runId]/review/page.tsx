import { getRunsRoot, getIndexDbPath } from "../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../lib/db";
import {
  parseLatestEventOfKind,
  getWorktreeInfo,
  computeReviewData,
  type VerifyVerdictPayload,
  type ReviewCompletedPayload,
  type PrCreatedPayload,
} from "../../../../lib/review-data";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const runsRoot = getRunsRoot();
  const dbPath = getIndexDbPath();

  const { db } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let worktree, verdict, review, prCreated;
  try {
    worktree = getWorktreeInfo(db, runId);
    verdict = parseLatestEventOfKind<VerifyVerdictPayload>(db, runId, "verify_verdict");
    review = parseLatestEventOfKind<ReviewCompletedPayload>(db, runId, "review_completed");
    prCreated = parseLatestEventOfKind<PrCreatedPayload>(db, runId, "pr_created");
  } finally {
    db.close();
  }

  const backLink = (
    <p>
      <a href={`/runs/${encodeURIComponent(runId)}`}>&larr; run overview</a>
    </p>
  );

  // Case 1: Gate 2 hasn't started for this run at all.
  if (!worktree) {
    return (
      <div>
        {backLink}
        <h1>Review for run {runId}</h1>
        <p>No implementation/PR yet for this run.</p>
      </div>
    );
  }

  const unresolvedBlockers: string[] = review ? safeParseArray<string>(review.unresolvedBlockersJson) : [];

  // Case 2: worktree exists but no PR yet (verification may have failed, or
  // review found blockers -- either way, per the M3/M5 "never look healthy"
  // invariant, we show whatever verdict/review we DO have, including a
  // failing one, rather than hiding it behind a generic "in progress".
  if (!prCreated) {
    return (
      <div>
        {backLink}
        <h1>Review for run {runId}</h1>
        <p>No PR has been opened yet for this run's implementation.</p>

        {verdict && (
          <p>
            Verification: <span className={`badge ${verdict.outcome === "pass" ? "pass" : "fail"}`}>{verdict.outcome}</span>{" "}
            -- {verdict.summary}
          </p>
        )}
        {!verdict && <p>No verification verdict recorded yet.</p>}

        {review && (
          <p>
            Review: <span className={`badge ${review.verdict === "approve" ? "pass" : "fail"}`}>{review.verdict}</span>
          </p>
        )}

        {unresolvedBlockers.length > 0 && (
          <div className="warning-banner">
            <div>Unresolved blocker(s):</div>
            <ul>
              {unresolvedBlockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // Case 3: full case -- a PR exists. Rank hunks against repoRoot (the
  // ORIGINAL parent repo), never worktreePath -- see the detailed comment
  // in lib/review-data.ts's ComputeReviewDataOptions for why this is
  // correct even after the worktree directory itself has been reaped.
  let riskRankedDiff, checklist;
  try {
    ({ riskRankedDiff, checklist } = computeReviewData({
      repoRoot: worktree.repoRoot,
      baseSha: worktree.baseSha ?? prCreated.headSha,
      headSha: prCreated.headSha,
      verdict,
      review,
    }));
  } catch (err) {
    // rankHunks shells out to real git -- if the recorded shas are somehow
    // no longer resolvable (e.g. repoRoot itself was deleted), don't crash
    // the whole page; surface the failure plainly instead.
    return (
      <div>
        {backLink}
        <h1>Review for run {runId}</h1>
        <div className="error-banner">
          Could not compute the risk-ranked diff for this PR: {err instanceof Error ? err.message : String(err)}
        </div>
      </div>
    );
  }

  return (
    <div>
      {backLink}
      <h1>Review for run {runId}</h1>

      <h2>
        PR{" "}
        <a href={prCreated.url} target="_blank" rel="noreferrer">
          #{prCreated.number}
        </a>
      </h2>
      <p>
        {/* There is no separately-recorded free-text "why" paragraph in
            this milestone's data model (see docs/03-architecture.md's
            "Intent + risk badge -- one paragraph on why"). Rather than
            invent prose the model never actually produced, we label the
            closest honest substitute plainly: the verification summary.
            This gap (no recorded free-text "why" paragraph exists yet) is
            intentional -- see the final report for this milestone's
            deviations from the brief; the brief's Definition of Done
            forbids touching any docs file from this change. */}
        Verification summary: {verdict ? verdict.summary : "(no verification verdict recorded)"}
      </p>

      <p>
        {verdict && (
          <>
            Verification: <span className={`badge ${verdict.outcome === "pass" ? "pass" : "fail"}`}>{verdict.outcome}</span>{" "}
          </>
        )}
        {review && (
          <>
            Review: <span className={`badge ${review.verdict === "approve" ? "pass" : "fail"}`}>{review.verdict}</span>
          </>
        )}
      </p>

      {unresolvedBlockers.length > 0 && (
        <div className="warning-banner">
          <div>Unresolved blocker(s) -- a human must look closely:</div>
          <ul>
            {unresolvedBlockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      <h2>
        Risk-ranked hunks ({riskRankedDiff.hunks.length} across {riskRankedDiff.totalFiles} file(s), +
        {riskRankedDiff.totalAddedLines}/-{riskRankedDiff.totalRemovedLines})
      </h2>
      {riskRankedDiff.hunks.length === 0 ? (
        <p>No hunks in this diff.</p>
      ) : (
        riskRankedDiff.hunks.map((hunk, i) => {
          const heading = (
            <>
              <strong>{hunk.file}</strong> (+{hunk.addedLines}/-{hunk.removedLines}, risk score {hunk.riskScore})
              {hunk.riskFactors.length > 0 && (
                <ul>
                  {hunk.riskFactors.map((f, fi) => (
                    <li key={fi}>{f}</li>
                  ))}
                </ul>
              )}
              <pre className="plan-markdown">{hunk.patchText}</pre>
            </>
          );
          return hunk.collapsedByDefault ? (
            <details key={i}>
              <summary>
                {hunk.file} (+{hunk.addedLines}/-{hunk.removedLines}) -- collapsed by default
              </summary>
              {heading}
            </details>
          ) : (
            <div key={i}>{heading}</div>
          );
        })
      )}

      <h2>Focus checklist ({checklist.length})</h2>
      {checklist.length === 0 ? (
        <p>Nothing flagged.</p>
      ) : (
        <ul>
          {checklist.map((item, i) => (
            <li key={i}>
              <strong>[{item.category}]</strong> {item.description} -- <code>{item.file}{item.line !== undefined ? `:${item.line}` : ""}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function safeParseArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
