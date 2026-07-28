import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compileResponseContract, type ResponseEvent } from "../../src/output/response-contract.js";

const schema = JSON.parse(readFileSync(resolve("schemas", "response-contract.schema.json"), "utf8")) as object;
const validate = new Ajv2020({ strict: true }).compile(schema);

function event(patch: Partial<ResponseEvent> = {}): ResponseEvent {
  return { eventId: "EVENT-001", origin: "USER_REQUEST", executionPath: "AGENT_TURN", informationDelta: "MATERIAL", reason: "test", ...patch };
}

describe("ResponseContract compiler", () => {
  it.each([
    event(),
    event({ origin: "LOCAL_PROGRESS", executionPath: "LOCAL_ONLY", informationDelta: "NO_CHANGE" }),
    event({ kind: "TOOL_ACTION" }),
    event({ question: true, recommendationRequired: true, informationDelta: "USER_REQUIRED" }),
    event({ origin: "FINALIZATION", informationDelta: "FINAL", artifactExpected: true, mandatorySlots: ["VERIFICATION"] }),
    event({ requestedFormat: true, estimatedRequiredTextTokens: 5000 }),
  ])("emits a schema-valid contract without a rewrite request", (input) => {
    const contract = compileResponseContract(input);
    expect(validate(contract), JSON.stringify(validate.errors)).toBe(true);
    expect(contract.rewrite_request_allowed).toBe(false);
  });

  it("permits silence only for a no-change local emission", () => {
    expect(compileResponseContract(event({ origin: "LOCAL_PROGRESS", executionPath: "LOCAL_ONLY", informationDelta: "NO_CHANGE" })).response_class).toBe("SILENT_LOCAL");
    expect(() => compileResponseContract(event({ executionPath: "LOCAL_ONLY" }))).toThrow(/user request/u);
  });

  it("creates and closes TOOL_THEN_RESULT obligations", () => {
    expect(compileResponseContract(event({ kind: "TOOL_ACTION" })).completion_requirement).toBe("TOOL_THEN_RESULT");
    const result = compileResponseContract(event({ pendingToolObligation: true, informationDelta: "FINAL" }));
    expect(result.completion_requirement).toBe("RESULT_NOW");
    expect(result.mandatory_slots).toContain("RESULT");
  });

  it("expands a soft budget for mandatory content instead of truncating it", () => {
    const contract = compileResponseContract(event({ mandatorySlots: ["RESULT", "EVIDENCE", "VERIFICATION"], estimatedRequiredTextTokens: 900 }));
    expect(contract.soft_text_token_budget).toBe(900);
    expect(contract.budget_basis).toBe("MANDATORY_SLOT_ESTIMATE");
    expect(contract.hard_truncation_allowed).toBe(false);
  });
});
