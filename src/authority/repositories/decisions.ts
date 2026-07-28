import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { canonicalJson, canonicalJsonSha256 } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";

export interface DecisionOptionRecord {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly binding_sha256?: string;
}

export interface DecisionRequestRecord {
  readonly decisionId: string;
  readonly goalId: string;
  readonly question: string;
  readonly options: readonly DecisionOptionRecord[];
  readonly recommendedOptionId: string;
  readonly recommendationReason: string;
  readonly materiality: "LOW" | "MEDIUM" | "HIGH";
  readonly reversible: boolean;
  readonly defaultOptionId: string | null;
}

export interface DecisionResolutionRecord {
  readonly resolutionId: string;
  readonly decisionId: string;
  readonly selectedOptionId: string;
  readonly source: "USER" | "LOW_RISK_DEFAULT";
  readonly principalLocator: string | null;
  readonly resolutionSha256: string;
}

export interface StoredDecision {
  readonly request: DecisionRequestRecord;
  readonly resolution: DecisionResolutionRecord | null;
}

function storedText(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new AuthorityIntegrityError(`Decision field ${field} must be text`);
  return value;
}

function storedNullableText(row: Readonly<Record<string, unknown>>, field: string): string | null {
  return row[field] === null ? null : storedText(row, field);
}

function storedOptions(row: Readonly<Record<string, unknown>>): DecisionOptionRecord[] {
  let value: unknown;
  try { value = JSON.parse(storedText(row, "options_json")); }
  catch (error) { throw new AuthorityIntegrityError("Decision options are not valid JSON", error); }
  if (!Array.isArray(value) || value.length < 2 || value.some((option) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) return true;
    const record = option as Record<string, unknown>;
    return typeof record.id !== "string" || typeof record.label !== "string" || typeof record.description !== "string"
      || (record.binding_sha256 !== undefined && typeof record.binding_sha256 !== "string");
  })) throw new AuthorityIntegrityError("Decision options are structurally invalid");
  return value as DecisionOptionRecord[];
}

export class DecisionRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  insertRequest(input: DecisionRequestRecord, eventSequence: number): void {
    if (input.options.length < 2 || new Set(input.options.map((option) => option.id)).size !== input.options.length) {
      throw new AuthorityIntegrityError("Decision requires at least two uniquely identified options");
    }
    const ids = new Set(input.options.map((option) => option.id));
    if (!ids.has(input.recommendedOptionId) || (input.defaultOptionId !== null && !ids.has(input.defaultOptionId))) {
      throw new AuthorityIntegrityError("Decision recommendation/default must reference a declared option");
    }
    this.connection.prepare(`INSERT INTO decisions(
      decision_id,goal_id,question,options_json,recommended_option_id,recommendation_reason,
      materiality,reversible,default_option_id,requested_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      input.decisionId, input.goalId, input.question.normalize("NFC"), canonicalJson(input.options),
      input.recommendedOptionId, input.recommendationReason.normalize("NFC"), input.materiality,
      input.reversible ? 1 : 0, input.defaultOptionId, eventSequence,
    );
  }

  insertResolution(input: DecisionResolutionRecord, goalId: string, eventSequence: number): void {
    const row = this.connection.prepare("SELECT options_json,goal_id FROM decisions WHERE decision_id=?").get(input.decisionId) as { options_json?: unknown; goal_id?: unknown } | undefined;
    if (typeof row?.options_json !== "string") throw new AuthorityIntegrityError(`Decision ${input.decisionId} does not exist`);
    if (row.goal_id !== goalId) throw new AuthorityIntegrityError("Decision resolution Goal substitution");
    const options = JSON.parse(row.options_json) as DecisionOptionRecord[];
    if (!options.some((option) => option.id === input.selectedOptionId)) {
      throw new AuthorityIntegrityError("Decision resolution selected an undeclared option");
    }
    const expected = canonicalJsonSha256({
      decisionId: input.decisionId,
      principalLocator: input.principalLocator,
      selectedOptionId: input.selectedOptionId,
      source: input.source,
    });
    if (expected !== input.resolutionSha256) throw new AuthorityIntegrityError("Decision resolution hash substitution");
    this.connection.prepare(`INSERT INTO decision_resolutions(
      resolution_id,decision_id,selected_option_id,source,principal_locator,resolution_sha256,resolved_event_sequence
    ) VALUES(?,?,?,?,?,?,?)`).run(
      input.resolutionId, input.decisionId, input.selectedOptionId, input.source,
      input.principalLocator, input.resolutionSha256, eventSequence,
    );
  }

  resolutionSha256(resolutionId: string): string | null {
    const row = this.connection.prepare("SELECT resolution_sha256 FROM decision_resolutions WHERE resolution_id=?").get(resolutionId) as { resolution_sha256?: unknown } | undefined;
    return typeof row?.resolution_sha256 === "string" ? row.resolution_sha256 : null;
  }

  approval(resolutionId: string): { resolutionSha256: string; bindingSha256: string | null } | null {
    const row = this.connection.prepare(`SELECT dr.resolution_sha256,dr.selected_option_id,d.options_json
      FROM decision_resolutions dr JOIN decisions d ON d.decision_id=dr.decision_id
      WHERE dr.resolution_id=?`).get(resolutionId) as Record<string, unknown> | undefined;
    if (typeof row?.resolution_sha256 !== "string" || typeof row.options_json !== "string" || typeof row.selected_option_id !== "string") return null;
    const options = JSON.parse(row.options_json) as DecisionOptionRecord[];
    const selected = options.find((option) => option.id === row.selected_option_id);
    return { resolutionSha256: row.resolution_sha256, bindingSha256: selected?.binding_sha256 ?? null };
  }

  read(decisionId: string): StoredDecision | null {
    const row = this.connection.prepare(`SELECT d.decision_id,d.goal_id,d.question,d.options_json,d.recommended_option_id,
      d.recommendation_reason,d.materiality,d.reversible,d.default_option_id,
      r.resolution_id,r.selected_option_id,r.source,r.principal_locator,r.resolution_sha256
      FROM decisions d LEFT JOIN decision_resolutions r ON r.decision_id=d.decision_id WHERE d.decision_id=?`).get(decisionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const materiality = storedText(row, "materiality");
    if (materiality !== "LOW" && materiality !== "MEDIUM" && materiality !== "HIGH") {
      throw new AuthorityIntegrityError("Decision materiality is invalid");
    }
    if (row.reversible !== 0 && row.reversible !== 1) throw new AuthorityIntegrityError("Decision reversible flag is invalid");
    const request: DecisionRequestRecord = {
      decisionId: storedText(row, "decision_id"), goalId: storedText(row, "goal_id"), question: storedText(row, "question"),
      options: storedOptions(row),
      recommendedOptionId: storedText(row, "recommended_option_id"), recommendationReason: storedText(row, "recommendation_reason"),
      materiality, reversible: row.reversible === 1,
      defaultOptionId: storedNullableText(row, "default_option_id"),
    };
    let resolution: DecisionResolutionRecord | null = null;
    if (row.resolution_id !== null) {
      const source = storedText(row, "source");
      if (source !== "USER" && source !== "LOW_RISK_DEFAULT") {
        throw new AuthorityIntegrityError("Decision resolution source is invalid");
      }
      resolution = {
        resolutionId: storedText(row, "resolution_id"), decisionId: request.decisionId,
        selectedOptionId: storedText(row, "selected_option_id"), source,
        principalLocator: storedNullableText(row, "principal_locator"),
        resolutionSha256: storedText(row, "resolution_sha256"),
      };
    }
    return { request, resolution };
  }
}
