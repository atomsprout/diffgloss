export * from "./schema/types.ts";
export { validateLedger, verifyHunkCitations, computeCoverage } from "./schema/validate.ts";
export { parseUnifiedDiff, isSuspectedSecretPath } from "./diff/parser.ts";
export {
  inspectGitRepo,
  extractRepoDiff,
  listNearbyGitRepos,
  resolveGitTopLevel,
} from "./diff/git-source.ts";
export { classifyHunk } from "./diff/classifier.ts";
export { extractSymbolScopes, extractFileScopes, findEnclosingScope } from "./diff/ast.ts";
export { splitLargeHunks } from "./diff/subhunk.ts";
export { detectCrossFileMoves } from "./diff/moves.ts";
export { buildInitialLedger } from "./pipeline/ledger.ts";
export { explainLedger, estimateExplainCost } from "./pipeline/explainer.ts";
export { auditLedgerLines, extractChangedLinesWithNumbers } from "./pipeline/auditor.ts";
export { HunkResultCache, computeHunkCacheKey } from "./pipeline/cache.ts";
export {
  detectInstalledAuthorClis,
  resolvePreferredAuthorCli,
  createAuthorCliClient,
} from "./llm/author-adapter.ts";
export { runIntegrityChecks, attachFindingsToHunks } from "./pipeline/integrity.ts";
export { loadConfig, discoverRuleDocs } from "./config/loader.ts";
export {
  PROVIDER_PRESETS,
  loadUserSettings,
  saveUserSettings,
  toMaskedUserSettings,
  getUserSettingsPath,
} from "./config/user-settings.ts";
export { createLLMClient, MockLLMClient } from "./llm/providers.ts";
export { BudgetTracker, BudgetExceededError } from "./llm/budget.ts";
export { redactSecrets } from "./provenance/redactor.ts";
export {
  enrichLedgerProvenance,
  discoverLocalAgentTranscripts,
  evaluateStopHook,
} from "./provenance/capture.ts";
export { recordAndVerifyAnswer } from "./provenance/questioner.ts";
export { renderHtmlReport } from "./render/html.ts";
export { renderMarkdownReport } from "./render/markdown.ts";
export { importSarifFindings, exportSarifReport, exportRdjsonl } from "./interop/sarif.ts";
