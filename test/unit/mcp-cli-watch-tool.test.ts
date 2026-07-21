import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

// #6746: the contributor-scoped `watch` CLI and remote loopover_watch_issues tool, exposed as a stdio tool.
// These assert the proxy contract -- that the tool reaches the /v1/contributors/:login/watches route its CLI
// sibling already calls, with the same method and body -- rather than re-testing the route (test/unit/
// mcp-cli-watch.test.ts already covers that via the CLI).
let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let configDir: string | null = null;
let apiRequests: Array<{ url: string; method: string }>;
let watchBodies: Array<{ method: string; body: { repoFullName?: string; labels?: string[] } }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-watch-tool-"));
  apiRequests = [];
  watchBodies = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if ((request.url ?? "").includes("/watches")) apiRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
    },
    onWatchRequest: (req) => watchBodies.push(req),
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
  client = new Client({ name: "watch-tool-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  transport = null;
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

describe("loopover-mcp watch_issues stdio proxy (#6746)", () => {
  it("registers the tool in the stdio server tool list", async () => {
    await connect();
    const names = (await client!.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("loopover_watch_issues");
  });

  it("lists the tool via `loopover-mcp tools --json` with a non-empty description", async () => {
    await connect();
    const payload = JSON.parse(run(["tools", "--json"])) as { tools: Array<{ name: string; description: string }> };
    const entry = payload.tools.find((tool) => tool.name === "loopover_watch_issues");
    expect(entry, "missing descriptor for loopover_watch_issues").toBeTruthy();
    expect(entry!.description.trim().length).toBeGreaterThan(0);
  });

  it("defaults to list (GET) when no action is given, url-encoding the login", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_watch_issues", arguments: { login: "a b/c" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).toContain("acme/widgets");
    expect(apiRequests).toEqual([{ method: "GET", url: "/v1/contributors/a%20b%2Fc/watches" }]);
    expect(watchBodies).toEqual([]);
  });

  it("watch POSTs {repoFullName, labels} when labels are supplied", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_watch_issues",
      arguments: { login: "octocat", action: "watch", repoFullName: "acme/widgets", labels: ["bug", "feature"] },
    });
    expect(result.isError).toBeFalsy();
    expect(watchBodies).toEqual([{ method: "POST", body: { repoFullName: "acme/widgets", labels: ["bug", "feature"] } }]);
    expect(apiRequests).toEqual([{ method: "POST", url: "/v1/contributors/octocat/watches" }]);
  });

  it("watch without labels sends no labels field", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_watch_issues",
      arguments: { login: "octocat", action: "watch", repoFullName: "acme/widgets" },
    });
    expect(result.isError).toBeFalsy();
    expect(watchBodies).toEqual([{ method: "POST", body: { repoFullName: "acme/widgets" } }]);
  });

  it("unwatch DELETEs {repoFullName}", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_watch_issues",
      arguments: { login: "octocat", action: "unwatch", repoFullName: "acme/widgets" },
    });
    expect(result.isError).toBeFalsy();
    expect(watchBodies).toEqual([{ method: "DELETE", body: { repoFullName: "acme/widgets" } }]);
    expect(apiRequests).toEqual([{ method: "DELETE", url: "/v1/contributors/octocat/watches" }]);
  });

  it("watch/unwatch without repoFullName returns a plain result and makes no API call", async () => {
    await connect();
    for (const action of ["watch", "unwatch"] as const) {
      const result = await client!.callTool({ name: "loopover_watch_issues", arguments: { login: "octocat", action } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain(`${action} requires repoFullName`);
    }
    expect(apiRequests).toEqual([]);
    expect(watchBodies).toEqual([]);
  });
});
