import { Wrench } from "lucide-react";

import { getSkillrankOutDir, loadSkillProposals, type SkillProposalRecord } from "../../lib/skillrank-data";
import { SectionHeading } from "../../components/SectionHeading";
import { Surface } from "../../components/Surface";
import { EmptyState } from "../../components/EmptyState";
import { RegenerateAction } from "../../components/RegenerateAction";

export const dynamic = "force-dynamic";

/**
 * The skillrank proposals page (M7). Purely informational: it renders
 * ranked skill suggestions mined from local evidence, for human review only.
 * Regeneration is delegated to a small client action; this server page has
 * no proposal application or installation behavior. Proposals are NEVER
 * auto-installed -- there is no mechanism anywhere that changes `status`
 * away from "proposed".
 */
export default function SkillsPage() {
  const outDir = getSkillrankOutDir();
  const { available, generatedAt, installedSlugs, proposals } = loadSkillProposals(outDir);

  if (!available) {
    return (
      <div className="space-y-6">
        <SectionHeading title="Skills" />
        <Surface elevation="raised">
          <EmptyState
            icon={<Wrench className="h-8 w-8" />}
            title="No skill proposals yet"
            description={
              <>
                Generate proposals from your local skill lock and mined vocabulary. This only creates suggestions;
                it never installs anything or changes <code>skill-registry-lock.json</code>.
              </>
            }
            action={<RegenerateAction kind="skillrank" />}
          />
        </Surface>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Skills"
        action={<RegenerateAction kind="skillrank" compact />}
        description={
          <>
            {generatedAt && <>Generated at: {generatedAt}. </>}
            These are ranked skill suggestions, surfaced for human review only. Nothing on this page can install,
            accept, or dismiss a proposal -- every proposal below stays in &quot;proposed&quot; state until a human
            acts on it elsewhere.
            <br />
            Already installed ({installedSlugs.length}): {installedSlugs.length > 0 ? installedSlugs.join(", ") : "none"}
          </>
        }
      />

      <section className="space-y-3">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">Proposed skills ({proposals.length})</h3>
        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No proposals -- either nothing new matches your usage, or everything relevant is already installed.
          </p>
        ) : (
          <div className="space-y-4">
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: SkillProposalRecord }) {
  return (
    <Surface elevation="raised" className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm font-semibold text-foreground">
          {proposal.name} <span className="font-normal text-muted-foreground">({proposal.slug})</span>
        </strong>
        <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
          Proposed -- nothing installs automatically
        </span>
      </div>
      <p className="text-sm text-foreground/90">{proposal.reason}</p>
      <p className="text-xs text-muted-foreground">Score: {proposal.score}</p>
      {proposal.matchedKeywords.length > 0 && (
        <p className="text-xs text-muted-foreground">Matched keywords: {proposal.matchedKeywords.join(", ")}</p>
      )}
    </Surface>
  );
}
