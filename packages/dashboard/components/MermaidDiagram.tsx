"use client";

import dynamic from "next/dynamic";

/**
 * Public entry point for rendering a plan's Mermaid diagram. The actual
 * mermaid-importing code lives in `./mermaid/MermaidDiagramClient` and is
 * loaded ONLY via this `next/dynamic(..., { ssr: false })` call -- keeping
 * mermaid's ~952 KiB gzip bundle out of both the server render and the
 * initial client payload of every route that doesn't render a diagram.
 * Verify with `pnpm --filter @pros/dashboard build` output that mermaid
 * lands in its own chunk, not the shared/initial one.
 */
const MermaidDiagramClient = dynamic(() => import("./mermaid/MermaidDiagramClient"), {
  ssr: false,
  loading: () => <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">Loading diagram renderer…</div>,
});

export interface MermaidDiagramProps {
  source: string;
  diagramId: string;
}

export function MermaidDiagram({ source, diagramId }: MermaidDiagramProps) {
  return <MermaidDiagramClient source={source} diagramId={diagramId} />;
}
