import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7757: in-process coverage for the loopover_get_agent_audit_feed stdio tool.
// Same #7764 entrypoint-guard pattern as mcp-cli-live-gate-thresholds / registry-snapshot — import the .ts
// source, hold the exported `server`, connect InMemoryTransport so v8/Codecov attributes registerStdioTool.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-agent-audit-feed-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/agent/audit-feed")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_get_agent_audit_feed stdio tool (in-process, #7757)", () => {
  it.each(MODULES)("registers and proxies GET .../agent/audit-feed with no query — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "agent-audit-feed-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_agent_audit_feed");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/audit feed/i);

      // Bare call: the `since`/`limit` guards both take their false arm and query.size stays 0, so the URL
      // carries no `?` suffix.
      const result = await client.callTool({
        name: "loopover_get_agent_audit_feed",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toBe("/v1/repos/owner/repo/agent/audit-feed");
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).toContain("Agent audit feed for owner/repo.");
      expect(text).toContain("github_app.merged");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("forwards since + limit into the query string — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "agent-audit-feed-query-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      // Both guards take their true arm and query.size > 0, so the URL gains a `?since=...&limit=...` suffix.
      const result = await client.callTool({
        name: "loopover_get_agent_audit_feed",
        arguments: { owner: "owner", repo: "repo", since: "2026-05-29T00:00:00.000Z", limit: 1 },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toContain("/v1/repos/owner/repo/agent/audit-feed?");
      expect(captured.url).toContain("since=2026-05-29T00%3A00%3A00.000Z");
      expect(captured.url).toContain("limit=1");
      expect(result.isError).toBeFalsy();
      // The fixture honours ?limit by slicing the event list, so only the first event survives.
      const text = JSON.stringify(result);
      expect(text).toContain("github_app.merged");
      expect(text).not.toContain("github_app.review_evasion_closed");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
