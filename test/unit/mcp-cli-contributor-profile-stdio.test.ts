import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7760: in-process coverage for the loopover_get_contributor_profile stdio tool in
// packages/loopover-mcp/bin/loopover-mcp.ts. The remote MCP tool, the REST route, and the
// `contributor-profile` CLI already existed; only the stdio registration was missing. Same #7764
// entrypoint-guard pattern as mcp-cli-registry-snapshot.test.ts — import the .ts source (not a gitignored
// .js build artifact), hold the exported `server`, and connect an in-memory transport so v8/Codecov
// attributes the new registerStdioTool lines. The exported `contributorProfileCli` is driven directly to
// cover the CLI line rerouted through the shared getContributorProfile helper.
const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
  contributorProfileCli: (options: Record<string, unknown>) => Promise<void>;
};

let tempDir = "";
let mod: BinModule;
const capturedRequests: Array<{ url: string; method: string }> = [];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-contributor-profile-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (/^\/v1\/contributors\/[^/]+\/profile$/.test(request.url ?? "")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_get_contributor_profile stdio tool (in-process, #7760)", () => {
  it("registers and proxies GET /v1/contributors/:login/profile", async () => {
    capturedRequests.length = 0;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "contributor-profile-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_contributor_profile");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/contributor profile/i);

      const result = await client.callTool({ name: "loopover_get_contributor_profile", arguments: { login: "octocat" } });
      expect(result.isError).toBeFalsy();
      expect(capturedRequests).toEqual([{ url: "/v1/contributors/octocat/profile", method: "GET" }]);
      expect(result.structuredContent).toMatchObject({ login: "octocat" });
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/wallet|hotkey|reward estimate|trust score/i);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("routes the contributor-profile CLI through the shared getContributorProfile helper", async () => {
    capturedRequests.length = 0;
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await mod.contributorProfileCli({ login: "octocat", json: true });
    } finally {
      spy.mockRestore();
    }
    expect(capturedRequests).toEqual([{ url: "/v1/contributors/octocat/profile", method: "GET" }]);
    const payload = JSON.parse(chunks.join(""));
    expect(payload).toMatchObject({ login: "octocat" });
  });
});
