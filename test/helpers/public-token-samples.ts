// One concrete sample token per prefix in PUBLIC_TOKEN_INLINE (src/signals/redaction.ts) — every member of
// the two character classes (gh[pousr]_ → ghp_/gho_/ghu_/ghs_/ghr_, xox[baprs]- → xoxb-) plus each standalone
// prefix. Shared by every public-surface redaction test's it.each so all five sanitizers are exercised over the
// same list. Bodies use only [A-Za-z0-9_] so each sample satisfies both trailing classes in use: the
// `[A-Za-z0-9_=-]{8,}` tail (dashboard / roles / weekly) and the `[A-Za-z0-9_]+` tail (score-breakdown / card).
export const PUBLIC_TOKEN_SAMPLES = [
  "ghp_AAAAAAAAAAAAAAAAAAAA1234",
  "gho_AAAAAAAAAAAAAAAAAAAA1234",
  "ghu_AAAAAAAAAAAAAAAAAAAA1234",
  "ghs_AAAAAAAAAAAAAAAAAAAA1234",
  "ghr_AAAAAAAAAAAAAAAAAAAA1234",
  "github_pat_AAAAAAAAAAAAAAAAAAAA1234",
  "gts_AAAAAAAAAAAAAAAAAAAA1234",
  "orbenr_AAAAAAAAAAAAAAAAAAAA1234",
  "orbsec_AAAAAAAAAAAAAAAAAAAA1234",
  "glpat-AAAAAAAAAAAAAAAAAAAA1234",
  "sk-AAAAAAAAAAAAAAAAAAAA1234",
  "xoxb-AAAAAAAAAAAAAAAAAAAA1234",
] as const;
