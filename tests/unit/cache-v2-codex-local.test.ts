import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import {
  classifyCodexLocalOpenAiResponsesUsage,
  codexLocalOpenAiResponsesIntegrationId,
  resolveCodexLocalOpenAiResponses,
} from "../../src/cache-v2/codex-local-openai-responses.js";

const defaults = (JSON.parse(readFileSync("config/default.json", "utf8")) as CodingHarnessConfig).modules.cache;
const config = {
  ...defaults,
  epoch: "CACHE-C1-CODEX-LOCAL-OPENAI-RESPONSES-001",
  provider_integration: codexLocalOpenAiResponsesIntegrationId,
};
const selected = {
  provider: "codex-local", api: "openai-responses", base_url: "http://localhost:58493/v1/",
  model: "user-selected-model", thinking_level: "max", context_window: 272_000,
};

describe("Codex-local OpenAI-responses Cache contract", () => {
  it("matches only the qualified transport without pinning model settings or mutating inputs", () => {
    const configBefore = structuredClone(config);
    const selectedBefore = structuredClone(selected);
    expect(resolveCodexLocalOpenAiResponses(config, selected)).toMatchObject({
      integrationId: codexLocalOpenAiResponsesIntegrationId,
      usageSemanticsId: "PI-0.82-USAGE-DISJOINT-INPUT-CACHE-OUTPUT-V1",
    });
    expect(resolveCodexLocalOpenAiResponses(config, {
      ...selected, model: "another-user-model", thinking_level: "off", context_window: 100_000,
    })).not.toBeNull();
    expect(config).toEqual(configBefore);
    expect(selected).toEqual(selectedBefore);
  });

  it("accepts the configured Pi provider id without merging distinct provider profiles", () => {
    const configured = { ...selected, provider: "codex_local_access" };
    const contract = resolveCodexLocalOpenAiResponses(config, configured);
    expect(contract).not.toBeNull();
    expect(contract!.canonicalTransportIdentity(configured).provider).toBe("codex_local_access");
    expect(contract!.canonicalTransportIdentity(configured)).not.toEqual(
      contract!.canonicalTransportIdentity({ ...configured, provider: "another_local_profile" }),
    );
  });

  it("canonicalizes only transport-equivalent runtime spellings", () => {
    const contract = resolveCodexLocalOpenAiResponses(config, selected)!;
    expect(contract.canonicalTransportIdentity(selected)).toEqual(
      contract.canonicalTransportIdentity({
        ...selected,
        provider: "CODEX-LOCAL",
        base_url: "http://localhost:58493/v1",
      }),
    );
    expect(contract.canonicalTransportIdentity(selected)).not.toEqual(
      contract.canonicalTransportIdentity({ ...selected, model: "different-model" }),
    );
  });

  it.each([
    { provider: " " },
    { api: "openai-completions" },
    { base_url: "https://localhost:58493/v1" },
    { base_url: "http://127.0.0.1:58493/v1" },
    { base_url: "http://localhost:58494/v1" },
    { base_url: "http://localhost:58493/v1?mode=test" },
  ])("falls back for a mismatched runtime: %j", (runtimePatch) => {
    expect(resolveCodexLocalOpenAiResponses(config, { ...selected, ...runtimePatch })).toBeNull();
  });

  it("accepts only positive provider Cache reads on a 2xx response as a proven HIT", () => {
    expect(classifyCodexLocalOpenAiResponsesUsage({
      usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, reasoning: 1 }, responseStatus: 200,
    })).toEqual({ observationState: "HIT", evidenceLevel: "PROVIDER_USAGE" });
    expect(classifyCodexLocalOpenAiResponsesUsage({
      usage: { input: 110, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 }, responseStatus: 200,
    })).toEqual({ observationState: "UNOBSERVABLE", evidenceLevel: "METADATA_ONLY" });
  });

  it("does not derive Cache claims from redirects, errors, or incomplete usage", () => {
    const usage = { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, reasoning: 1 };
    expect(classifyCodexLocalOpenAiResponsesUsage({ usage, responseStatus: 302 }).observationState).toBe("UNOBSERVABLE");
    expect(classifyCodexLocalOpenAiResponsesUsage({ usage, responseStatus: 500 }).observationState).toBe("ERROR");
    expect(classifyCodexLocalOpenAiResponsesUsage({
      usage: { ...usage, cacheRead: null }, responseStatus: 200,
    }).observationState).toBe("UNOBSERVABLE");
  });
});
