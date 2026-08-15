import { Repeat, Sparkles } from "lucide-react";

import { getMinerOutDir, loadProposals, groupProposalsByKind, type LoopProposal } from "../../lib/loops-data";
import { SectionHeading } from "../../components/SectionHeading";
import { Surface } from "../../components/Surface";
import { EmptyState } from "../../components/EmptyState";

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
      <div className="space-y-6">
        <SectionHeading title="Loops" />
        <Surface elevation="raised">
          <EmptyState
            icon={<Repeat className="h-8 w-8" />}
            title="No mined proposals yet"
            description="Run `pnpm --filter @pros/miner mine` to generate them."
          />
        </Surface>
      </div>
    );
  }

  const { workflows, preferences } = groupProposalsByKind(proposals);

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Loops"
        description={
          <>
            {generatedAt && <>Generated at: {generatedAt}. </>}
            These are mined proposals, surfaced for human review only. Nothing on this page can apply, accept, or
            dismiss a proposal -- every proposal below stays in &quot;proposed&quot; state until a human acts on it
            elsewhere.
          </>
        }
      />

      <section className="space-y-3">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">Recurring workflows ({workflows.length})</h3>
        {workflows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recurring workflow proposals.</p>
        ) : (
          <div className="space-y-4">
            {workflows.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">Preference signals ({preferences.length})</h3>
        {preferences.length === 0 ? (
          <p className="text-sm text-muted-foreground">No preference-signal proposals.</p>
        ) : (
          <div className="space-y-4">
            {preferences.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: LoopProposal }) {
  return (
    <Surface elevation="raised" className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm font-semibold text-foreground">{proposal.name}</strong>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
          <Sparkles className="h-3 w-3" /> Proposed -- not applied automatically
        </span>
      </div>
      <p className="text-sm text-foreground/90">{proposal.evidenceSummary}</p>
      <p className="text-xs text-muted-foreground">
        Sessions: {proposal.sessionCount} (gated: {proposal.gatedSessionCount})
      </p>
      {proposal.exampleQuotes.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-xs font-medium text-muted-foreground">Example quotes</div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/80">
            {proposal.exampleQuotes.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </Surface>
  );
}
