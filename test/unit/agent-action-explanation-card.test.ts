import { describe, expect, it } from "vitest";
import { __agentActionExplanationCardInternals } from "../../src/services/agent-action-explanation-card";
import { PUBLIC_TOKEN_SAMPLES } from "../helpers/public-token-samples";

describe("sanitizePublicCardText token redaction (#9697 shared token source)", () => {
  const { sanitizePublicCardText } = __agentActionExplanationCardInternals;

  it.each(PUBLIC_TOKEN_SAMPLES)("redacts every token prefix in PUBLIC_TOKEN_INLINE: %s", (token) => {
    // This surface previously matched only github_pat_/gh[pousr]_ and passed gts_/orbenr_/orbsec_/glpat-/sk-/xox through.
    expect(sanitizePublicCardText(`leak ${token} here`)).toBe("leak <redacted> here");
  });

  it("leaves a non-token card string unmodified", () => {
    expect(sanitizePublicCardText("Prepare a public-safe PR packet")).toBe("Prepare a public-safe PR packet");
  });
});
