import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRankedCandidates,
  RANKED_CANDIDATES_API_PATH,
  rankedCandidateRowKey,
  type RankedCandidateRow,
  type RankedCandidatesResult,
} from "./lib/ranked-candidates";
import { RankedCandidatesPage, RankedCandidatesView } from "./routes/ranked-candidates";

const fixtureRows: RankedCandidateRow[] = [
  {
    repoFullName: "acme/widgets",
    issueNumber: 2451,
    title: "Debounce the settings autosave",
    htmlUrl: "https://forge.example.com/acme/widgets/issues/2451",
    rankScore: 0.91,
    laneFit: 0.95,
    freshness: 0.88,
    potential: 0.9,
    feasibility: 0.86,
    dupRisk: 0.08,
    rankedAt: "2026-07-18T14:02:00.000Z",
  },
  {
    repoFullName: "northwind/inventory",
    issueNumber: 77,
    title: "Paginate the low-stock report",
    htmlUrl: null,
    rankScore: 0.64,
    laneFit: 0.7,
    freshness: 0.58,
    potential: 0.66,
    feasibility: 0.72,
    dupRisk: 0.31,
    rankedAt: "2026-07-18T12:30:00.000Z",
  },
];

function manyRows(count: number): RankedCandidateRow[] {
  return Array.from({ length: count }, (_, index) => ({
    repoFullName: "acme/widgets",
    issueNumber: index + 1,
    title: `Issue ${index + 1}`,
    htmlUrl: `https://forge.example.com/acme/widgets/issues/${index + 1}`,
    rankScore: 0.5,
    laneFit: 0.5,
    freshness: 0.5,
    potential: 0.5,
    feasibility: 0.5,
    dupRisk: 0.5,
    rankedAt: "2026-07-18T12:30:00.000Z",
  }));
}

describe("RankedCandidatesView (#7675)", () => {
  it("renders one table row per candidate with the issue, title, score, and every breakdown dimension", () => {
    render(<RankedCandidatesView result={{ ok: true, rows: fixtureRows }} />);
    expect(screen.getByRole("columnheader", { name: "Issue" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Lane fit" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Dup risk" })).toBeTruthy();
    expect(screen.getByText("acme/widgets #2451")).toBeTruthy();
    expect(screen.getByText("Debounce the settings autosave")).toBeTruthy();
    // 0.91 rank score, plus the five 0.xx dimensions all render at two-decimal precision.
    expect(screen.getByText("0.91")).toBeTruthy();
    expect(screen.getByText("0.95")).toBeTruthy();
    expect(screen.getByText("0.08")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 fixture rows
  });

  it("links the issue cell to its html_url, and renders a plain (unlinked) cell when the url is null", () => {
    render(<RankedCandidatesView result={{ ok: true, rows: fixtureRows }} />);
    const link = screen.getByRole("link", { name: "acme/widgets #2451" });
    expect(link.getAttribute("href")).toBe("https://forge.example.com/acme/widgets/issues/2451");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    // The null-html_url row is present as text but is NOT a link.
    expect(screen.getByText("northwind/inventory #77")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "northwind/inventory #77" })).toBeNull();
  });

  it("renders a content-shaped loading skeleton (role=status), not a flat loading sentence", () => {
    render(<RankedCandidatesView result={null} />);
    expect(screen.getByRole("status", { name: /loading ranked candidates/i })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeTruthy(); // the skeleton keeps the table shape
  });

  it("renders the shared StateBoundary error surface on an unreachable API", () => {
    render(<RankedCandidatesView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Couldn't read ranked candidates/i)).toBeTruthy();
  });

  it("renders the empty state via StateBoundary when there are no ranked candidates", () => {
    render(<RankedCandidatesView result={{ ok: true, rows: [] }} />);
    expect(screen.getByText(/No ranked candidates yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("does not paginate at or below 20 rows — full table, no controls", () => {
    render(<RankedCandidatesView result={{ ok: true, rows: manyRows(20) }} />);
    expect(screen.queryByRole("navigation", { name: /pagination/i })).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(21); // header + all 20 rows shown
  });

  it("paginates client-side above 20 rows, paging without any refetch", () => {
    render(<RankedCandidatesView result={{ ok: true, rows: manyRows(45) }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    // page 1: first 20 rows only
    expect(screen.getAllByRole("row")).toHaveLength(21);
    expect(screen.getByText("acme/widgets #1")).toBeTruthy();
    expect(screen.queryByText("acme/widgets #21")).toBeNull();
    // page 2
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("acme/widgets #21")).toBeTruthy();
    expect(screen.queryByText("acme/widgets #1")).toBeNull();
    // page 3 holds the remaining 5 rows (header + 5)
    fireEvent.click(screen.getByRole("link", { name: "3" }));
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });
});

describe("RankedCandidatesPage (#7675)", () => {
  it("loads rows through the injected loader and renders them under the route heading", async () => {
    const loadRankedCandidates = async (): Promise<RankedCandidatesResult> => ({ ok: true, rows: fixtureRows });
    render(<RankedCandidatesPage loadRankedCandidates={loadRankedCandidates} />);
    expect(screen.getByRole("heading", { name: "Ranked candidates" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("acme/widgets #2451")).toBeTruthy());
  });

  describe("live refresh", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls the injected loader again on the configured interval, without a manual page reload", async () => {
      vi.useFakeTimers();
      const loadRankedCandidates = vi.fn(async (): Promise<RankedCandidatesResult> => ({
        ok: true,
        rows: fixtureRows,
      }));
      render(<RankedCandidatesPage loadRankedCandidates={loadRankedCandidates} pollIntervalMs={1000} />);

      await vi.waitFor(() => expect(loadRankedCandidates).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadRankedCandidates).toHaveBeenCalledTimes(2));
    });
  });
});

describe("fetchRankedCandidates (#7675)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns typed rows from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchRankedCandidates(async (input) => {
      requested = String(input);
      return jsonResponse(200, { candidates: fixtureRows });
    });
    expect(requested).toBe(RANKED_CANDIDATES_API_PATH);
    expect(result).toEqual({ ok: true, rows: fixtureRows });
  });

  it("surfaces a non-2xx response as a typed error", async () => {
    const result = await fetchRankedCandidates(async () => jsonResponse(500, { error: "boom" }));
    expect(result).toEqual({ ok: false, error: "local ranked-candidates API responded 500" });
  });

  it("rejects a malformed payload shape (missing candidates array / bad row fields)", async () => {
    expect(await fetchRankedCandidates(async () => jsonResponse(200, { candidates: "nope" }))).toMatchObject({
      ok: false,
    });
    // non-object row
    expect(await fetchRankedCandidates(async () => jsonResponse(200, { candidates: [null] }))).toMatchObject({
      ok: false,
    });
    // wrong field types (issueNumber not a number)
    expect(
      await fetchRankedCandidates(async () =>
        jsonResponse(200, { candidates: [{ ...fixtureRows[0], issueNumber: "2451" }] }),
      ),
    ).toMatchObject({ ok: false });
    // htmlUrl of a disallowed type (not string | null)
    expect(
      await fetchRankedCandidates(async () => jsonResponse(200, { candidates: [{ ...fixtureRows[0], htmlUrl: 42 }] })),
    ).toMatchObject({ ok: false });
  });

  it("accepts a row whose htmlUrl is null (a fresh snapshot without a recorded url)", async () => {
    const result = await fetchRankedCandidates(async () =>
      jsonResponse(200, { candidates: [{ ...fixtureRows[0], htmlUrl: null }] }),
    );
    expect(result.ok).toBe(true);
  });

  it("surfaces a thrown fetch (server not running) as a typed error, never a crash", async () => {
    const result = await fetchRankedCandidates(async () => {
      throw new Error("connection refused");
    });
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });

  it("in demo mode, returns canned rows without ever calling fetch (#5963 family)", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    let called = false;
    const result = await fetchRankedCandidates(async () => {
      called = true;
      return jsonResponse(200, { candidates: [] });
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("rankedCandidateRowKey (#7675)", () => {
  it("builds a composite (repoFullName, issueNumber) key", () => {
    expect(rankedCandidateRowKey({ repoFullName: "acme/widgets", issueNumber: 2451 })).toBe("acme/widgets 2451");
  });
});
