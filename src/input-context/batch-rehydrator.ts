export type RehydrationStatus =
  | "CURRENT" | "STALE" | "UNAUTHORIZED" | "SUPERSEDED" | "SENSITIVE_REFUSED"
  | "MISSING" | "TOO_LARGE" | "INSUFFICIENT" | "SOURCE_ERROR";

export interface RehydrationSource {
  readonly candidateId: string;
  readonly status: Exclude<RehydrationStatus, "TOO_LARGE">;
  readonly byteLength: number | null;
  open(): Uint8Array | null;
  structural?(): Promise<{
    readonly bytes: Uint8Array;
    readonly status: "COMPLETE" | "PARTIAL" | "INSUFFICIENT" | "EXCLUDED";
  }>;
}

export interface RehydratedItem {
  readonly candidate_id: string;
  readonly status: RehydrationStatus;
  readonly content: string | null;
  readonly byte_length: number | null;
  readonly representation: "EXACT" | "STRUCTURAL";
  readonly structural_status: "COMPLETE" | "PARTIAL" | "INSUFFICIENT" | "EXCLUDED" | null;
}

export interface RehydrationPage {
  readonly items: readonly RehydratedItem[];
  readonly nextOffset: number | null;
  readonly deliveredBytes: number;
}

export class BatchRehydrator {
  constructor(private readonly maxItems: number, private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 10) throw new RangeError("Context batch maxItems is invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 1_048_576) throw new RangeError("Context batch maxBytes is invalid");
  }

  async rehydrate(
    sources: readonly RehydrationSource[],
    offset = 0,
    representation: "EXACT" | "STRUCTURAL" = "EXACT",
  ): Promise<RehydrationPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > sources.length) throw new RangeError("Context batch offset is invalid");
    const items: RehydratedItem[] = [];
    let deliveredBytes = 0;
    let index = offset;
    while (index < sources.length && items.length < this.maxItems) {
      const source = sources[index]!;
      index += 1;
      if (source.status !== "CURRENT") {
        items.push({
          candidate_id: source.candidateId, status: source.status, content: null, byte_length: source.byteLength,
          representation, structural_status: null,
        });
        continue;
      }
      if (representation === "EXACT" && source.byteLength !== null && source.byteLength > this.maxBytes) {
        items.push({
          candidate_id: source.candidateId, status: "TOO_LARGE", content: null, byte_length: source.byteLength,
          representation, structural_status: null,
        });
        continue;
      }
      let bytes: Uint8Array | null;
      let structuralStatus: RehydratedItem["structural_status"] = null;
      try {
        if (representation === "STRUCTURAL") {
          const structural = await source.structural?.();
          if (!structural) {
            items.push({
              candidate_id: source.candidateId, status: "INSUFFICIENT", content: null, byte_length: source.byteLength,
              representation, structural_status: "INSUFFICIENT",
            });
            continue;
          }
          bytes = structural.bytes;
          structuralStatus = structural.status;
        } else bytes = source.open();
      } catch {
        items.push({
          candidate_id: source.candidateId, status: "SOURCE_ERROR", content: null, byte_length: source.byteLength,
          representation, structural_status: null,
        });
        continue;
      }
      if (bytes === null) {
        items.push({
          candidate_id: source.candidateId, status: "MISSING", content: null, byte_length: null,
          representation, structural_status: null,
        });
        continue;
      }
      if (representation === "EXACT" && source.byteLength !== null && source.byteLength !== bytes.byteLength) {
        items.push({
          candidate_id: source.candidateId, status: "SOURCE_ERROR", content: null, byte_length: source.byteLength,
          representation, structural_status: null,
        });
        continue;
      }
      if (bytes.byteLength > this.maxBytes) {
        items.push({
          candidate_id: source.candidateId, status: "TOO_LARGE", content: null, byte_length: bytes.byteLength,
          representation, structural_status: structuralStatus,
        });
        continue;
      }
      if (deliveredBytes + bytes.byteLength > this.maxBytes) {
        index -= 1;
        break;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        items.push({
          candidate_id: source.candidateId, status: "INSUFFICIENT", content: null, byte_length: bytes.byteLength,
          representation, structural_status: structuralStatus,
        });
        continue;
      }
      items.push({
        candidate_id: source.candidateId,
        status: structuralStatus === "INSUFFICIENT" || structuralStatus === "EXCLUDED" ? "INSUFFICIENT" : "CURRENT",
        content,
        byte_length: bytes.byteLength,
        representation,
        structural_status: structuralStatus,
      });
      deliveredBytes += bytes.byteLength;
    }
    return { items, nextOffset: index < sources.length ? index : null, deliveredBytes };
  }
}
