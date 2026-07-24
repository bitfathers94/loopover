import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initPredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.js";
import { initEventLedger } from "../../packages/loopover-miner/lib/event-ledger.js";
import type { EventLedger, LedgerEntry } from "../../packages/loopover-miner/lib/event-ledger.d.ts";
import { MINER_PR_OUTCOME_EVENT } from "../../packages/loopover-miner/lib/pr-outcome.js";
import {
  collectPredictionMetricRows,
  runMetrics,
} from "../../packages/loopover-miner/lib/metrics-cli.js";
import type { PredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.d.ts";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger(): PredictionLedger {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  const ledger = initPredictionLedger(join(root, "prediction-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempEventLedger(): EventLedger {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-ev-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempDbPath() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  return join(root, "prediction-ledger.sqlite3");
}

function appendPrediction(ledger: PredictionLedger, targetId: number, conclusion: string) {
  ledger.appendPrediction({ repoFullName: "acme/widgets", targetId, conclusion, pack: "gittensor", engineVersion: "0.2.0" });
}

// A raw pr_outcome ledger row, so the outcome-join's every branch (matched, mismatched, unclassifiable, malformed)
// can be exercised directly without a live event ledger.
function prOutcomeEntry(seq: number, prNumber: unknown, decision: unknown): LedgerEntry {
  return {
    id: seq,
    seq,
    type: MINER_PR_OUTCOME_EVENT,
    repoFullName: "acme/widgets",
    payload: { prNumber, decision },
    createdAt: `2026-07-01T00:00:0${seq}.000Z`,
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner metrics CLI (#4838)", () => {
  it("collectPredictionMetricRows leaves every row unresolved when no outcome stream is supplied", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    appendPrediction(ledger, 2, "close");
    // No events argument: `correct` stays unset on every row, so the shape still matches the conclusion-only projection.
    expect(collectPredictionMetricRows(ledger)).toEqual([{ conclusion: "merge" }, { conclusion: "close" }]);
  });

  it("collectPredictionMetricRows resolves each prediction against its realized pr_outcome via the calibration join", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge"); // confirmed by a merged outcome  -> correct
    appendPrediction(ledger, 2, "merge"); // disconfirmed by a closed outcome -> incorrect
    appendPrediction(ledger, 3, "close"); // confirmed by a closed outcome   -> correct
    appendPrediction(ledger, 4, "close"); // disconfirmed by a merged outcome -> incorrect
    appendPrediction(ledger, 5, "hold"); // hold has no realized counterpart -> unresolved even with an outcome
    appendPrediction(ledger, 6, "merge"); // no outcome recorded yet          -> unresolved (pending)
    appendPrediction(ledger, 7, "merge"); // outcome decision is unclassifiable -> unresolved
    appendPrediction(ledger, 8, "merge"); // malformed outcome (skipped by toOutcomeRecords) -> unresolved

    const events: LedgerEntry[] = [
      prOutcomeEntry(1, 1, "merged"),
      prOutcomeEntry(2, 2, "closed"),
      prOutcomeEntry(3, 3, "closed"),
      prOutcomeEntry(4, 4, "merged"),
      prOutcomeEntry(5, 5, "merged"),
      // (no outcome for PR 6)
      prOutcomeEntry(7, 7, "deferred"), // a well-formed but non-merge/close decision -> normalizes to ""
      prOutcomeEntry(8, "8", "merged"), // non-integer prNumber -> dropped by toOutcomeRecords, PR 8 stays pending
    ];

    expect(collectPredictionMetricRows(ledger, events)).toEqual([
      { conclusion: "merge", correct: true },
      { conclusion: "merge", correct: false },
      { conclusion: "close", correct: true },
      { conclusion: "close", correct: false },
      { conclusion: "hold", correct: undefined },
      { conclusion: "merge", correct: undefined },
      { conclusion: "merge", correct: undefined },
      { conclusion: "merge", correct: undefined },
    ]);
  });

  it("runMetrics joins the injected event ledger and moves the correct/incorrect counters", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    appendPrediction(ledger, 2, "close");
    appendPrediction(ledger, 3, "merge");
    appendPrediction(ledger, 4, "hold");

    const eventLedger = tempEventLedger();
    eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName: "acme/widgets", payload: { prNumber: 1, decision: "merged" } }); // merge confirmed
    eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName: "acme/widgets", payload: { prNumber: 2, decision: "merged" } }); // close disconfirmed
    eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName: "acme/widgets", payload: { prNumber: 4, decision: "closed" } }); // hold: never scored

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runMetrics([], { initPredictionLedger: () => ledger, initEventLedger: () => eventLedger })).toBe(0);

    const text = String(log.mock.calls[0]?.[0]);
    // Series are emitted in sorted conclusion order, so "close" precedes "hold" precedes "merge".
    expect(text).toContain('loopover_miner_predictions_total{conclusion="close"} 1');
    expect(text).toContain('loopover_miner_predictions_total{conclusion="hold"} 1');
    expect(text).toContain('loopover_miner_predictions_total{conclusion="merge"} 2');
    // PR 1 confirmed -> correct 1; PR 2 disconfirmed -> incorrect 1; PR 3 pending and PR 4 hold stay unresolved.
    expect(text).toContain("loopover_miner_prediction_correct_total 1");
    expect(text).toContain("loopover_miner_prediction_incorrect_total 1");
    // The output is a single, once-terminated document (no doubled trailing blank line).
    expect(text.endsWith("\n")).toBe(false);
  });

  it("runMetrics keeps the correct/incorrect counters at zero when no outcomes are recorded", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    appendPrediction(ledger, 2, "close");
    appendPrediction(ledger, 3, "merge");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runMetrics([], { initPredictionLedger: () => ledger, initEventLedger: () => tempEventLedger() })).toBe(0);

    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain('loopover_miner_predictions_total{conclusion="close"} 1');
    expect(text).toContain('loopover_miner_predictions_total{conclusion="merge"} 2');
    // The event ledger is empty, so both counters stay zero.
    expect(text).toContain("loopover_miner_prediction_correct_total 0");
    expect(text).toContain("loopover_miner_prediction_incorrect_total 0");
  });

  it("runMetrics opens and closes its own default prediction + event ledgers when none are injected", () => {
    const dbPath = tempDbPath();
    const seed = initPredictionLedger(dbPath);
    appendPrediction(seed, 1, "hold");
    seed.close();
    const eventDbPath = join(mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-ev-")), "event-ledger.sqlite3");

    const prevPred = process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB;
    const prevEvent = process.env.LOOPOVER_MINER_EVENT_LEDGER_DB;
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = dbPath;
    process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = eventDbPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runMetrics([])).toBe(0);
    } finally {
      if (prevPred === undefined) delete process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB;
      else process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = prevPred;
      if (prevEvent === undefined) delete process.env.LOOPOVER_MINER_EVENT_LEDGER_DB;
      else process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = prevEvent;
    }
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain('loopover_miner_predictions_total{conclusion="hold"} 1');
    // The freshly-opened default event ledger is empty, so the outcome counters stay zero.
    expect(text).toContain("loopover_miner_prediction_correct_total 0");
  });

  it("runMetrics rejects unexpected arguments with a usage error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runMetrics(["--json"], { initPredictionLedger: () => tempLedger() })).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "Usage: loopover-miner metrics",
    });
    error.mockClear();
    log.mockClear();
    expect(runMetrics(["--nope"], { initPredictionLedger: () => tempLedger() })).toBe(2);
    expect(error).toHaveBeenCalledWith("Usage: loopover-miner metrics");
    expect(log).not.toHaveBeenCalled();
  });

  it("runMetrics surfaces a thrown Error message and exits non-zero", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runMetrics([], {
        initPredictionLedger: () => {
          throw new Error("prediction ledger is locked");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("prediction ledger is locked");
  });

  it("runMetrics stringifies a non-Error throw", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runMetrics([], {
        initPredictionLedger: () => {
          throw "prediction-ledger-unavailable";
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("prediction-ledger-unavailable");
  });
});
