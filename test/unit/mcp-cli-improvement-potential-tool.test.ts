import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #7759: in-process coverage for the loopover_check_improvement_potential stdio tool. Same #7764 entrypoint-guard
// pattern as mcp-cli-repo-focus-manifest — import the bin .ts, hold the exported `server`, connect an
// InMemoryTransport so v8/Codecov attributes the registerStdioTool block. The tool PROXIES POST
// /v1/lint/improvement-potential (the same endpoint the `improvement-potential` CLI already calls), so a live
// fixture server backs it rather than the dead-address in-process trick the slop-risk local tool uses.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-improvement-potential-tool-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request: IncomingMessage) => {
      if (request.url && request.url.includes("/lint/improvement-potential")) {
        capturedRequests.push({
          url: request.url ?? "",
          method: request.method ?? "GET",
        });
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
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_check_improvement_potential stdio tool (in-process, #7759)", () => {
  it.each(MODULES)(
    "registers the review-family tool with a source-free description — %s",
    async (specifier) => {
      const mod = loaded.get(specifier)!;
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await mod.server.connect(serverTransport);
      const client = new Client(
        { name: "improvement-potential-tool-test", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);
      try {
        const { tools } = await client.listTools();
        const tool = tools.find(
          (entry) => entry.name === "loopover_check_improvement_potential",
        );
        expect(tool).toBeDefined();
        expect(tool?.description).toMatch(
          /improvement potential|positive-signal/i,
        );
        expect(tool?.description).toContain("source-free");
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  );

  it.each(MODULES)(
    "proxies POST /v1/lint/improvement-potential and surfaces the assessment — %s",
    async (specifier) => {
      capturedRequests.length = 0;
      const mod = loaded.get(specifier)!;
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await mod.server.connect(serverTransport);
      const client = new Client(
        { name: "improvement-potential-tool-test", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "loopover_check_improvement_potential",
          arguments: {
            changedFiles: [
              { path: "src/widget.ts", additions: 80, deletions: 2 },
            ],
            testFiles: ["test/unit/widget.test.ts"],
          },
        });
        expect(capturedRequests.length).toBe(1);
        const captured = capturedRequests[0]!;
        expect(captured.url).toContain("/v1/lint/improvement-potential");
        expect(captured.method).toBe("POST");
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as {
          improvementScore: number;
          band: string;
          findings: unknown[];
        };
        // The fixture scores a code change accompanied by test evidence as a minor positive signal.
        expect(data.improvementScore).toBe(10);
        expect(data.band).toBe("minor");
        expect(data.findings).toEqual(expect.any(Array));
        expect(JSON.stringify(result)).not.toMatch(
          /hotkey|coldkey|wallet|mnemonic|payout|reward|trust score/i,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  );
});
