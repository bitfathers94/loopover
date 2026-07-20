import { describe, expect, it } from "vitest";
import { recordPublishedGateCheckSummary } from "../../src/queue/gate-checks";
import { getCheckSummaryByHead, upsertCheckSummary } from "../../src/db/repositories";
import { LOOPOVER_GATE_CHECK_NAME } from "../../src/review/check-names";
import { createTestEnv } from "../helpers/d1";

// #7514 (review-burst): recordPublishedGateCheckSummary now reports whether the published gate conclusion is a
// byte-identical no-op against the summary already stored for this exact head, so the caller can suppress a fresh
// pr_public_surface_published on a stable-verdict retry storm (mirroring #6724's comment/label no-op signal).
describe("recordPublishedGateCheckSummary no-op detection (#7514)", () => {
  const base = {
    repoFullName: "JSONbored/gittensory",
    pullNumber: 7,
    headSha: "sha-noop",
    checkRunId: 901,
    detailsUrl: "https://example.test/checks/901",
    deliveryId: "delivery-1",
  };

  it("reports CHANGED on the first review of a head (no prior summary) and persists it", async () => {
    const env = createTestEnv();
    const changed = await recordPublishedGateCheckSummary(env, { ...base, conclusion: "success" });
    expect(changed).toBe(true);
    const stored = await getCheckSummaryByHead(env, base.repoFullName, base.headSha, LOOPOVER_GATE_CHECK_NAME);
    expect(stored).toMatchObject({ conclusion: "success", status: "completed", headSha: base.headSha });
  });

  it("reports UNCHANGED when a re-review lands the exact same conclusion for the same head", async () => {
    const env = createTestEnv();
    await recordPublishedGateCheckSummary(env, { ...base, conclusion: "success" });
    const changed = await recordPublishedGateCheckSummary(env, { ...base, conclusion: "success" });
    expect(changed).toBe(false);
  });

  it("reports CHANGED when the re-review's conclusion differs from the stored one", async () => {
    const env = createTestEnv();
    await recordPublishedGateCheckSummary(env, { ...base, conclusion: "success" });
    const changed = await recordPublishedGateCheckSummary(env, { ...base, conclusion: "failure" });
    expect(changed).toBe(true);
  });

  it("normalizes null/undefined conclusions so a stored null vs an absent conclusion still reads UNCHANGED", async () => {
    const env = createTestEnv();
    // Seed a summary whose stored conclusion is explicitly null (the defensive `?? null` shape).
    await upsertCheckSummary(env, {
      id: String(base.checkRunId),
      repoFullName: base.repoFullName,
      pullNumber: base.pullNumber,
      headSha: base.headSha,
      name: LOOPOVER_GATE_CHECK_NAME,
      status: "completed",
      conclusion: null,
      startedAt: null,
      completedAt: "2026-05-23T00:00:00.000Z",
      payload: { source: "loopover_gate_check" },
    });
    // An undefined incoming conclusion normalizes to null too -> byte-identical, no visible change.
    const changed = await recordPublishedGateCheckSummary(env, { ...base, conclusion: undefined });
    expect(changed).toBe(false);
  });

  it("returns CHANGED (never suppresses) when there is no head SHA to key the summary on", async () => {
    const env = createTestEnv();
    const changed = await recordPublishedGateCheckSummary(env, { ...base, headSha: null, conclusion: "success" });
    expect(changed).toBe(true);
    // Nothing was persisted for a headless publish.
    expect(await getCheckSummaryByHead(env, base.repoFullName, base.headSha, LOOPOVER_GATE_CHECK_NAME)).toBeNull();
  });
});
