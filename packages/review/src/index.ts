export {
  rankHunks,
  collectParsedHunks,
  MAX_SIZE_SCORE,
  GENERATED_OR_LOCKFILE_PENALTY,
  WHITESPACE_ONLY_SCORE,
  KEYWORD_BONUS,
  NO_TEST_COVERAGE_BONUS,
  VERIFICATION_FLAG_BONUS,
  REVIEW_OBJECTION_BONUS,
  RISK_KEYWORDS,
} from "./hunks.js";
export type { Hunk, RiskRankedDiff, RiskRankOptions } from "./hunks.js";

export { buildFocusChecklist } from "./checklist.js";
export type { ChecklistItem } from "./checklist.js";

export { extractDeclaredSymbols, validateDiagramSpec } from "./ast-validate.js";
export type { DiagramSpec, ValidationResult } from "./ast-validate.js";
