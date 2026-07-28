import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { RetainedContextDescriptor } from "./retained-ledger.js";

export interface ContextProjectionDelta {
  readonly schema_version: 1;
  readonly lineage_id: string;
  readonly previous_sequence_root: string;
  readonly previous_count: number;
  readonly append: readonly RetainedContextDescriptor[];
  readonly new_sequence_root: string;
  readonly new_count: number;
  readonly full_reconcile: boolean;
}

export interface ProjectionDeltaApplyResult {
  readonly accepted: boolean;
  readonly reconcile_required: boolean;
  readonly sequence_root: string;
  readonly count: number;
}

export function emptyProjectionRoot(lineageId: string): string {
  return canonicalJsonSha256({ domain: "PCH-CONTEXT-SEQUENCE-V1", lineageId, empty: true });
}

function appendRoot(root: string, descriptor: RetainedContextDescriptor, ordinal: number): string {
  return canonicalJsonSha256({ domain: "PCH-CONTEXT-SEQUENCE-V1", root, descriptor, ordinal });
}

function descriptorsEqual(left: RetainedContextDescriptor, right: RetainedContextDescriptor): boolean {
  return left.contentSha256 === right.contentSha256 && left.role === right.role && left.customType === right.customType;
}

export class ProjectionDeltaLedger {
  private lineageRevision = 1;
  private descriptors: readonly RetainedContextDescriptor[] = [];
  private root: string;
  private committed = false;

  constructor(private readonly lineageSeed: string) {
    if (!lineageSeed.trim()) throw new TypeError("Projection lineage seed is required");
    this.root = emptyProjectionRoot(this.lineageId());
  }

  current(): { readonly lineage_id: string; readonly sequence_root: string; readonly count: number } {
    return { lineage_id: this.lineageId(), sequence_root: this.root, count: this.descriptors.length };
  }

  plan(next: readonly RetainedContextDescriptor[], forceFull = false): ContextProjectionDelta {
    let common = 0;
    while (!forceFull && this.committed && common < this.descriptors.length && common < next.length
      && descriptorsEqual(this.descriptors[common]!, next[common]!)) common += 1;
    const appendOnly = !forceFull && this.committed && common === this.descriptors.length;
    const revision = appendOnly || !this.committed ? this.lineageRevision : this.lineageRevision + 1;
    const lineageId = this.lineageId(revision);
    const previousRoot = appendOnly ? this.root : emptyProjectionRoot(lineageId);
    if (!appendOnly) common = 0;
    let nextRoot = previousRoot;
    const append = next.slice(common);
    append.forEach((descriptor, index) => { nextRoot = appendRoot(nextRoot, descriptor, common + index); });
    return {
      schema_version: 1, lineage_id: lineageId, previous_sequence_root: previousRoot,
      previous_count: common, append, new_sequence_root: nextRoot, new_count: next.length,
      full_reconcile: !appendOnly,
    };
  }

  commit(delta: ContextProjectionDelta): void {
    const expectedLineage = delta.full_reconcile && this.committed
      ? this.lineageId(this.lineageRevision + 1) : this.lineageId();
    if (delta.lineage_id !== expectedLineage) throw new TypeError("Projection delta lineage is not the next local lineage");
    const applied = applyProjectionDelta(this.current(), delta);
    if (!applied.accepted) throw new TypeError("Projection delta does not extend the local ledger");
    if (delta.full_reconcile && this.committed) this.lineageRevision += 1;
    this.descriptors = delta.full_reconcile ? [...delta.append] : [...this.descriptors, ...delta.append];
    this.root = delta.new_sequence_root;
    this.committed = true;
  }

  rotate(): void {
    this.lineageRevision += 1;
    this.descriptors = [];
    this.root = emptyProjectionRoot(this.lineageId());
    this.committed = false;
  }

  private lineageId(revision = this.lineageRevision): string {
    return canonicalJsonSha256({ domain: "PCH-CONTEXT-LINEAGE-V1", seed: this.lineageSeed, revision });
  }
}

export function applyProjectionDelta(
  current: { readonly lineage_id: string; readonly sequence_root: string; readonly count: number },
  delta: ContextProjectionDelta,
): ProjectionDeltaApplyResult {
  const reset = delta.full_reconcile && delta.previous_count === 0
    && delta.previous_sequence_root === emptyProjectionRoot(delta.lineage_id);
  if (!reset && (current.lineage_id !== delta.lineage_id || current.sequence_root !== delta.previous_sequence_root
    || current.count !== delta.previous_count)) {
    return { accepted: false, reconcile_required: true, sequence_root: current.sequence_root, count: current.count };
  }
  let root = reset ? delta.previous_sequence_root : current.sequence_root;
  const baseCount = reset ? 0 : current.count;
  delta.append.forEach((descriptor, index) => { root = appendRoot(root, descriptor, baseCount + index); });
  const count = baseCount + delta.append.length;
  if (root !== delta.new_sequence_root || count !== delta.new_count) {
    return { accepted: false, reconcile_required: true, sequence_root: current.sequence_root, count: current.count };
  }
  return { accepted: true, reconcile_required: false, sequence_root: root, count };
}
