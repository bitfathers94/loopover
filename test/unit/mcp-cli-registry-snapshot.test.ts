import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect(options: { registrySnapshotMissing?: boolean } = {}) {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-registry-snapshot-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    ...(options.registrySnapshotMissing ? { registrySnapshotMissing: true } : {}),
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/v1/registry/snapshot")) {
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
  client = new Client({ name: "registry-snapshot-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_get_registry_snapshot stdio proxy", () => {
  it("registers the tool in the stdio server tool list", async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_get_registry_snapshot");
  });

  it("proxies the call to the public GET /v1/registry/snapshot route via apiGet and returns the snapshot", async () => {
    await connect();
    const result = await client.callTool({ name: "loopover_get_registry_snapshot", arguments: {} });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/registry/snapshot");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("snapshot-1");
    expect(text).toContain("gittensor-core/example");
  });

  it("surfaces the route's not-found error when no snapshot has been cached yet", async () => {
    await connect({ registrySnapshotMissing: true });
    const result = await client.callTool({ name: "loopover_get_registry_snapshot", arguments: {} });
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0]!.url).toContain("/v1/registry/snapshot");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("registry_snapshot_not_found");
  });
});
