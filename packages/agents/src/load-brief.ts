import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AgentBrief {
  name: string;
  description: string;
  model: string;
  tools: string[];
  /** The markdown body AFTER the frontmatter block -- the actual system-prompt text. */
  systemPrompt: string;
}

export interface SkillBrief {
  name: string;
  description: string;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";

/**
 * Splits a Claude Code agent/skill .md file into its frontmatter key/value
 * map and the remaining body text.
 *
 * Frontmatter here is always a flat `key: value` map with no nesting except
 * `tools`, which is a comma-separated list -- so this is a deliberately
 * simple, dependency-free parser rather than a general YAML parser.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(
      `Expected file to start with a "${FRONTMATTER_DELIMITER}" frontmatter delimiter, found: ${JSON.stringify(lines[0])}`,
    );
  }

  const closingIndex = lines.findIndex((line, i) => i > 0 && line.trim() === FRONTMATTER_DELIMITER);
  if (closingIndex === -1) {
    throw new Error(`No closing "${FRONTMATTER_DELIMITER}" frontmatter delimiter found`);
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const bodyLines = lines.slice(closingIndex + 1);

  const fields: Record<string, string> = {};
  for (const line of frontmatterLines) {
    if (line.trim() === "") continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    // Strip a single layer of surrounding quotes, e.g. description: "..."
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const body = bodyLines.join("\n").replace(/^\n+/, "");

  return { fields, body };
}

/** Reads and parses a Claude Code agent .md file (frontmatter + body) at the given absolute path. */
export async function loadAgentBrief(filePath: string): Promise<AgentBrief> {
  const raw = await readFile(filePath, "utf8");
  const { fields, body } = parseFrontmatter(raw);

  if (!fields.name) {
    throw new Error(`Agent brief at ${filePath} is missing required frontmatter field "name"`);
  }
  if (!fields.model) {
    throw new Error(`Agent brief at ${filePath} is missing required frontmatter field "model"`);
  }

  const tools = (fields.tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return {
    name: fields.name,
    description: fields.description ?? "",
    model: fields.model,
    tools,
    systemPrompt: body,
  };
}

/** Convenience: resolves `<repoRoot>/.claude/agents/<name>.md` and loads it. */
export async function loadAgentBriefByName(repoRoot: string, name: string): Promise<AgentBrief> {
  return loadAgentBrief(path.join(repoRoot, ".claude", "agents", `${name}.md`));
}

/** Reads a skill .md file (e.g. `.claude/skills/review/SKILL.md`) -- same frontmatter+body shape, returns { name, description, body } (skills don't have model/tools). */
export async function loadSkillBrief(filePath: string): Promise<SkillBrief> {
  const raw = await readFile(filePath, "utf8");
  const { fields, body } = parseFrontmatter(raw);

  if (!fields.name) {
    throw new Error(`Skill brief at ${filePath} is missing required frontmatter field "name"`);
  }

  return {
    name: fields.name,
    description: fields.description ?? "",
    body,
  };
}
