import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "repo-focus-manifest-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedOwnedRepo(env: Env, installationId: number, owner: string, name: string): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request", "repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, default_branch: "main", owner: { login: owner } }, installationId);
}

type FocusManifestData = {
  repoFullName: string;
  manifest: { wantedPaths?: string[]; linkedIssuePolicy?: string } | null;
  policy: Record<string, unknown> | null;
};

describe("MCP loopover_get_repo_focus_manifest (#7808)", () => {
  it("returns the repo's own stored manifest and compiled policy for an owner session", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await upsertRepoFocusManifest(env, "repo-owner/owned-repo", {
      wantedPaths: ["src/"],
      linkedIssuePolicy: "required",
      testExpectations: ["Run npm run test:ci."],
    });

    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });
    const result = await client.callTool({ name: "loopover_get_repo_focus_manifest", arguments: { owner: "repo-owner", repo: "owned-repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as FocusManifestData;
    expect(data.repoFullName).toBe("repo-owner/owned-repo");
    expect(data.manifest?.wantedPaths).toEqual(["src/"]);
    expect(data.manifest?.linkedIssuePolicy).toBe("required");
    expect(data.policy).toBeTruthy();
  });

  it("compiles a default policy when the repo has no stored manifest", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    const { session } = await createSessionForGitHubUser(env, { login: "operator", id: 999 });
    const client = await connect(env, { kind: "session", actor: "operator", session });
    const result = await client.callTool({ name: "loopover_get_repo_focus_manifest", arguments: { owner: "repo-owner", repo: "owned-repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as FocusManifestData;
    expect(data.repoFullName).toBe("repo-owner/owned-repo");
    expect(data.policy).toBeTruthy();
  });

  it("forbids a session with no maintainer/owner/operator role", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    const { session } = await createSessionForGitHubUser(env, { login: "unknown-user", id: 404 });
    const client = await connect(env, { kind: "session", actor: "unknown-user", session });
    const result = await client.callTool({ name: "loopover_get_repo_focus_manifest", arguments: { owner: "repo-owner", repo: "owned-repo" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/maintainer, owner, or operator role is required/i);
  });

  it("forbids an owner session from reading a repo outside its scope", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await seedOwnedRepo(env, 202, "victim-org", "secret-repo");
    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });
    const result = await client.callTool({ name: "loopover_get_repo_focus_manifest", arguments: { owner: "victim-org", repo: "secret-repo" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository's focus manifest/i);
  });

  it("forbids the static mcp identity even with an unscoped MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "*" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_repo_focus_manifest", arguments: { owner: "repo-owner", repo: "owned-repo" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/shared MCP token cannot read a repo's stored focus manifest/i);
  });

  it("trusts the api static identity unconditionally", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await upsertRepoFocusManifest(env, "repo-owner/owned-repo", { wantedPaths: ["src/"], linkedIssuePolicy: "optional" });
    const client = await connect(env, { kind: "static", actor: "api" });
    const result = await client.callTool({ name: "loopover_get_repo_focus_manifest", arguments: { owner: "repo-owner", repo: "owned-repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as FocusManifestData;
    expect(data.manifest?.linkedIssuePolicy).toBe("optional");
    expect(data.policy).toBeTruthy();
  });
});
