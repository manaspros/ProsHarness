import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * ProsHarness's own repo root, resolved relative to this test file
 * (packages/implement/test/helpers.ts -> ../../.. -> repo root). Several of
 * this package's modules load real `.claude/agents/*.md` /
 * `.claude/skills/**\/SKILL.md` briefs by path -- reusing the real repo's
 * files (rather than fabricating fixtures) keeps the tests honest about
 * what's actually loaded in production.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
