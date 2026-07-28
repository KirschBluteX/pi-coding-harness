import { describe, expect, it } from "vitest";
import { PromptHistoryRewriteError, PromptRequestChain } from "../../src/context/prompt-request.js";

describe("PromptRequest append chain", () => {
  it("normalizes undefined transport-only fields before logical hashing", () => {
    const chain = new PromptRequestChain("secret");
    expect(() => chain.append({
      promptGenerationId: "PROMPT-GEN-001",
      logicalMessages: [{ role: "toolResult", content: "value", details: undefined }],
      providerPayload: { model: "configured", messages: [] },
    })).not.toThrow();
  });

  it("records FIRST, APPEND and RETRY_EQUIVALENT without prompt content", () => {
    const chain = new PromptRequestChain("secret", () => new Date("2026-07-22T00:00:00Z"));
    const first = chain.append({
      promptGenerationId: "PROMPT-GEN-001", logicalMessages: [{ role: "user", content: "secret prompt" }],
      providerPayload: { model: "x", messages: [{ role: "user", content: "secret prompt" }] },
    });
    const append = chain.append({
      promptGenerationId: "PROMPT-GEN-001",
      logicalMessages: [{ role: "user", content: "secret prompt" }, { role: "assistant", content: "result" }],
      providerPayload: { model: "x", messages: [{ role: "user", content: "secret prompt" }, { role: "assistant", content: "result" }] },
    });
    const retry = chain.append({
      promptGenerationId: "PROMPT-GEN-001",
      logicalMessages: [{ role: "user", content: "secret prompt" }, { role: "assistant", content: "result" }],
      providerPayload: { model: "x", messages: [{ role: "user", content: "secret prompt" }, { role: "assistant", content: "result" }] },
    });
    expect([first.history_action, append.history_action, retry.history_action]).toEqual(["FIRST", "APPEND", "RETRY_EQUIVALENT"]);
    expect(append.previous_prompt_request_id).toBe(first.prompt_request_id);
    expect(retry.previous_prompt_request_id).toBe(append.prompt_request_id);
    expect(append.provider_prompt_observability).toBe("UNOBSERVABLE");
    expect(JSON.stringify([first, append, retry])).not.toContain("secret prompt");
  });

  it("rejects an undeclared history rewrite", () => {
    const chain = new PromptRequestChain("secret");
    chain.append({ promptGenerationId: "PROMPT-GEN-001", logicalMessages: [{ role: "user", content: "A" }], providerPayload: {} });
    expect(() => chain.append({ promptGenerationId: "PROMPT-GEN-001", logicalMessages: [{ role: "user", content: "B" }], providerPayload: {} }))
      .toThrow(PromptHistoryRewriteError);
  });
});
