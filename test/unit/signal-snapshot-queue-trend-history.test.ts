import { describe, expect, it } from "vitest";
import { getRepoQueueTrendSnapshot, persistRepoGithubTotalsSnapshot, persistSignalSnapshot, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { generateSignalSnapshots } from "../../src/queue/processors";
import type { QueueTrendReport } from "../../src/services/queue-trends";
import type { RepoGithubTotalsSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// #10020: before this fix, generateSignalSnapshotForRepo read the queue-health half of the trend input
// through listSignalSnapshots, which hard-caps at the 100 newest rows with no time bound. At four
// queue-health rows/day (the six-hourly full-sync cadence plus repairDataFidelity's fan-out and manual
// runs) that cap covers only ~25 days, so buildQueueTrendReport's 30-day window could never find a
// baseline point and its two delta fields stayed permanently null. This seeds 130 rows spread across 33
// days -- more than the old 100-row cap, and older than the 30-day window needs -- to prove the read is
// now bounded by the 35-day trendSince window instead.
const FIXTURE_NOW_MS = Date.now();

function atDaysAgo(daysAgo: number): string {
  return new Date(FIXTURE_NOW_MS - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe("signal-snapshot queue-trend history window (#10020)", () => {
  it("resolves a 30-day baseline from 130 queue-health snapshots spread across 33 days", async () => {
    const env = createTestEnv();
    const repoFullName = "owner/queue-trend-history";
    await upsertRepositoryFromGitHub(
      env,
      { name: "queue-trend-history", full_name: repoFullName, private: false, owner: { login: "owner" }, default_branch: "main" },
      901,
    );

    for (let day = 0; day < 33; day++) {
      for (let slot = 0; slot < 4 && day * 4 + slot < 130; slot++) {
        const daysAgo = day + slot * 0.25;
        await persistSignalSnapshot(env, {
          id: `qh-${day}-${slot}`,
          signalType: "queue-health",
          targetKey: repoFullName,
          repoFullName,
          generatedAt: atDaysAgo(daysAgo),
          payload: {
            signals: {
              openPullRequests: 5,
              stalePullRequests: 1,
              collisionClusters: 2,
            },
          },
        });
      }
    }
    for (let day = 0; day <= 32; day++) {
      await persistRepoGithubTotalsSnapshot(env, totals(day));
    }

    await generateSignalSnapshots(env, repoFullName);

    const snapshot = await getRepoQueueTrendSnapshot(env, repoFullName);
    const report = snapshot?.payload as unknown as QueueTrendReport;
    const window30 = report.windows.find((window) => window.windowDays === 30);
    expect(window30).toMatchObject({ status: "ready" });
    expect(window30?.duplicateTrend).not.toBeNull();
    expect(window30?.stalePullRequestRateDelta).not.toBeNull();
  });
});

function totals(daysAgo: number): RepoGithubTotalsSnapshotRecord {
  return {
    id: `totals-${daysAgo}`,
    repoFullName: "owner/queue-trend-history",
    openIssuesTotal: 20 + daysAgo,
    openPullRequestsTotal: 10 + daysAgo,
    mergedPullRequestsTotal: 30 + daysAgo,
    closedUnmergedPullRequestsTotal: 5 + daysAgo,
    labelsTotal: 0,
    sourceKind: "test",
    fetchedAt: atDaysAgo(daysAgo),
    payload: {},
  };
}
