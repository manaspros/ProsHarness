"use client";

import { useEffect, useRef, useState } from "react";

/**
 * MermaidDiagramClient -- the actual Mermaid-touching implementation.
 *
 * Only ever reached via `next/dynamic(..., { ssr: false })` from
 * `../MermaidDiagram.tsx`, so `import("mermaid")` below (and mermaid's
 * ~952 KiB gzip bundle: d3, dagre/ELK, cytoscape, KaTeX) lands in its own
 * webpack chunk, fetched only on a route that actually renders a diagram --
 * never in the initial dashboard payload.
 *
 * SECURITY -- this file renders LLM-GENERATED Mermaid source, which is
 * therefore untrusted input. Mermaid's own advisory history includes
 * multiple CRITICAL/HIGH XSS and prototype-pollution CVEs against its
 * built-in sanitizer (see docs/00-decisions.md for the specific CVE list
 * checked before pinning the version below). `securityLevel: "strict"` is
 * necessary but NOT assumed sufficient -- defense in depth, because the
 * sanitizer is exactly the thing with a track record of being bypassed:
 *
 *   1. `mermaid.render` runs here, off the initial bundle, with
 *      `securityLevel: "strict"` and a render TIMEOUT and a SIZE bound on
 *      the source text (both DoS advisories are real and the source is
 *      model-generated, not human-authored).
 *   2. The resulting SVG string -- not the diagram source, the OUTPUT -- is
 *      handed to a `<iframe sandbox="" srcDoc={...}>` with an EMPTY sandbox
 *      attribute: no allow-scripts, no allow-same-origin, no allow-forms,
 *      no allow-popups, no allow-top-navigation. Even if step 1's
 *      sanitizer were bypassed and the SVG carries an embedded <script> or
 *      an onload/onerror handler, an empty-sandbox iframe does not execute
 *      script at all, and has no origin it could use to reach this app's
 *      cookies, storage, or API even if it somehow did.
 */

const MAX_DIAGRAM_SOURCE_LENGTH = 20_000;
const RENDER_TIMEOUT_MS = 5_000;

export interface MermaidDiagramClientProps {
  source: string;
  /** Stable id fragment so multiple diagrams on one page don't collide inside mermaid's internal id-based DOM bookkeeping. */
  diagramId: string;
}

type RenderState =
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "too_large" }
  | { status: "error"; message: string };

/**
 * Reads this app's actual current theme tokens (app/globals.css's HSL
 * custom properties) at render time, rather than baking one theme's colors
 * into this file -- so Mermaid's palette always follows whatever the
 * dashboard is actually themed as right now, light or dark, without this
 * component needing to know which.
 */
function readThemeVariables(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  const hsl = (name: string, fallback: string) => {
    const raw = style.getPropertyValue(name).trim();
    return raw ? `hsl(${raw.replace(/\s*\/\s*[\d.]+$/, "")})` : fallback;
  };
  return {
    background: hsl("--surface-raised", "#0b0a1f"),
    primaryColor: hsl("--accent", "#3d2c8d"),
    primaryTextColor: hsl("--foreground", "#e5e0f5"),
    primaryBorderColor: hsl("--border", "#3d2c8d"),
    lineColor: hsl("--muted-foreground", "#9a94b8"),
    secondaryColor: hsl("--secondary", "#1c1a3a"),
    tertiaryColor: hsl("--muted", "#151330"),
    textColor: hsl("--foreground", "#e5e0f5"),
    fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
  };
}

/**
 * Wraps a rendered SVG string into the exact HTML handed to the sandboxed
 * iframe's `srcDoc`. Pure and exported so the sandboxing mechanism itself
 * (not just "does it look right") is unit-testable without a real DOM or a
 * mermaid render: packages/dashboard/test/mermaid-sandbox.test.ts feeds
 * this function a payload shaped like the mermaid CVE patterns referenced
 * in this file's doc comment and asserts it comes back untouched, inert
 * text -- this function does not parse, evaluate, or strip anything, it
 * only wraps. The actual XSS defense is structural (empty `sandbox`
 * attribute on the iframe element in the JSX below, never a token added
 * here), not something this function could accidentally weaken.
 */
export function buildSandboxedSrcDoc(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:8px;background:transparent;overflow:auto}svg{max-width:100%;height:auto;display:block}</style></head><body>${svg}</body></html>`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mermaid render exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export default function MermaidDiagramClient({ source, diagramId }: MermaidDiagramClientProps) {
  const [state, setState] = useState<RenderState>({ status: "loading" });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    if (source.length > MAX_DIAGRAM_SOURCE_LENGTH) {
      setState({ status: "too_large" });
      return;
    }

    (async () => {
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: readThemeVariables(),
        });
        const { svg } = await withTimeout(mermaid.render(`mermaid-${diagramId}`, source), RENDER_TIMEOUT_MS);
        if (!cancelledRef.current) setState({ status: "ok", svg });
      } catch (err) {
        if (!cancelledRef.current) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [source, diagramId]);

  if (state.status === "loading") {
    return <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">Rendering diagram…</div>;
  }
  if (state.status === "too_large") {
    return (
      <div className="rounded-md border border-border bg-surface-base/60 p-3 text-xs text-muted-foreground">
        Diagram source is too large to render safely ({source.length} chars, limit {MAX_DIAGRAM_SOURCE_LENGTH}).
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="rounded-md border border-border bg-surface-base/60 p-3 text-xs text-muted-foreground">
        Diagram could not be rendered: {state.message}
      </div>
    );
  }

  // sandbox="" (no tokens) is intentional -- see this file's doc comment.
  // The iframe's height is fixed by a wrapping element outside; the srcDoc
  // itself sizes its own SVG to the viewport it's given.
  return (
    <iframe
      title="Plan diagram"
      sandbox=""
      srcDoc={buildSandboxedSrcDoc(state.svg)}
      className="h-64 w-full rounded-md border border-border bg-surface-base/40 sm:h-80"
    />
  );
}
