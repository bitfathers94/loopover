import { describe, expect, it } from "vitest";
import {
  isPublicSafeText,
  PUBLIC_LOCAL_PATH_INLINE,
  PUBLIC_LOCAL_PATH_PREFIX_PATTERN,
  PUBLIC_LOCAL_PATH_SCRUB_PATTERN,
  PUBLIC_TOKEN_INLINE,
  PUBLIC_UNSAFE_PATTERN,
  publicTokenPattern,
} from "../../src/signals/redaction";
import { PUBLIC_TOKEN_SAMPLES } from "../helpers/public-token-samples";

describe("isPublicSafeText (#542 shared public/private boundary)", () => {
  it("accepts text with no private signals", () => {
    expect(isPublicSafeText("Add a retry to the cache reconnect path.")).toBe(true);
    expect(isPublicSafeText("- PR #12: changes requested.")).toBe(true);
    expect(isPublicSafeText("")).toBe(true);
  });

  it("rejects gittensor economic / identity signals", () => {
    for (const text of [
      "estimated reward is high",
      "your score will rise",
      "wallet 5F...",
      "hotkey leaked",
      "coldkey backup",
      "mnemonic phrase",
      "this looks like farming",
      "payout pending",
      "ranking change",
      "raw trust value",
      "raw-trust score",
      "trust_score 0.8",
      "private reviewability internals",
      "reviewability breakdown",
    ]) {
      expect(isPublicSafeText(text)).toBe(false);
    }
  });

  it("rejects plural signal nouns (the closing \\b must not slip the trailing 's' past a bare term)", () => {
    for (const text of ["your wallets here", "hotkeys", "coldkeys", "mnemonics", "payouts", "rankings", "rewards", "scores"]) {
      expect(isPublicSafeText(text)).toBe(false);
    }
  });

  it("rejects local filesystem paths (posix and Windows)", () => {
    expect(isPublicSafeText("/Users/alice/project")).toBe(false);
    expect(isPublicSafeText("/home/bob/repo")).toBe(false);
    expect(isPublicSafeText("/root/project/src")).toBe(false);
    expect(isPublicSafeText("clone failed at /root/work/repo")).toBe(false);
    expect(isPublicSafeText("/var/log/app.log")).toBe(false);
    expect(isPublicSafeText("/var/folders/alice/work/private-repo/cache.ts")).toBe(false);
    expect(isPublicSafeText("/tmp/scratch")).toBe(false);
    expect(isPublicSafeText("/private/tmp/loopover/cache")).toBe(false);
    expect(isPublicSafeText("C:\\Users\\carol\\repo")).toBe(false);
    expect(isPublicSafeText("C:/Users/carol/repo")).toBe(false);
    expect(isPublicSafeText("/opt/homebrew/var/log")).toBe(false);
    expect(isPublicSafeText("C:\\Program Files\\App\\config.json")).toBe(false);
    expect(isPublicSafeText("C:/Program Files/App/config.json")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPublicSafeText("WALLET")).toBe(false);
    expect(isPublicSafeText("Payout")).toBe(false);
  });

  it("uses a NON-global pattern so .test() is stateless (no lastIndex carry-over)", () => {
    expect(PUBLIC_UNSAFE_PATTERN.global).toBe(false);
    // A global regex would alternate true/false across repeated .test() calls on the same input.
    expect(PUBLIC_UNSAFE_PATTERN.test("wallet")).toBe(true);
    expect(PUBLIC_UNSAFE_PATTERN.test("wallet")).toBe(true);
    expect(isPublicSafeText("clean line")).toBe(true);
    expect(isPublicSafeText("clean line")).toBe(true);
  });
});

describe("shared local-path constants (#1418 drift fix)", () => {
  it("scrubs every local root, including /root/ and /var/, plus both Windows forms", () => {
    expect("clone at /Users/me/repo/src done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("clone at <p> done");
    expect("clone at /home/me/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("clone at <p> done");
    expect("clone at /root/work/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("clone at <p> done");
    expect("log at /var/log/app.log done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("log at <p> done");
    expect("brew at /opt/homebrew/var/log done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("brew at <p> done");
    expect("tmp at /tmp/build done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("tmp at <p> done");
    expect("mac at /private/tmp/build done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("mac at <p> done");
    expect("win at C:\\Users\\me\\repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    expect("win at C:/Users/me/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    // Lower-case drive letter: the source matches it case-insensitively, so a consumer that omits the `i`
    // flag (the `/g`-only scrubber in miner-dashboard-recommendations.ts) still redacts it (#1418 regression).
    expect("win at c:\\Users\\bob\\repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    expect("win at c:/Users/bob/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    expect("win at C:/Program Files/App/x done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
  });

  it("the lower-case Windows drive is matched by the raw source even without the `i` flag", () => {
    // miner-dashboard-recommendations.ts composes a `/g`-only (no `i`) scrubber from PUBLIC_LOCAL_PATH_INLINE,
    // so the drive-letter class in the source must itself be case-insensitive ([A-Za-z], not [A-Z]).
    const gOnly = new RegExp(`(?:${PUBLIC_LOCAL_PATH_INLINE})[^\\s]*`, "g");
    expect("at c:\\Users\\bob\\x".replace(gOnly, "<p>")).toBe("at <p>");
    expect("at C:\\Users\\bob\\x".replace(gOnly, "<p>")).toBe("at <p>");
  });

  it("the shared `/g` scrubber resets lastIndex between .replace() calls (safe to share across modules)", () => {
    const first = "a /tmp/one b".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>");
    const second = "a /tmp/one b".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>");
    expect(first).toBe("a <p> b");
    expect(second).toBe(first);
  });

  it("scrub pattern is global (safe for .replace across modules) and prefix pattern is anchored + non-global", () => {
    expect(PUBLIC_LOCAL_PATH_SCRUB_PATTERN.global).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.global).toBe(false);
  });

  it("prefix pattern matches a path that STARTS at a local root, not one merely containing it", () => {
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/root/work/repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/var/folders/me/repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("C:/Users/me/repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("C:\\Users\\me\\repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("src/signals/redaction.ts")).toBe(false);
    // Non-global so .test() stays stateless across repeated calls on the same input.
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/root/x")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/root/x")).toBe(true);
  });
});

describe("shared token constants (#9697 one token-prefix source of truth)", () => {
  it.each(PUBLIC_TOKEN_SAMPLES)("publicTokenPattern() matches every union prefix: %s", (token) => {
    expect(`leak ${token} here`.replace(publicTokenPattern(), "<redacted>")).toBe("leak <redacted> here");
  });

  it("includes the previously-divergent GitHub (gh[pousr]_) and Slack (xox[baprs]-) classes", () => {
    // ghs_ is the App-installation token this Worker mints on every pass; the three ghp_-only surfaces used
    // to pass it through verbatim. All four gh classes plus a Slack token now redact from one source.
    for (const token of ["ghs_", "gho_", "ghu_", "ghr_"].map((p) => `${p}${"A".repeat(24)}`)) {
      expect(`x ${token}`.replace(publicTokenPattern(), "<redacted>")).toBe("x <redacted>");
    }
    expect(`x xoxb-${"A".repeat(24)}`.replace(publicTokenPattern(), "<redacted>")).toBe("x <redacted>");
  });

  it("leaves a non-token string untouched", () => {
    expect("no secrets in this ordinary sentence".replace(publicTokenPattern(), "<redacted>")).toBe(
      "no secrets in this ordinary sentence",
    );
  });

  it("returns a fresh /g RegExp on every call and repeated .replace() stays idempotent (no shared lastIndex)", () => {
    const first = publicTokenPattern();
    const second = publicTokenPattern();
    expect(first).not.toBe(second);
    expect(first.global).toBe(true);
    expect(second.global).toBe(true);
    const input = `token ghs_${"A".repeat(24)} leaked`;
    const once = input.replace(publicTokenPattern(), "<redacted>");
    const twice = input.replace(publicTokenPattern(), "<redacted>");
    expect(once).toBe("token <redacted> leaked");
    expect(twice).toBe(once);
    // Even reusing one object across two .replace() calls must not carry lastIndex forward.
    const shared = publicTokenPattern();
    expect(input.replace(shared, "<redacted>")).toBe(input.replace(shared, "<redacted>"));
  });

  it("is the union of all four historical prefix lists (no prefix dropped)", () => {
    for (const prefix of ["gh[pousr]_", "github_pat_", "gts_", "orbenr_", "orbsec_", "glpat-", "sk-", "xox[baprs]-"]) {
      expect(PUBLIC_TOKEN_INLINE).toContain(prefix);
    }
  });
});
