import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// #8690: the SUBPROCESS chokepoint suite (mcp-local-telemetry-chokepoint.test.ts) spawns the real CLI and so
// contributes no in-process coverage; and the bin's own chokepoint (recordStdioToolTelemetry /
// registerStdioTool) is only ever reached through the in-process mcp-cli-* suites via a DYNAMIC `import()`,
// which vitest's `--changed` selection cannot trace -- so a diff that touches only the chokepoint (this fix)
// would leave those bin lines unexercised under scoped selection and fail codecov/patch. This file imports the
// bin in-process and drives the chokepoint on BOTH the success and the throw path, asserting the awaited
// PostHog flush (the fix) actually runs before the tool response / error reaches the caller.
//
// posthog-node is mocked so the awaited flush is observable with no network POST: flushSpy proves the
// chokepoint awaited recordMcpToolCall's flush; captureSpy proves the allowlisted event shape per path.
const h = vi.hoisted(() => ({ captureSpy: vi.fn(), flushSpy: vi.fn() }));

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(message: unknown): void {
      h.captureSpy(message);
    }
    async flush(): Promise<void> {
      h.flushSpy();
    }
  },
}));

type CapturedMessage = { properties?: Record<string, unknown> };

// Imported through a variable specifier (not a string literal), matching the mcp-cli-* in-process suites: a
// literal `import(".../loopover-mcp.ts")` would make tsc statically pull the bin into this typecheck program
// (TS5097 on the .ts extension, plus the bin's own import.meta.resolve overloads under the root tsconfig).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

let tempDir: string;
let client: Client;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-mcp-chokepoint-inproc-"));
  // Opt in through the persisted config the bin reads at module load, so telemetryState().enabled is true and
  // every stdio tool call routes a (mocked) PostHog flush through the chokepoint -- the same opt-in a user
  // makes via `loopover-mcp telemetry enable`, written directly here since the bin is imported, not spawned.
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({ telemetryEnabled: true }));
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_MCP_POSTHOG_API_KEY = "phc_inproc_test";
  // An unreachable API with a tight timeout: the two tools below never need it (one computes offline, the
  // other throws before any request), so nothing hangs on it.
  process.env.LOOPOVER_API_URL = "http://127.0.0.1:1";
  process.env.LOOPOVER_API_TIMEOUT_MS = "400";
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  // No resolvable GitHub login, so loopover_get_pr_ai_review_findings's handler throws (exercising the
  // chokepoint's catch/rethrow path) instead of proxying to the API.
  delete process.env.LOOPOVER_LOGIN;
  delete process.env.GITHUB_LOGIN;

  const mod = (await import(BIN_MODULE)) as unknown as {
    server: { connect: (transport: unknown) => Promise<void> };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mod.server.connect(serverTransport);
  client = new Client({ name: "chokepoint-inproc-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_MCP_POSTHOG_API_KEY;
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("loopover-mcp stdio telemetry chokepoint awaits the flush in-process (#8690)", () => {
  beforeEach(() => {
    h.captureSpy.mockClear();
    h.flushSpy.mockClear();
  });

  it("awaits the telemetry flush on a successful tool call before the response returns", async () => {
    const result = await client.callTool({
      name: "loopover_lint_pr_text",
      arguments: {
        commitMessages: ["fix(mcp): await the local telemetry flush"],
        prBody: "Awaits the flush before the CLI returns. Validated with npm test.",
        linkedIssue: 8690,
      },
    });
    expect(result.isError).toBeFalsy();

    // The awaited flush (#8690) ran through the chokepoint before the tool response resolved -- on unfixed
    // main the fire-and-forget wrapper resolved without ever flushing.
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties?.tool).toBe("loopover_lint_pr_text");
    expect(message.properties?.caller_type).toBe("local");
    expect(message.properties?.ok).toBe(true);
  });

  it("awaits the telemetry flush on the throw path before the error propagates", async () => {
    const result = await client.callTool({
      name: "loopover_get_pr_ai_review_findings",
      arguments: { owner: "octo", repo: "demo", number: 1 },
    });
    // The handler threw (no resolvable login); the MCP SDK surfaces that to the caller as an error result.
    expect(result.isError).toBe(true);

    // The chokepoint's catch path still awaited the flush (ok=false) before the error reached the caller.
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties?.tool).toBe("loopover_get_pr_ai_review_findings");
    expect(message.properties?.ok).toBe(false);
  });
});
