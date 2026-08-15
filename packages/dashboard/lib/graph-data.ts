/**
 * Thin, directly-testable seam over @pros/graph's buildSessionGraph, per
 * the M5 brief: "trivial, but gives you a stable seam + a place for a unit
 * test asserting the dashboard's own copy of this call works against a
 * real rebuilt index." buildSessionGraph itself is already fully tested in
 * packages/graph/test/graph.test.ts -- this file does not re-prove its
 * correctness, only the dashboard's own wiring (real db in, real
 * SessionGraph out).
 */
import type Database from "better-sqlite3";
import { buildSessionGraph } from "@pros/graph";
import type { GraphNode, SessionGraph } from "@pros/graph";

export function loadSessionGraph(db: Database.Database, runId: string): SessionGraph {
  return buildSessionGraph(db, runId);
}

/**
 * Display-formatting helper: groups nodes by attemptId, preserving the
 * original (seq-ordered) relative order within each group, and preserving
 * first-seen attempt order across groups -- convenient for rendering a
 * "grouped by attempt" timeline instead of one flat table.
 */
export function groupNodesByAttempt(nodes: GraphNode[]): Array<{ attemptId: string; nodes: GraphNode[] }> {
  const order: string[] = [];
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!groups.has(node.attemptId)) {
      groups.set(node.attemptId, []);
      order.push(node.attemptId);
    }
    groups.get(node.attemptId)!.push(node);
  }
  return order.map((attemptId) => ({ attemptId, nodes: groups.get(attemptId)! }));
}

/** True if any node in the graph is kind "unknown" -- drives the M3-style "never look healthy" warning banner on the graph page. */
export function hasUnknownNodes(graph: SessionGraph): boolean {
  return graph.nodes.some((n) => n.kind === "unknown");
}

/** Count of kind:"unknown" nodes, for the warning banner's message. */
export function countUnknownNodes(graph: SessionGraph): number {
  return graph.nodes.filter((n) => n.kind === "unknown").length;
}
