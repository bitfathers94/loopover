import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Lets a single test force a shouldHalt=false verdict while a prior halt is still latched — the
// engine's own evaluateRunLoopHalt can never emit that pair (runHalted=true always halts), so the
// (wasHalted=true, shouldHalt=false) resume transition is only reachable through this override.
const haltCtl = vi.hoisted(() => ({
  override: null as ((input: unknown) => unknown) | null,
}));

vi.mock("@loopover/engine", async () => {
  const actual = await import("../../packages/loopover-engine/src/index");
  return {
    ...actual,
    evaluateRunLoopHalt: (input: Parameters<typeof actual.evaluateRunLoopHalt>[0]) =>
      haltCtl.override ? haltCtl.override(input) : actual.evaluateRunLoopHalt(input),
  };
});

import { evaluateRunLoopBoundaryGate } from "../../packages/loopover-miner/lib/governor-run-halt";
import { evaluateRunLoopHalt } from "@loopover/engine";
import {
  closeDefaultGovernorLedger,
  initGovernorLedger,
} from "../../packages/loopover-miner/lib/governor-ledger";
import { initPortfolioQueueManager } from "../../packages/loopover-miner/lib/portfolio-queue-manager";
import { initPortfolioQueueStore } from "../../packages/loopover-miner/lib/portfolio-queue";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];
const stores: Array<{ close(): void }> = [];
const previousConfigDirs: Array<string | undefined> = [];

afterEach(() => {
  haltCtl.override = null;
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const store of stores.splice(0)) store.close();
  closeDefaultGovernorLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousConfigDirs.length > 0) {
    const previousConfigDir = previousConfigDirs.pop();
    if (previousConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
    else process.env.LOOPOVER_MINER_CONFIG_DIR = previousConfigDir;
  }
});

const LIMITS = { budget: 100, turns: 5, elapsedMs: 60_000 };
const HEALTHY_USAGE = { budgetSpent: 10, turnsTaken: 1, elapsedMs: 1_000 };
const HEALTHY_CONVERGENCE = { attempts: 1, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };

describe("evaluateRunLoopBoundaryGate (#2347)", () => {
  it("releases an in-flight portfolio item and records a halt when a flapping run is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const store = initPortfolioQueueStore(":memory:");
    stores.push(store);
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 2, perRepoWipCap: 2 } });
    manager.enqueue({ repoFullName: "acme/repo-a", identifier: "issue:42", priority: 1 });
    const inFlight = store.dequeueNext();
    expect(inFlight?.status).toBe("in_progress");

    const halted = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: { attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false },
        inFlightItem: { repoFullName: "acme/repo-a", identifier: "issue:42" },
        markFailed: manager.markFailed.bind(manager),
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(halted.runHalted).toBe(true);
    expect(halted.canClaimNext).toBe(false);
    expect(halted.releasedItem).toMatchObject({ identifier: "issue:42", status: "queued" });
    expect(halted.recorded?.eventType).toBe("denied");
    expect(halted.recorded?.actionClass).toBe("run_loop");

    const blockedClaim = evaluateRunLoopBoundaryGate(
      {
        runHalted: halted.runHalted,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(blockedClaim.canClaimNext).toBe(false);
    const claimed = blockedClaim.canClaimNext ? manager.claimNextBatch() : [];
    expect(claimed).toEqual([]);
  });

  it("halts immediately on a budget-cap breach at the next iteration boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-budget-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const halted = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(halted.runHalted).toBe(true);
    expect(halted.verdict.reason).toBe("budget_exceeded");
    expect(halted.recorded?.reason).toBe("budget_cap_exceeded");
  });

  it("does not append a ledger row for the steady never-halted, still-healthy iteration", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-healthy-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const append = vi.fn((event) => ledger.appendGovernorEvent(event));

    const healthy = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append },
    );

    expect(healthy.runHalted).toBe(false);
    expect(healthy.canClaimNext).toBe(true);
    // (wasHalted=false, shouldHalt=false): no transition, so no ledger flood.
    expect(healthy.recorded).toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(healthy.releasedItem).toBeNull();
  });

  it("appends a ledger row on the resume transition out of a latched halt", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-resume-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    // A cleared, healthy verdict — but delivered while the boundary gate still sees runHalted=true,
    // the (wasHalted=true, shouldHalt=false) resume case the engine's latch never emits on its own.
    const resumeVerdict = evaluateRunLoopHalt({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    haltCtl.override = () => resumeVerdict;

    const resumed = evaluateRunLoopBoundaryGate(
      {
        runHalted: true,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(resumed.runHalted).toBe(false);
    expect(resumed.canClaimNext).toBe(true);
    expect(resumed.recorded).not.toBeNull();
    expect(resumed.recorded?.eventType).toBe("allowed");
    expect(resumed.recorded?.actionClass).toBe("run_loop");
    expect(resumed.recorded?.decision).toBe("continue");
    expect(resumed.releasedItem).toBeNull();
  });

  it("does not re-append ledger rows while a prior halt remains latched", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-latched-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const append = vi.fn((event) => ledger.appendGovernorEvent(event));

    const first = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append },
    );
    expect(first.recorded).not.toBeNull();

    const second = evaluateRunLoopBoundaryGate(
      {
        runHalted: true,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append },
    );
    expect(second.recorded).toBeNull();
    expect(second.canClaimNext).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("forwards custom convergenceThresholds through the default ledger append", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-thresholds-"));
    roots.push(root);
    previousConfigDirs.push(process.env.LOOPOVER_MINER_CONFIG_DIR);
    process.env.LOOPOVER_MINER_CONFIG_DIR = root;

    // Defaults would halt on consecutiveFailures: 3; raised thresholds keep the run healthy.
    const healthy = evaluateRunLoopBoundaryGate({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: { attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false },
      convergenceThresholds: { maxConsecutiveFailures: 10, maxReenqueues: 10 },
    });
    expect(healthy.runHalted).toBe(false);
    expect(healthy.canClaimNext).toBe(true);
    // Still a steady (false, false) iteration, so the default append is never invoked.
    expect(healthy.recorded).toBeNull();
    expect(healthy.releasedItem).toBeNull();
  });

  it("halts on a fresh boundary without releasing when markFailed is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-no-mark-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const halted = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
        inFlightItem: { repoFullName: "acme/repo-a", identifier: "issue:7" },
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(halted.runHalted).toBe(true);
    expect(halted.releasedItem).toBeNull();
    expect(halted.recorded?.eventType).toBe("denied");
  });
});
