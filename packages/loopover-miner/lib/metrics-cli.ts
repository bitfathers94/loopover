import { renderMinerPredictionMetrics } from "@loopover/engine";
import type { MinerPredictionMetricRow } from "@loopover/engine";
import { initPredictionLedger } from "./prediction-ledger.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import { initEventLedger } from "./event-ledger.js";
import type { EventLedger, LedgerEntry } from "./event-ledger.js";
import { toOutcomeRecords, toPredictionRecords } from "./calibration-cli.js";
import { normalizeDecision } from "./calibration.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// `metrics` (#4838): render the miner's prediction-calibration counters as Prometheus text-exposition to stdout,
// for a scrape wrapper or cron redirect. The counters are produced by the engine's already-built
// renderMinerPredictionMetrics (packages/loopover-engine/src/miner-prediction-metrics.ts) -- this command only
// reads the local prediction ledger and pr_outcome event stream and feeds them in, never touching the renderer
// itself. Strictly local + offline: no network, no writes.

const METRICS_USAGE = "Usage: loopover-miner metrics";

// Key a (project, targetId) the same way calibration.ts's buildCalibrationReport does, so the metrics join and the
// calibration report resolve a prediction against its realized outcome identically (space separator; a collision
// across distinct pairs is astronomically unlikely and would only ever merge two projects' tallies).
function outcomeKey(project: string, targetId: string): string {
  return `${project} ${targetId}`;
}

/**
 * Resolve one prediction's realized-outcome pairing (`correct`) against the observed decision joined from the
 * pr_outcome stream. Mirrors buildCalibrationReport's own gate: a row is scored true/false ONLY when a realized
 * `merge`/`close` outcome exists AND the prediction itself is `merge`/`close`. A still-pending prediction
 * (`observed` undefined), an unclassifiable outcome (`observed` `""`), and a `hold` conclusion (which has no
 * realized `merged`/`closed` counterpart) all leave `correct` unset -- an undecided row is never fabricated as
 * `false`, exactly how buildCalibrationReport tallies a hold without scoring it right or wrong.
 */
function resolveCorrect(
  predictedDecision: string,
  observed: "merge" | "close" | "hold" | "" | undefined,
): boolean | undefined {
  if (observed !== "merge" && observed !== "close") return undefined;
  const predicted = normalizeDecision(predictedDecision);
  if (predicted !== "merge" && predicted !== "close") return undefined;
  return predicted === observed;
}

/**
 * Project prediction-ledger rows onto the engine renderer's metric-row shape: the predicted `conclusion`, plus the
 * realized-outcome pairing (`correct`) resolved against the `pr_outcome` event stream via the SAME
 * (project, targetId) join calibration.ts already performs -- reusing calibration-cli.ts's `toPredictionRecords`/
 * `toOutcomeRecords` and calibration.ts's `normalizeDecision`, never a second join. `events` defaults to empty, so
 * with no outcome stream every row stays unresolved (`correct` unset) and only `predictions_total{conclusion}`
 * moves -- exactly how the renderer is designed to degrade before any outcome has landed.
 */
export function collectPredictionMetricRows(
  ledger: PredictionLedger,
  events: LedgerEntry[] = [],
): MinerPredictionMetricRow[] {
  const observedByKey = new Map<string, "merge" | "close" | "hold" | "">();
  for (const outcome of toOutcomeRecords(events)) {
    observedByKey.set(outcomeKey(outcome.project, outcome.targetId), normalizeDecision(outcome.outcomeDecision));
  }
  return toPredictionRecords(ledger.readPredictions()).map((record) => {
    const correct = resolveCorrect(record.predictedDecision, observedByKey.get(outcomeKey(record.project, record.targetId)));
    // Omit `correct` entirely on an unresolved row (pending / hold / unclassifiable) rather than emitting an
    // explicit undefined -- the renderer treats an absent field as "not yet resolved" and never counts it.
    return correct === undefined ? { conclusion: record.predictedDecision } : { conclusion: record.predictedDecision, correct };
  });
}

// Open the local prediction ledger (or a test-injected one) for the duration of `run`, closing it only when we
// opened it -- an injected ledger is owned by the caller. Mirrors event-ledger-cli.js's withEventLedger.
function withPredictionLedger<T>(
  options: { initPredictionLedger?: () => PredictionLedger },
  run: (ledger: PredictionLedger) => T,
): T {
  const ownsLedger = options.initPredictionLedger === undefined;
  const ledger = (options.initPredictionLedger ?? initPredictionLedger)();
  try {
    return run(ledger);
  } finally {
    if (ownsLedger) ledger.close();
  }
}

// Open the pr_outcome event ledger (or a test-injected one) the same read-only way the bare `calibration` command
// does (initEventLedger resolves resolveEventLedgerDbPath by default), closing it only when we opened it. Mirrors
// withPredictionLedger above so `metrics` stays strictly offline: read once, close in a finally.
function withEventLedger<T>(options: { initEventLedger?: () => EventLedger }, run: (ledger: EventLedger) => T): T {
  const ownsLedger = options.initEventLedger === undefined;
  const ledger = (options.initEventLedger ?? initEventLedger)();
  try {
    return run(ledger);
  } finally {
    if (ownsLedger) ledger.close();
  }
}

export function runMetrics(
  args: string[],
  options: { initPredictionLedger?: () => PredictionLedger; initEventLedger?: () => EventLedger } = {},
): number {
  if (args.length > 0) {
    return reportCliFailure(argsWantJson(args), METRICS_USAGE);
  }

  try {
    return withPredictionLedger(options, (ledger) =>
      withEventLedger(options, (eventLedger) => {
        // renderMinerPredictionMetrics returns a newline-terminated document; console.log re-adds the terminator, so
        // trim it to emit exactly one trailing newline.
        console.log(renderMinerPredictionMetrics(collectPredictionMetricRows(ledger, eventLedger.readEvents())).trimEnd());
        return 0;
      }),
    );
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  }
}
