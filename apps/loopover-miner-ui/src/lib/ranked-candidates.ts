// Read-only client for the local ranked-candidates API (#7675). Mirrors the run-history client (`run-history.ts`):
// the dashboard is a browser app and the miner's stores are `node:sqlite` files on disk, so the view never
// touches SQL — it fetches the dev server's local read-only endpoint (see `vite-ranked-candidates-api.ts`), which
// itself calls into `packages/loopover-miner/lib/ranked-candidates.js`'s existing exports. Strictly read-only: the
// per-issue ranking breakdown (laneFit/freshness/potential/feasibility/dupRisk) is surfaced as-is, no ranking
// logic duplicated in the UI layer.

import { DEMO_RANKED_CANDIDATES, isDemoMode } from "./demo-data";

export const RANKED_CANDIDATES_API_PATH = "/api/ranked-candidates";

/** One ranked-candidate row as served by the local API — mirrors `ranked-candidates.js`'s row shape. */
export type RankedCandidateRow = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  /** Canonical issue URL, or null when the discover snapshot didn't record one. */
  htmlUrl: string | null;
  /** Composite ranking score the breakdown dimensions feed into. */
  rankScore: number;
  laneFit: number;
  freshness: number;
  potential: number;
  feasibility: number;
  dupRisk: number;
  rankedAt: string;
};

export type RankedCandidatesResult = { ok: true; rows: RankedCandidateRow[] } | { ok: false; error: string };

function isRankedCandidateRow(value: unknown): value is RankedCandidateRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.repoFullName === "string" &&
    typeof row.issueNumber === "number" &&
    typeof row.title === "string" &&
    (typeof row.htmlUrl === "string" || row.htmlUrl === null) &&
    typeof row.rankScore === "number" &&
    typeof row.laneFit === "number" &&
    typeof row.freshness === "number" &&
    typeof row.potential === "number" &&
    typeof row.feasibility === "number" &&
    typeof row.dupRisk === "number" &&
    typeof row.rankedAt === "string"
  );
}

/** Stable React key / identity for a ranked-candidate row: one snapshot holds at most one row per issue. */
export function rankedCandidateRowKey(row: Pick<RankedCandidateRow, "repoFullName" | "issueNumber">): string {
  return `${row.repoFullName}\0${row.issueNumber}`;
}

/** Fetch the local ranked-candidate rows. Failures (server down, malformed payload) surface as a typed error
 *  result — the view renders them as a message, never a crash. `fetchImpl` is injectable for tests. */
export async function fetchRankedCandidates(fetchImpl: typeof fetch = fetch): Promise<RankedCandidatesResult> {
  if (isDemoMode()) return { ok: true, rows: DEMO_RANKED_CANDIDATES };
  try {
    const response = await fetchImpl(RANKED_CANDIDATES_API_PATH);
    if (!response.ok) return { ok: false, error: `local ranked-candidates API responded ${response.status}` };
    const payload: unknown = await response.json();
    const candidates = (payload as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || !candidates.every(isRankedCandidateRow)) {
      return { ok: false, error: "local ranked-candidates API returned an unexpected payload shape" };
    }
    return { ok: true, rows: candidates };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local ranked-candidates API",
    };
  }
}
