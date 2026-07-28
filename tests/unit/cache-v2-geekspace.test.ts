import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import {
  classifyGeekspaceOpenAiCompletionsUsage,
  geekspaceOpenAiCompletionsIntegrationId,
  resolveGeekspaceOpenAiCompletions,
} from "../../src/cache-v2/geekspace-openai-completions.js";

const config = (JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig).modules.cache;
const selected = {
  provider: "geekspace", api: "openai-completions", base_url: "https://geekspace.cloud/v1/",
  model: "user-selected-model", thinking_level: "max", context_window: 272_000,
};

describe("Geekspace OpenAI-completions Cache contract", () => {
  it("matches provider, API and normalized base URL without pinning model settings", () => {
    expect(resolveGeekspaceOpenAiCompletions(config, selected)).toMatchObject({
      integrationId: geekspaceOpenAiCompletionsIntegrationId,
    });
    expect(resolveGeekspaceOpenAiCompletions(config, { ...selected, model: "another-user-model", thinking_level: "off" }))
      .not.toBeNull();
  });

  it.each([
    { provider: "other" },
    { api: "openai-responses" },
    { base_url: "https://other.example/v1" },
    { base_url: "http://geekspace.cloud/v1" },
  ])("falls back for a mismatched runtime: %j", (patch) => {
    expect(resolveGeekspaceOpenAiCompletions(config, { ...selected, ...patch })).toBeNull();
  });

  it("accepts only positive provider Cache reads as a proven HIT", () => {
    expect(classifyGeekspaceOpenAiCompletionsUsage({
      usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, reasoning: 1 }, responseStatus: 200,
    })).toEqual({ observationState: "HIT", evidenceLevel: "PROVIDER_USAGE" });
    expect(classifyGeekspaceOpenAiCompletionsUsage({
      usage: { input: 110, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 }, responseStatus: 200,
    })).toEqual({ observationState: "UNOBSERVABLE", evidenceLevel: "METADATA_ONLY" });
  });

  it("does not derive Cache claims from redirects, errors, or incomplete usage", () => {
    const usage = { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, reasoning: 1 };
    expect(classifyGeekspaceOpenAiCompletionsUsage({ usage, responseStatus: 302 }).observationState).toBe("UNOBSERVABLE");
    expect(classifyGeekspaceOpenAiCompletionsUsage({ usage, responseStatus: 500 }).observationState).toBe("ERROR");
    expect(classifyGeekspaceOpenAiCompletionsUsage({
      usage: { ...usage, input: null }, responseStatus: 200,
    }).observationState).toBe("UNOBSERVABLE");
  });
});
