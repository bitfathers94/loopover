import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-maintainer-packet-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Add retry to the upload client",
    state: "open",
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    head: { sha: "abc123", ref: "contributor/attempt-1" },
    base: { ref: "main" },
    html_url: "https://github.com/owner/repo/pull/7",
    merged_at: null,
    draft: false,
    mergeable: true,
    body: "Closes #1",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    closed_at: null,
    labels: [{ name: "enhancement" }],
    ...overrides,
  };
}

async function seedRepo(env: Env) {
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" }, default_branch: "main" });
}

type MaintainerPacketResponse = {
  status: string;
  source?: string;
  repoFullName?: string;
  generatedAt?: string;
  report?: { generatedAt?: string; pullNumber?: number; reviewPriority?: string; dataQuality?: unknown };
};

describe("MCP loopover_get_pr_maintainer_packet (#7802)", () => {
  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_maintainer_packet", arguments: { owner: "owner", repo: "repo", number: 7 } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as MaintainerPacketResponse).status).toBe("forbidden");
  });

  it("returns not_found when the repository or pull request is missing", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    const client = await connect(env);
    // Repo present, PR absent → still not_found (the route requires both).
    const missingPr = await client.callTool({ name: "loopover_get_pr_maintainer_packet", arguments: { owner: "owner", repo: "repo", number: 404 } });
    expect((missingPr.structuredContent as MaintainerPacketResponse).status).toBe("not_found");

    // Repo absent entirely → not_found via the first operand of the guard.
    const noRepo = await connect(createTestEnv());
    const missingRepo = await noRepo.callTool({ name: "loopover_get_pr_maintainer_packet", arguments: { owner: "owner", repo: "ghost", number: 7 } });
    expect((missingRepo.structuredContent as MaintainerPacketResponse).status).toBe("not_found");
  });

  it("computes the maintainer packet from cached metadata for an open PR", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", prPayload());
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_maintainer_packet", arguments: { owner: "owner", repo: "repo", number: 7 } });
    const data = result.structuredContent as MaintainerPacketResponse;
    expect(result.isError).toBeFalsy();
    expect(data.status).toBe("ready");
    expect(data.source).toBe("computed");
    expect(data.repoFullName).toBe("owner/repo");
    expect(typeof data.generatedAt).toBe("string");
    expect(data.report?.pullNumber).toBe(7);
    expect(typeof data.report?.reviewPriority).toBe("string");
    // attachDataQuality wraps the packet with a repo data-quality block, mirroring the REST route.
    expect(data.report?.dataQuality).toBeDefined();
    expect(data.generatedAt).toBe(data.report?.generatedAt);
  });
});
