export type RiskLevel = "low" | "medium" | "high";

export type HunkClass =
  | "substantive"
  | "mechanical"
  | "generated"
  | "moved"
  | "test"
  | "config";

export type HunkStatus = "explained" | "collapsed" | "unexplained";

export type ChangeType = "modified" | "added" | "deleted" | "renamed";

export type SemanticGrounding =
  | "unchecked"
  | "judge_passed"
  | "judge_failed"
  | "test_backed";

export type WhySource =
  | "transcript"
  | "declared_intent"
  | "author_answer"
  | "reviewer_inferred"
  | "missing";

export type WhyVerification =
  | "confirmed"
  | "refuted"
  | "unverifiable"
  | "not_checked";

export type QuestionTrigger =
  | "no_evidence_for_why"
  | "unrelated_to_intent"
  | "test_assertion_changed"
  | "claim_mismatch"
  | "safety_check_removed";

export type QuestionChannel =
  | "write_time_manifest"
  | "transcript_lookup"
  | "session_resume"
  | "acp"
  | "human";

export type EffortLevel = "quick" | "standard" | "deep";

export type ProviderDialect =
  | "anthropic"
  | "openai"
  | "openai-chat"
  | "deepseek"
  | "google"
  | "claude-cli"
  | "codex-cli"
  | "mock";

export type ExplainerMode = "author_cli" | "api_model";

export type AuthorCliKind = "auto" | "claude-cli" | "codex-cli";

export type AuditStatus =
  | "pending"
  | "verified"
  | "omission_detected"
  | "contradicted";

export interface HunkExplainerMeta {
  mode: ExplainerMode;
  adapter: string;
  session_id?: string;
  cached?: boolean;
}

export interface HunkAudit {
  status: AuditStatus;
  auditor_model: string;
  covered_lines: number[];
  omitted_lines: number[];
  note: string;
  audited_at: string;
}

export interface SkippedFile {
  path: string;
  reason: "binary" | "secret_suspected" | "oversized" | "excluded";
}

export interface LedgerSource {
  repo?: string;
  base_ref?: string;
  head_ref?: string;
  diff_args?: string[];
  skipped_files?: SkippedFile[];
  rules_loaded?: string[];
}

export interface LedgerOverview {
  title: string;
  behavior_change: string;
  declared_intent?: string;
  declared_intent_ref?:
    | "prompt"
    | "pr_description"
    | "plan"
    | "commit_message"
    | "none";
  risk?: RiskLevel;
}

export interface ExplanationGroup {
  id: string;
  title: string;
  intent: string;
  order_rationale?: string;
  risk: RiskLevel;
  collapsed_by_default?: boolean;
  intent_ref?: {
    kind: "prompt" | "plan_item" | "issue" | "pr_description";
    ref: string;
  };
  hunk_ids: string[];
}

export interface Citation {
  path: string;
  lines: [number, number];
  side: "old" | "new";
}

export interface HunkWhat {
  text: string;
  citations: Citation[];
  citations_valid: boolean;
  citation_errors?: string[];
  semantic_grounding: SemanticGrounding;
  semantic_note?: string;
}

export interface WhyEvidence {
  kind:
    | "transcript_turn"
    | "tool_use"
    | "test_run"
    | "call_site"
    | "declared_intent"
    | "git_note";
  ref: string;
  excerpt?: string;
}

export interface HunkWhy {
  text: string;
  source: WhySource;
  evidence: WhyEvidence[];
  verification: WhyVerification;
}

export interface HunkProvenance {
  format:
    | "git-ai"
    | "agent-trace"
    | "entire"
    | "hook"
    | "session-scan"
    | "none";
  session_id?: string;
  agent?: string;
  model?: string;
}

export interface AttachedFinding {
  id: string;
  rule_id: string;
  tool: string;
  severity: "important" | "nit" | "info";
  category:
    | "intent_mismatch"
    | "test_weakened"
    | "guard_removed"
    | "silent_error"
    | "scope_creep"
    | "bug_verified"
    | "custom_rule"
    | "audit_omission"
    | "audit_contradiction"
    | "external_sarif";
  path: string;
  lines: [number, number];
  hunk_id?: string;
  message: string;
  evidence?: string;
  verifier_model?: string;
  fingerprint: string;
}

export interface RuledOutConcern {
  id: string;
  specialist: string;
  path: string;
  lines: [number, number];
  hunk_id?: string;
  suspicion: string;
  proof: string;
  shaky_dismissal: boolean;
}

export interface RuleTelemetry {
  id: string;
  title: string;
  path: string;
  source: "base_ref" | "working_tree";
  kind: "regex" | "llm";
  matched_hunks: number;
  hits: number;
}

export interface HunkRecord {
  id: string;
  path: string;
  old_path?: string;
  change_type?: ChangeType;
  enclosing_symbol?: string;
  old_range: [number, number];
  new_range: [number, number];
  class: HunkClass;
  class_by: "deterministic" | "llm";
  class_reason?: string;
  status: HunkStatus;
  risk: RiskLevel;
  header?: string;
  patch: string;
  what?: HunkWhat;
  why?: HunkWhy;
  provenance?: HunkProvenance;
  explainer_meta?: HunkExplainerMeta;
  audit?: HunkAudit;
  questions?: string[];
  finding_ids?: string[];
  moved_from?: {
    path: string;
    old_range: [number, number];
  };
}

export interface ClarifyingQuestion {
  id: string;
  hunk_ids: string[];
  trigger: QuestionTrigger;
  question: string;
  channel: QuestionChannel;
  answer?: {
    text: string;
    answered_by: string;
    at: string;
    session_forked?: boolean;
  };
  verdict?: {
    status: "confirmed" | "refuted" | "unverifiable";
    verifier_model?: string;
    evidence?: string[];
  };
}

export interface CoverageSummary {
  total: number;
  explained: number;
  collapsed: number;
  unexplained: number;
}

export interface CostSummary {
  provider: string;
  model: string;
  judge_model?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  estimated_usd: number;
  budget_usd: number;
  budget_exceeded: boolean;
}

export interface ExplanationLedger {
  schema: "diffgloss.explanation/v0";
  generated_at: string;
  source?: LedgerSource;
  overview: LedgerOverview;
  groups: ExplanationGroup[];
  hunks: HunkRecord[];
  questions: ClarifyingQuestion[];
  findings?: AttachedFinding[];
  ruled_out?: RuledOutConcern[];
  rule_telemetry?: RuleTelemetry[];
  cost?: CostSummary;
  coverage: CoverageSummary;
}

export interface ParsedHunk {
  id: string;
  path: string;
  old_path?: string;
  change_type: ChangeType;
  enclosing_symbol?: string;
  old_range: [number, number];
  new_range: [number, number];
  header: string;
  patch: string;
  added_lines: string[];
  removed_lines: string[];
  moved_from?: {
    path: string;
    old_range: [number, number];
  };
}

export interface ParsedDiffResult {
  hunks: ParsedHunk[];
  skipped_files: SkippedFile[];
}

export interface DiffglossConfig {
  explainer_mode?: ExplainerMode;
  author_cli?: AuthorCliKind;
  provider: ProviderDialect;
  model: string;
  base_url?: string;
  api_key?: string;
  api_key_env?: string;
  judge_provider?: ProviderDialect;
  judge_model?: string;
  judge_base_url?: string;
  judge_api_key?: string;
  judge_api_key_env?: string;
  effort: EffortLevel;
  budget_usd: number;
  max_questions: number;
  rules_from_base: boolean;
  redact_secrets: boolean;
  ignore: string[];
  split_large_hunks: boolean;
  subhunk_line_threshold: number;
}
