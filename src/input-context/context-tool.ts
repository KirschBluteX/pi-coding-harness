import { canonicalJson } from "../authority/canonical-json.js";
import { equalSha256, hmacSha256Hex } from "../foundation/crypto.js";
import { BatchRehydrator, type RehydrationPage, type RehydrationSource } from "./batch-rehydrator.js";

interface CursorPayload {
  readonly schema_version: 1;
  readonly epoch: string;
  readonly subject_binding_sha256: string;
  readonly envelope_sha256: string;
  readonly candidate_ids: readonly string[];
  readonly representation: "EXACT" | "STRUCTURAL";
  readonly offset: number;
  readonly expires_at_ms: number;
}

export interface ContextToolSnapshot {
  readonly epoch: string;
  readonly subjectBindingSha256: string;
  readonly envelopeSha256: string;
  readonly workingSetCandidateIds: readonly string[];
  readonly onDemandCandidateIds: readonly string[];
  source(candidateId: string): RehydrationSource | null;
}

export type ContextToolRequest =
  | {
    readonly selector: "CURRENT_ON_DEMAND" | "CURRENT_WORKING_SET";
    readonly candidate_ids?: readonly string[];
    readonly representation?: "EXACT" | "STRUCTURAL";
    readonly cursor?: never;
  }
  | { readonly cursor: string; readonly selector?: never; readonly candidate_ids?: never; readonly representation?: never };

export interface ContextToolResponse extends RehydrationPage {
  readonly status: "OK" | "NO_ACTIVE_WORKING_SET" | "CURSOR_INVALID" | "SELECTION_INVALID";
  readonly continuation: string | null;
  readonly fallback: "NONE" | "NORMAL_READ_SEARCH";
}

function encode(payload: CursorPayload, key: string | Uint8Array): string {
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  return `${body}.${hmacSha256Hex(key, body)}`;
}

function decode(value: string, key: string | Uint8Array): CursorPayload | null {
  if (value.length > 16_384) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined || !equalSha256(signature, hmacSha256Hex(key, body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const item = parsed as Record<string, unknown>;
    if (item.schema_version !== 1 || typeof item.epoch !== "string"
      || typeof item.subject_binding_sha256 !== "string" || typeof item.envelope_sha256 !== "string"
      || (item.representation !== "EXACT" && item.representation !== "STRUCTURAL")
      || !Array.isArray(item.candidate_ids) || item.candidate_ids.length > 256
      || item.candidate_ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 256)
      || !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.expires_at_ms)) return null;
    return parsed as CursorPayload;
  } catch { return null; }
}

export class ContextToolRuntime {
  private readonly rehydrator: BatchRehydrator;

  constructor(
    private readonly snapshot: () => ContextToolSnapshot | null,
    private readonly hmacKey: string | Uint8Array,
    maxItems: number,
    maxBytes: number,
    private readonly cursorTtlMs: number,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.rehydrator = new BatchRehydrator(maxItems, maxBytes);
  }

  async execute(request: ContextToolRequest): Promise<ContextToolResponse> {
    const current = this.snapshot();
    if (!current) return this.empty("NO_ACTIVE_WORKING_SET");
    let ids: readonly string[];
    let offset = 0;
    let representation: "EXACT" | "STRUCTURAL";
    let expiresAtMs = this.nowMs() + this.cursorTtlMs;
    if ("cursor" in request) {
      const cursor = decode(request.cursor, this.hmacKey);
      if (!cursor || cursor.expires_at_ms < this.nowMs() || cursor.epoch !== current.epoch
        || cursor.subject_binding_sha256 !== current.subjectBindingSha256
        || cursor.envelope_sha256 !== current.envelopeSha256
        || cursor.offset < 0 || cursor.offset > cursor.candidate_ids.length) return this.empty("CURSOR_INVALID");
      ids = cursor.candidate_ids;
      offset = cursor.offset;
      representation = cursor.representation;
      expiresAtMs = cursor.expires_at_ms;
    } else {
      const allowed = request.selector === "CURRENT_ON_DEMAND"
        ? current.onDemandCandidateIds : current.workingSetCandidateIds;
      representation = request.representation ?? "EXACT";
      if (request.candidate_ids) {
        if (request.candidate_ids.length < 1 || request.candidate_ids.length > 10
          || request.candidate_ids.some((id) => !allowed.includes(id))) {
          return this.empty("SELECTION_INVALID");
        }
        ids = [...new Set(request.candidate_ids)];
      } else ids = [...new Set(allowed)];
    }
    const sources = ids.map((id) => current.source(id) ?? {
      candidateId: id, status: "MISSING" as const, byteLength: null, open: () => null,
    });
    const page = await this.rehydrator.rehydrate(sources, offset, representation);
    const continuation = page.nextOffset === null ? null : encode({
      schema_version: 1, epoch: current.epoch, subject_binding_sha256: current.subjectBindingSha256,
      envelope_sha256: current.envelopeSha256, candidate_ids: ids, representation, offset: page.nextOffset,
      expires_at_ms: expiresAtMs,
    }, this.hmacKey);
    return {
      status: "OK", ...page, continuation,
      fallback: page.items.some((item) => item.status !== "CURRENT"
        || (item.structural_status !== null && item.structural_status !== "COMPLETE")) ? "NORMAL_READ_SEARCH" : "NONE",
    };
  }

  private empty(status: Exclude<ContextToolResponse["status"], "OK">): ContextToolResponse {
    return { status, items: [], nextOffset: null, deliveredBytes: 0, continuation: null, fallback: "NORMAL_READ_SEARCH" };
  }
}
