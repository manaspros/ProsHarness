import { getMinerOutDir, loadProposals, groupProposalsByKind, type LoopProposal } from "../../lib/loops-data";

export const dynamic = "force-dynamic";

/**
 * The learning-loop page (M6). This page is purely informational: it
 * renders proposals mined from the user's session history for human
 * review only. Per the product principle backing this page, proposals
 * are NEVER auto-applied -- there is no mechanism anywhere that changes
 * `status` away from "proposed". This page must stay provably read-only
 * by inspection: no form element, no click/submit handlers, no
 * fetch/mutation, no client component. See test/loops-data.test.ts's
 * static-inspection test.
 */
export default function LoopsPage() {
  const minerOutDir = getMinerOutDir();
  const { available, generatedAt, proposals } = loadProposals(minerOutDir);

  if (!available) {
    return (
      <div>
        <h1>Loops</h1>
        <p>No mined proposals yet. Run `pnpm --filter @pros/miner mine` to generate them.</p>
      </div>
    );
  }

  const { workflows, preferences } = groupProposalsByKind(proposals);

  return (
    <div>
      <h1>Loops</h1>
      {generatedAt && <p>Generated at: {generatedAt}</p>}
      <p>
        These are mined proposals, surfaced for human review only. Nothing on this page can apply, accept, or
        dismiss a proposal -- every proposal below stays in "proposed" state until a human acts on it elsewhere.
      </p>

      <h2>Recurring workflows ({workflows.length})</h2>
      {workflows.length === 0 ? <p>No recurring workflow proposals.</p> : workflows.map((p) => <ProposalCard key={p.id} proposal={p} />)}

      <h2>Preference signals ({preferences.length})</h2>
      {preferences.length === 0 ? (
        <p>No preference-signal proposals.</p>
      ) : (
        preferences.map((p) => <ProposalCard key={p.id} proposal={p} />)
      )}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: LoopProposal }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 4,
        padding: "12px 16px",
        marginBottom: 16,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{proposal.name}</strong>
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 10,
            fontSize: 12,
            fontWeight: "bold",
            background: "#eee",
            color: "#444",
            whiteSpace: "nowrap",
          }}
        >
          Proposed -- not applied automatically
        </span>
      </div>
      <p>{proposal.evidenceSummary}</p>
      <p>
        Sessions: {proposal.sessionCount} (gated: {proposal.gatedSessionCount})
      </p>
      {proposal.exampleQuotes.length > 0 && (
        <>
          <div>Example quotes:</div>
          <ul>
            {proposal.exampleQuotes.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
