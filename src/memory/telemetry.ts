import { createId } from "../foundation/ids.js";
import type { MemoryQuery, MemoryRecallObservation, MemoryRetrievalResult } from "./types.js";

export function buildMemoryRecallObservation(
  result: MemoryRetrievalResult,
  query: MemoryQuery,
  latencyMicros: number,
): MemoryRecallObservation {
  return {
    observationId: createId("MEMOBS"),
    workspaceId: query.workspaceId,
    goalId: query.goalId,
    epoch: result.epoch,
    mode: result.mode,
    selectedManifestSha256: result.workingSet.manifestSha256,
    selectedCount: result.selected.length,
    conflictCount: result.workingSet.conflicts.length,
    abstentionCount: result.workingSet.abstentions.length,
    indexLagCount: result.indexLagCount,
    tokenEstimate: result.workingSet.tokenEstimate,
    latencyMicros: Math.max(0, Math.ceil(latencyMicros)),
    createdAtMs: query.nowMs,
  };
}

export class MemoryTelemetryBuffer {
  private readonly pending: MemoryRecallObservation[] = [];

  constructor(private readonly capacity = 1024) {}

  enqueue(observation: MemoryRecallObservation): void {
    this.pending.push(observation);
    if (this.pending.length > this.capacity) this.pending.splice(0, this.pending.length - this.capacity);
  }

  peek(limit: number): readonly MemoryRecallObservation[] {
    return this.pending.slice(0, limit);
  }

  acknowledge(count: number): void {
    this.pending.splice(0, count);
  }

  size(): number {
    return this.pending.length;
  }
}
