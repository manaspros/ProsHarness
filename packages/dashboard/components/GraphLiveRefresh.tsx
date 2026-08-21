"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * B9 piece 4's client half: subscribes to the SSE route
 * (app/api/runs/[runId]/graph/stream/route.ts) and asks Next.js to
 * re-fetch the server-rendered graph page whenever a new "graph" event
 * arrives with more nodes than last seen -- the page itself (a server
 * component) stays the single source of truth for how a node renders, so
 * this component does not duplicate that rendering logic, only tells it
 * when to re-run. `router.refresh()` re-executes the server component
 * (including its own fresh `rebuildAndOpenIndex` call) without a full page
 * reload or client-side state duplication.
 *
 * `EventSource` itself handles reconnect-on-drop by the browser's own
 * built-in retry; this component's own cleanup (closing the EventSource on
 * unmount) is what prevents a leaked connection when the user navigates
 * away from the graph page entirely.
 */
export function GraphLiveRefresh({ runId }: { runId: string }): null {
  const router = useRouter();
  const lastCountRef = React.useRef(-1);

  React.useEffect(() => {
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/graph/stream`);

    source.addEventListener("graph", (event) => {
      try {
        const graph = JSON.parse((event as MessageEvent<string>).data) as { nodes?: unknown[] };
        const count = Array.isArray(graph.nodes) ? graph.nodes.length : -1;
        if (count !== lastCountRef.current) {
          lastCountRef.current = count;
          router.refresh();
        }
      } catch {
        // Malformed SSE payload -- never let a live-refresh glitch break the page.
      }
    });

    source.addEventListener("done", () => {
      source.close();
    });

    // A dropped connection triggers the browser's own automatic
    // reconnect; nothing to do here beyond not treating it as fatal.
    source.onerror = () => undefined;

    return () => {
      source.close();
    };
  }, [runId, router]);

  return null;
}
