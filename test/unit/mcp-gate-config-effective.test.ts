import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { writeLiveOverride, writeShadowOverride, type StorageEnv } from "../../src/review/auto-apply";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-gate-config-effective-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_get_gate_config_effective (#7800)", () => {
  it("surfaces the resolved live override plus a soaking-shadow flag for an authorized caller", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, REPO, { confidenceFloor: 0.9, scopeCap: { files: 12, lines: 400 } });
    await writeShadowOverride(storageEnv, REPO, { confidenceFloor: 0.8 }, "2099-01-01T00:00:00.000Z");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      repoFullName: string;
      effective: { confidenceFloor: number | null; scopeCap: { files: number | null; lines: number | null } };
      shadowPending: boolean;
    };
    expect(data.repoFullName).toBe(REPO);
    expect(data.effective).toEqual({ confidenceFloor: 0.9, scopeCap: { files: 12, lines: 400 } });
    expect(data.shadowPending).toBe(true);
    // Never leak the raw shadow's queued value or the override audit trail through the tool payload.
    expect(JSON.stringify(result.content)).not.toMatch(/0\.8|override_audit|applied_at/);
    // Numeric + soaking branches of the summary.
    expect(JSON.stringify(result.content)).toContain("confidenceFloor 0.9, shadow soaking");
  });

  it("resolves a floor-only override to null scopeCap fields with no shadow", async () => {
    const env = createTestEnv();
    await writeLiveOverride(env as unknown as StorageEnv, REPO, { confidenceFloor: 0.5 });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      effective: { confidenceFloor: number | null; scopeCap: { files: number | null; lines: number | null } };
      shadowPending: boolean;
    };
    expect(data.effective).toEqual({ confidenceFloor: 0.5, scopeCap: { files: null, lines: null } });
    expect(data.shadowPending).toBe(false);
  });

  it("returns all-null effective thresholds when no override exists", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      effective: { confidenceFloor: number | null; scopeCap: { files: number | null; lines: number | null } };
      shadowPending: boolean;
    };
    expect(data.effective).toEqual({ confidenceFloor: null, scopeCap: { files: null, lines: null } });
    expect(data.shadowPending).toBe(false);
    // "unset" + "none" branches of the summary.
    expect(JSON.stringify(result.content)).toContain("confidenceFloor unset, shadow none");
  });

  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await writeLiveOverride(env as unknown as StorageEnv, REPO, { confidenceFloor: 0.9 });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
