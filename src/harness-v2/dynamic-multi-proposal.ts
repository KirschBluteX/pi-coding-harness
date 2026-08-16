import { canonicalJson, canonicalJsonSha256, type CanonicalJson } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface DynamicMultiProposalReceiptV2 {
  readonly schema_version: 2;
  readonly dynamic_multi_proposal_receipt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly authorization_id: string;
  readonly authorization_sha256: string;
  readonly input_closure_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly config_sha256: string;
  readonly graph_proposal_sha256: string;
  readonly source: readonly Readonly<Record<string, unknown>>[];
  readonly source_root_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

type ProposalInputV2 = Omit<DynamicMultiProposalReceiptV2,
  "schema_version" | "dynamic_multi_proposal_receipt_id" | "source_root_sha256" | "record_sha256">;

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value !== value.normalize("NFC")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} is invalid`);
}

export function finalizeDynamicMultiProposalReceiptV2(
  input: ProposalInputV2 & Partial<Pick<DynamicMultiProposalReceiptV2,
    "schema_version" | "dynamic_multi_proposal_receipt_id" | "source_root_sha256" | "record_sha256">>,
): DynamicMultiProposalReceiptV2 {
  for (const [value, label] of [
    [input.goal_id, "Dynamic Multi proposal Goal"], [input.run_id, "Dynamic Multi proposal run"],
    [input.work_cell_id, "Dynamic Multi proposal WorkCell"], [input.plan_revision_id, "Dynamic Multi proposal Plan"],
    [input.authorization_id, "Dynamic Multi proposal authorization"],
  ] as const) identifier(value, label);
  for (const [value, label] of [
    [input.plan_revision_sha256, "Dynamic Multi proposal Plan hash"],
    [input.authorization_sha256, "Dynamic Multi proposal authorization hash"],
    [input.input_closure_sha256, "Dynamic Multi proposal input closure"],
    [input.baseline_sha256, "Dynamic Multi proposal baseline"],
    [input.baseline_content_root_sha256, "Dynamic Multi proposal content root"],
    [input.environment_sha256, "Dynamic Multi proposal environment"],
    [input.runtime_fingerprint_sha256, "Dynamic Multi proposal runtime"],
    [input.config_sha256, "Dynamic Multi proposal config"],
    [input.graph_proposal_sha256, "Dynamic Multi proposal graph"],
    [input.predecessor_authority_head_sha256, "Dynamic Multi proposal authority head"],
  ] as const) sha256(value, label);
  if (!Array.isArray(input.source) || input.source.length < 2 || input.source.length > 32
    || input.source.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) {
    throw new TypeError("Dynamic Multi proposal source is invalid");
  }
  const sourceJson = canonicalJson(input.source as CanonicalJson);
  if (sourceJson.length > 1_048_576) throw new TypeError("Dynamic Multi proposal source exceeds its bound");
  const source = JSON.parse(sourceJson) as readonly Readonly<Record<string, unknown>>[];
  const sourceRootSha256 = canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-PROPOSAL-SOURCE-V2", source });
  if (!Number.isSafeInteger(input.created_at_ms) || input.created_at_ms < 0) {
    throw new TypeError("Dynamic Multi proposal time is invalid");
  }
  const identity = canonicalJsonSha256({
    run: input.run_id,
    workCell: input.work_cell_id,
    authorization: input.authorization_sha256,
    graph: input.graph_proposal_sha256,
  });
  const body = {
    schema_version: 2 as const,
    dynamic_multi_proposal_receipt_id: idFromSha256("MULTI_PROPOSAL", identity),
    goal_id: input.goal_id,
    run_id: input.run_id,
    work_cell_id: input.work_cell_id,
    plan_revision_id: input.plan_revision_id,
    plan_revision_sha256: input.plan_revision_sha256,
    authorization_id: input.authorization_id,
    authorization_sha256: input.authorization_sha256,
    input_closure_sha256: input.input_closure_sha256,
    baseline_sha256: input.baseline_sha256,
    baseline_content_root_sha256: input.baseline_content_root_sha256,
    environment_sha256: input.environment_sha256,
    runtime_fingerprint_sha256: input.runtime_fingerprint_sha256,
    config_sha256: input.config_sha256,
    graph_proposal_sha256: input.graph_proposal_sha256,
    source,
    source_root_sha256: sourceRootSha256,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    created_at_ms: input.created_at_ms,
  };
  const recordSha256 = canonicalJsonSha256({ domain: "PCH-DYNAMIC-MULTI-PROPOSAL-RECEIPT-V2", ...body });
  if (input.schema_version !== undefined && input.schema_version !== 2
    || input.dynamic_multi_proposal_receipt_id !== undefined
      && input.dynamic_multi_proposal_receipt_id !== body.dynamic_multi_proposal_receipt_id
    || input.source_root_sha256 !== undefined && input.source_root_sha256 !== sourceRootSha256
    || input.record_sha256 !== undefined && input.record_sha256 !== recordSha256) {
    throw new TypeError("Dynamic Multi proposal receipt identity or integrity failed");
  }
  return { ...body, record_sha256: recordSha256 };
}
