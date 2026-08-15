/**
 * Non-negotiable workflow guidance included in every Claude planning prompt.
 * Keeping this in the plan package makes the behavior consistent for the
 * dashboard, CLI, and trigger-driven session entry points.
 */
export const DEFAULT_SESSION_DIRECTIVE = [
  "Default session workflow (always follow):",
  "Before producing findings, explore the codebase using a Sonnet subagent and collect the relevant findings and surrounding context.",
  "Always use subagents for repository exploration, investigation, and implementation whenever they are available.",
  "Verify the subagent's findings yourself against the repository before proposing a conclusion or plan.",
].join("\n");
