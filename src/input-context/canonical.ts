import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";

export const inputContextHashDomains = {
  contextDemand: "PCH-INPUT-CONTEXT-V1-DEMAND",
  contextCandidate: "PCH-INPUT-CONTEXT-V1-CANDIDATE",
  contextWorkingSet: "PCH-INPUT-CONTEXT-V1-WORKING-SET",
  contextEnvelope: "PCH-INPUT-CONTEXT-V1-ENVELOPE",
  contextCompileReceipt: "PCH-INPUT-CONTEXT-V1-COMPILE-RECEIPT",
  contextLayoutManifest: "PCH-INPUT-CONTEXT-V1-LAYOUT-MANIFEST",
  contextProjectionReceipt: "PCH-INPUT-CONTEXT-V1-PROJECTION-RECEIPT",
  readEvidenceReceipt: "PCH-INPUT-CONTEXT-V1-READ-EVIDENCE-RECEIPT",
  evidenceValidityTransition: "PCH-INPUT-CONTEXT-V1-EVIDENCE-VALIDITY-TRANSITION",
  contextRetentionRoot: "PCH-INPUT-CONTEXT-V1-RETENTION-ROOT",
  toolSurfacePlan: "PCH-INPUT-CONTEXT-V1-TOOL-SURFACE-PLAN",
  providerTurnLedger: "PCH-PROVIDER-TURN-LEDGER-V1",
  providerTurnAttempt: "PCH-PROVIDER-TURN-ATTEMPT-V1",
  providerTurnContribution: "PCH-PROVIDER-TURN-CONTRIBUTION-V1",
  providerTurnRequest: "PCH-PROVIDER-TURN-REQUEST-V2",
  contextEpisodeObservation: "PCH-INPUT-CONTEXT-V1-EPISODE-OBSERVATION",
  inputContextActivation: "PCH-INPUT-CONTEXT-V1-ACTIVATION",
  queryScopeHead: "PCH-INPUT-CONTEXT-V1-QUERY-SCOPE-HEAD",
  projectSourceManifest: "PCH-INPUT-CONTEXT-V1-PROJECT-SOURCE-MANIFEST",
  projectKnowledgeClaim: "PCH-INPUT-CONTEXT-V1-PROJECT-KNOWLEDGE-CLAIM",
} as const;

type StringRecord = Record<string, unknown>;

function withoutField(value: object, field: string): StringRecord {
  const result: StringRecord = {};
  for (const [key, entry] of Object.entries(value)) if (key !== field) result[key] = entry;
  return result;
}

export function inputContextRecordSha256(domain: string, value: object, hashField: string): string {
  return canonicalJsonSha256({ domain, record: withoutField(value, hashField) });
}

export function sealInputContextRecord<T extends object, K extends string>(
  domain: string,
  hashField: K,
  value: T,
): T & Record<K, string> {
  return { ...value, [hashField]: canonicalJsonSha256({ domain, record: value }) } as T & Record<K, string>;
}

export function assertInputContextRecordSha256(domain: string, value: object, hashField: string): void {
  const actual = (value as StringRecord)[hashField];
  if (typeof actual !== "string" || inputContextRecordSha256(domain, value, hashField) !== actual) {
    throw new TypeError(`${domain} canonical hash mismatch`);
  }
}

export function encodeInputContextRecord(value: object): string {
  return canonicalJson(value);
}
