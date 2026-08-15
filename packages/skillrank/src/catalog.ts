import type { SkillCandidate } from "./types.js";

/**
 * STATIC, BUNDLED, OFFLINE seed catalog of skill candidates.
 *
 * This is deliberately NOT a live registry query: skillrank must never hit
 * a network registry (no unattended nightly egress of local usage data, and
 * reproducible/deterministic tests). This is a small, hand-curated seed list
 * representative of the "skills landscape" research already done for this
 * project (see docs/02-research-findings.md section 5) plus a handful of
 * clearly-fictional-but-reasonable entries covering common dev workflows.
 * It is expected to be replaced/augmented by real registry integration in a
 * later milestone; until then it is the entire candidate universe.
 */
export const SKILL_CATALOG: SkillCandidate[] = [
  // Real prior art mentioned in docs/02-research-findings.md section 5.
  {
    slug: "obra/using-git-worktrees",
    name: "Using Git Worktrees",
    description: "Mechanics for managing multiple concurrent git worktrees, one per attached repo/branch.",
    source: "https://github.com/obra/superpowers/tree/main/skills/using-git-worktrees",
    keywords: ["git", "worktree", "branch"],
  },
  {
    slug: "rohitg00/parallel-worktrees",
    name: "Parallel Worktrees",
    description: "Running multiple agent sessions concurrently across parallel git worktrees.",
    source: "https://github.com/rohitg00/parallel-worktrees",
    keywords: ["worktree", "parallel", "concurrent"],
  },
  {
    slug: "rohitg00/batch-orchestration",
    name: "Batch Orchestration",
    description: "Orchestrating batches of agent tasks across parallel workers.",
    source: "https://github.com/rohitg00/batch-orchestration",
    keywords: ["batch", "orchestration", "parallel", "agent"],
  },
  {
    slug: "rohitg00/agent-teams",
    name: "Agent Teams",
    description: "Shared task list plus mailbox protocol for handoff between Claude Code sessions.",
    source: "https://github.com/rohitg00/agent-teams",
    keywords: ["agent", "mailbox", "handoff", "subagent"],
  },
  {
    slug: "obra/brainstorming",
    name: "Brainstorming",
    description: "Explores user intent, requirements, and design before implementation.",
    source: "https://github.com/obra/superpowers/tree/main/skills/brainstorming",
    keywords: ["brainstorm", "design", "requirements"],
  },
  // Fictional-but-plausible seed entries covering common dev workflows.
  // These are NOT real registry entries -- invented placeholders pending
  // real registry integration.
  {
    slug: "example/test-first-workflow",
    name: "Test-First Workflow",
    description: "Structured red-green-refactor loop for writing tests before implementation.",
    source: "https://example.invalid/skills/test-first-workflow",
    keywords: ["test", "vitest", "jest", "pytest", "spec"],
  },
  {
    slug: "example/docs-sync",
    name: "Docs Sync",
    description: "Keeps README/docs updated in lockstep with code changes.",
    source: "https://example.invalid/skills/docs-sync",
    keywords: ["docs", "readme", "markdown", "documentation"],
  },
  {
    slug: "example/code-review-checklist",
    name: "Code Review Checklist",
    description: "Structured checklist for reviewing diffs before requesting human review.",
    source: "https://example.invalid/skills/code-review-checklist",
    keywords: ["review", "diff", "pr", "lint"],
  },
  {
    slug: "example/deployment-runbook",
    name: "Deployment Runbook",
    description: "Step-by-step deploy/rollback runbook for common CI/CD pipelines.",
    source: "https://example.invalid/skills/deployment-runbook",
    keywords: ["deploy", "release", "ci", "rollback", "docker"],
  },
  {
    slug: "example/database-migration-helper",
    name: "Database Migration Helper",
    description: "Guidance for writing safe, reversible schema migrations.",
    source: "https://example.invalid/skills/database-migration-helper",
    keywords: ["migration", "sql", "schema", "database", "postgres"],
  },
  {
    slug: "example/api-design-review",
    name: "API Design Review",
    description: "Checklist for reviewing REST/GraphQL API surface changes for consistency.",
    source: "https://example.invalid/skills/api-design-review",
    keywords: ["api", "rest", "graphql", "endpoint", "openapi"],
  },
];
