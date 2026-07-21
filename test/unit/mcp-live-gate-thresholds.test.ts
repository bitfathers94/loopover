import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { writeLiveOverride, writeShadowOverride, type StorageEnv } from "../../src/review/auto-apply";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-live-gate-thresholds-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type ThresholdsResponse = {
  status: string;
  repoFullName?: string;
  confidence_floor?: number | null;
  scope_cap_files?: number | null;
  scope_cap_lines?: number | null;
};

describe("MCP loopover_get_live_gate_thresholds (#7801)", () => {
  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    // A live override exists, but the allowlist gate must short-circuit before any threshold is read.
    await writeLiveOverride(env as unknown as StorageEnv, "owner/repo", { confidenceFloor: 0.9 });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as ThresholdsResponse).status).toBe("forbidden");
  });

  it("returns not_found when neither a live nor a shadow override is active", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "owner", repo: "repo" } });
    const data = result.structuredContent as ThresholdsResponse;
    expect(result.isError).toBeFalsy();
    expect(data.status).toBe("not_found");
    expect(data.repoFullName).toBe("owner/repo");
  });

  it("returns the live override thresholds, winning over a soaking shadow", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, "owner/repo", { confidenceFloor: 0.91, scopeCap: { files: 8, lines: 250 } });
    await writeShadowOverride(storageEnv, "owner/repo", { confidenceFloor: 0.4 }, "2099-01-01T00:00:00.000Z");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "owner", repo: "repo" } });
    const data = result.structuredContent as ThresholdsResponse;
    expect(data.status).toBe("ready");
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.confidence_floor).toBe(0.91);
    expect(data.scope_cap_files).toBe(8);
    expect(data.scope_cap_lines).toBe(250);
  });

  it("falls back to the soaking shadow override when no live override is active", async () => {
    const env = createTestEnv();
    await writeShadowOverride(env as unknown as StorageEnv, "owner/repo", { confidenceFloor: 0.66, scopeCap: { files: 3, lines: 90 } }, "2099-01-01T00:00:00.000Z");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "owner", repo: "repo" } });
    const data = result.structuredContent as ThresholdsResponse;
    expect(data.status).toBe("ready");
    expect(data.confidence_floor).toBe(0.66);
    expect(data.scope_cap_files).toBe(3);
    expect(data.scope_cap_lines).toBe(90);
  });
});
