import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7755: in-process coverage for the loopover_generate_contributor_issue_drafts stdio tool in
// packages/loopover-mcp/bin/loopover-mcp.ts. The bin's stdio server is otherwise only exercised via subprocess
// spawn (mcp-cli-*.test.ts), which v8 cannot instrument -- the entrypoint guard (isProcessEntrypoint) is what
// lets a test import the module without it hijacking the runner's argv or binding stdin, so the new proxy lines
// get real Codecov-measured coverage. Only the committed .ts source is imported (the compiled .js is a gitignored
// build artifact since #7705), matching the sibling loopover_plan_repo_issues stdio test.
const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
let mod: BinModule;
const draftRequests: Array<{ dryRun?: boolean; create?: boolean; limit?: number }> = [];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-generate-issue-drafts-"));
  const apiUrl = await startFixtureServer({ onIssueDraftRequest: (body) => draftRequests.push(body) });
  // The bin reads LOOPOVER_API_URL at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(MODULE)) as unknown as BinModule;
});

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_generate_contributor_issue_drafts stdio tool (in-process, #7755)", () => {
  it("dry-runs by default and returns the proposed/created counts", async () => {
    draftRequests.length = 0;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "generate-issue-drafts-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "loopover_generate_contributor_issue_drafts",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(result.isError).toBeFalsy();
      // Schema defaults forward dryRun:true/create:false verbatim, keeping the route's create-safety exact.
      expect(draftRequests[0]).toMatchObject({ dryRun: true, create: false });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("Contributor issue drafts for owner/repo (dryRun=true): 1 proposed, 0 created.");
      expect(result.structuredContent).toMatchObject({ repoFullName: "owner/repo", dryRun: true, proposed: 1, created: 0 });

      // Explicit {create:true, dryRun:false} is the only shape that reaches the write path.
      const created = await client.callTool({
        name: "loopover_generate_contributor_issue_drafts",
        arguments: { owner: "owner", repo: "repo", create: true, dryRun: false, limit: 3 },
      });
      expect(created.isError).toBeFalsy();
      expect(draftRequests[1]).toMatchObject({ create: true, dryRun: false, limit: 3 });
      const createdText = (created.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(createdText).toContain("Contributor issue drafts for owner/repo (dryRun=false): 1 proposed, 1 created.");
    } finally {
      await client.close();
    }
  });
});
