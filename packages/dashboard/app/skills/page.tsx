import { getSkillrankOutDir, loadSkillProposals, type SkillProposalRecord } from "../../lib/skillrank-data";

export const dynamic = "force-dynamic";

/**
 * The skillrank proposals page (M7). Purely informational: it renders
 * ranked skill suggestions mined from local evidence, for human review
 * only. Per the product principle backing @pros/skillrank, proposals are
 * NEVER auto-installed -- there is no mechanism anywhere that changes
 * `status` away from "proposed". This page must stay provably read-only
 * by inspection: no form element, no click/submit handlers, no
 * fetch/mutation, no client component. See test/skillrank-data.test.ts's
 * static-inspection test.
 */
export default function SkillsPage() {
  const outDir = getSkillrankOutDir();
  const { available, generatedAt, installedSlugs, proposals } = loadSkillProposals(outDir);

  if (!available) {
    return (
      <div>
        <h1>Skills</h1>
        <p>No skill proposals yet. Run `pnpm --filter @pros/skillrank run` to generate them.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Skills</h1>
      {generatedAt && <p>Generated at: {generatedAt}</p>}
      <p>
        These are ranked skill suggestions, surfaced for human review only. Nothing on this page can install,
        accept, or dismiss a proposal -- every proposal below stays in "proposed" state until a human acts on it
        elsewhere.
      </p>
      <p>Already installed ({installedSlugs.length}): {installedSlugs.length > 0 ? installedSlugs.join(", ") : "none"}</p>

      <h2>Proposed skills ({proposals.length})</h2>
      {proposals.length === 0 ? (
        <p>No proposals -- either nothing new matches your usage, or everything relevant is already installed.</p>
      ) : (
        proposals.map((p) => <ProposalCard key={p.id} proposal={p} />)
      )}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: SkillProposalRecord }) {
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
        <strong>
          {proposal.name} <span style={{ color: "#888", fontWeight: "normal" }}>({proposal.slug})</span>
        </strong>
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
          Proposed -- nothing installs automatically
        </span>
      </div>
      <p>{proposal.reason}</p>
      <p>Score: {proposal.score}</p>
      {proposal.matchedKeywords.length > 0 && (
        <p>Matched keywords: {proposal.matchedKeywords.join(", ")}</p>
      )}
    </div>
  );
}
