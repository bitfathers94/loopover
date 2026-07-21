import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect(options: Parameters<typeof startFixtureServer>[0] = {}) {
  configDir = mkdtempSync(join(tmpdir(), "loopover-live-gate-thresholds-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    ...options,
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/live-gate-thresholds")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "live-gate-thresholds-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_get_live_gate_thresholds stdio proxy (#7801)", () => {
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_get_live_gate_thresholds");
  });

  it("proxies owner/repo to /v1/repos/:owner/:repo/live-gate-thresholds via apiGet", async () => {
    await connect();
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "owner", repo: "repo" } });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/repos/owner/repo/live-gate-thresholds");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("owner/repo");
    expect(text).toContain("confidence_floor");
  });

  it("surfaces the route's not-found (404) as a tool error", async () => {
    await connect({ intakeStatus: 404 });
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});
