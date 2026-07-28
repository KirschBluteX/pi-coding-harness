import { canonicalJsonSha256 } from "../authority/canonical-json.js";

const shaPattern = /^[a-f0-9]{64}$/u;

export interface CurrentControlFrame {
  readonly schema_version: 1;
  readonly goal_id: string;
  readonly authority_version: number;
  readonly goal_contract_sha256: string | null;
  readonly route_sha256: string | null;
  readonly work_cell_id: string | null;
  readonly execution_authorization_sha256: string | null;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly tool_surface_sha256: string;
  readonly control_frame_sha256: string;
}

export type ControlFrameInput = Omit<CurrentControlFrame, "schema_version" | "control_frame_sha256">;

function optionalSha(value: string | null, label: string): void {
  if (value !== null && !shaPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 or null`);
}

export function createCurrentControlFrame(input: ControlFrameInput): CurrentControlFrame {
  if (!input.goal_id.trim()) throw new TypeError("ControlFrame goal_id is required");
  if (!Number.isSafeInteger(input.authority_version) || input.authority_version < 1) {
    throw new TypeError("ControlFrame authority_version must be a positive integer");
  }
  if (!Number.isSafeInteger(input.lease_generation) || input.lease_generation < 1
    || !Number.isSafeInteger(input.fencing_token) || input.fencing_token < 1) {
    throw new TypeError("ControlFrame lease binding is invalid");
  }
  optionalSha(input.goal_contract_sha256, "ControlFrame goal_contract_sha256");
  optionalSha(input.route_sha256, "ControlFrame route_sha256");
  optionalSha(input.execution_authorization_sha256, "ControlFrame execution_authorization_sha256");
  if (!shaPattern.test(input.tool_surface_sha256)) throw new TypeError("ControlFrame tool_surface_sha256 is invalid");
  if (input.work_cell_id === null && input.execution_authorization_sha256 !== null) {
    throw new TypeError("ControlFrame authorization requires a WorkCell binding");
  }
  const body = { schema_version: 1 as const, ...input };
  return { ...body, control_frame_sha256: canonicalJsonSha256({ domain: "PCH-CONTROL-FRAME-V1", ...body }) };
}

export function assertCurrentControlFrame(expectedSha256: string, current: CurrentControlFrame): void {
  if (!shaPattern.test(expectedSha256)) throw new TypeError("PCH_CONTROL_FRAME_REQUIRED: a valid turn ControlFrame is required");
  if (expectedSha256 !== current.control_frame_sha256) {
    throw new TypeError(
      `PCH_STALE_CONTROL_FRAME: expected authority version ${current.authority_version} and frame ${current.control_frame_sha256}`,
    );
  }
}
