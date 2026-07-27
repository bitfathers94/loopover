import { describe, expect, it } from "vitest";
import { buildReviewRiskExplanation } from "../../src/signals/review-risk";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

// Direct, correctness-level coverage of `buildReviewRiskExplanation`'s 5-way `recommendation`
// decision (#9287). Each case constructs its own minimal PreflightResult/RoleContext-shaped input
// to deterministically land on one branch of the
// `likely_duplicate -> maintainer_lane -> needs_author -> review -> watch` ladder, importing the
// real function from `src/signals/review-risk.ts` rather than asserting route parity like
// `routes-review-risk.test.ts` does.

// A registered repo with a positive emission share and no issue-discovery share resolves to the
// `direct_pr` lane, so the preflight lane is available (not "unknown"/"inactive") — the precondition
// for `status` reaching `ready`/`needs_work` instead of being forced to `hold`.
const directPrRepo: RepositoryRecord = {
  fullName: "acme/widgets",
  owner: "acme",
  name: "widgets",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "acme/widgets",
    emissionShare: 0.02,
    issueDiscoveryShare: 0,
    labelMultipliers: {},
    trustedLabelPipeline: false,
    maintainerCut: 0,
    raw: {},
  },
};

const summaryFor = (repoFullName: string) => `LoopOver review-risk explanation for ${repoFullName}.`;

describe("buildReviewRiskExplanation branch logic (#9287)", () => {
  it("recommends likely_duplicate when a high-risk collision cluster matches the planned linked issue", () => {
    // Two open PRs both link issue #42 -> `buildCollisionReport` emits a high-risk cluster, and the
    // planned contribution links the same issue so the cluster survives preflight filtering.
    const issues: IssueRecord[] = [
      { repoFullName: directPrRepo.fullName, number: 42, title: "Login redirect loops on expiry", state: "open", authorLogin: "reporter", labels: ["bug"], linkedPrs: [] },
    ];
    const pullRequests: PullRequestRecord[] = [
      { repoFullName: directPrRepo.fullName, number: 101, title: "Fix login redirect loop", state: "open", authorLogin: "alice", authorAssociation: "NONE", labels: ["bug"], linkedIssues: [42] },
      { repoFullName: directPrRepo.fullName, number: 102, title: "Alternative login redirect fix", state: "open", authorLogin: "bob", authorAssociation: "NONE", labels: ["bug"], linkedIssues: [42] },
    ];

    const explanation = buildReviewRiskExplanation({
      input: { repoFullName: directPrRepo.fullName, title: "Repair the login redirect loop", linkedIssues: [42] },
      repo: directPrRepo,
      issues,
      pullRequests,
    });

    expect(explanation.recommendation).toBe("likely_duplicate");
    expect(explanation.summary).toBe(summaryFor(directPrRepo.fullName));
    expect(explanation.preflight.collisions.some((cluster) => cluster.risk === "high")).toBe(true);
  });

  it("recommends maintainer_lane when the contributor owns the repo, even without collisions", () => {
    // `octocat` owns `octocat/hello-world` -> `buildRoleContext` sets role "owner" -> maintainerLane,
    // which outranks preflight status in the decision ladder.
    const explanation = buildReviewRiskExplanation({
      input: { repoFullName: "octocat/hello-world", title: "Tune the release cadence", contributorLogin: "octocat" },
      repo: null,
      issues: [],
      pullRequests: [],
    });

    expect(explanation.recommendation).toBe("maintainer_lane");
    expect(explanation.summary).toBe(summaryFor("octocat/hello-world"));
    expect(explanation.roleContext?.maintainerLane).toBe(true);
  });

  it("recommends needs_author when the available lane still yields a warning finding", () => {
    // Registered `direct_pr` lane keeps status off "hold", but no linked issue and no explicit
    // no-issue rationale raises the `missing_linked_issue` warning -> status "needs_work".
    const explanation = buildReviewRiskExplanation({
      input: { repoFullName: directPrRepo.fullName, title: "Add pagination to the activity list" },
      repo: directPrRepo,
      issues: [],
      pullRequests: [],
    });

    expect(explanation.recommendation).toBe("needs_author");
    expect(explanation.summary).toBe(summaryFor(directPrRepo.fullName));
    expect(explanation.preflight.status).toBe("needs_work");
  });

  it("recommends review when the lane is available, an issue is linked, and nothing warns", () => {
    // Available lane + a linked issue clears every warning finding -> status "ready". No
    // contributorLogin means no role context, so maintainer_lane cannot pre-empt this branch.
    const explanation = buildReviewRiskExplanation({
      input: { repoFullName: directPrRepo.fullName, title: "Correct the pagination off-by-one", linkedIssues: [7] },
      repo: directPrRepo,
      issues: [],
      pullRequests: [],
    });

    expect(explanation.recommendation).toBe("review");
    expect(explanation.summary).toBe(summaryFor(directPrRepo.fullName));
    expect(explanation.preflight.status).toBe("ready");
    expect(explanation.roleContext).toBeNull();
  });

  it("recommends watch when the lane is unavailable so preflight holds", () => {
    // An unregistered repo yields an "unknown" lane -> laneUnavailable -> status "hold", and with no
    // collisions and no maintainer-lane role context the ladder falls through to `watch`.
    const explanation = buildReviewRiskExplanation({
      input: { repoFullName: "stranger/repo", title: "Investigate an intermittent failure" },
      repo: null,
      issues: [],
      pullRequests: [],
    });

    expect(explanation.recommendation).toBe("watch");
    expect(explanation.summary).toBe(summaryFor("stranger/repo"));
    expect(explanation.preflight.status).toBe("hold");
    expect(explanation.roleContext).toBeNull();
  });
});
