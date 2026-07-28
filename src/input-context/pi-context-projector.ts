import { canonicalJson } from "../authority/canonical-json.js";
import { hmacSha256Hex } from "../foundation/crypto.js";
import type { MemoryContextMessage } from "../memory/context-projector.js";
import { memoryContextType, providerMemoryContextMessage } from "../memory/context-projector.js";
import { generationGovernorMessageType } from "../control/generation-governor.js";
import {
  RetainedContextLedger, retainedContextDescriptor,
  type RetainedContextDescriptor, type RetainedContextSnapshot,
} from "./retained-ledger.js";

export const inputContextMessageType = "pch-input-context-v1";

export interface ProviderContextSegment {
  readonly segmentId: string;
  readonly customType: string;
  readonly content: string;
  readonly sourceBindingSha256: string;
  readonly contributionClaim: Readonly<Record<string, unknown>>;
}

export interface ProjectorPreparation {
  readonly generationId: string;
  readonly systemPrompt: string;
  readonly systemPromptChanged: boolean;
  readonly stagedSegment: "NONE" | "STAGED" | "UNCHANGED" | "BOUNDARY_REQUIRED";
}

export interface ProjectorResult<T> {
  readonly messages: readonly T[];
  readonly changed: boolean;
  readonly retained: RetainedContextSnapshot;
  readonly projectedSegmentCount: number;
  readonly removedPersistedHarnessMessages: number;
  readonly fallback: "NONE" | "BASELINE_INVALID_ANCHOR";
}

export interface ContextProjectionOverlay {
  readonly insertionIndex: number;
  readonly message: unknown;
}

export interface ContextProjectionDirective {
  readonly changed: boolean;
  readonly overlays: readonly ContextProjectionOverlay[];
  readonly projectedSegmentCount: number;
  readonly removedPersistedHarnessMessages: number;
  readonly fallback: ProjectorResult<unknown>["fallback"];
}

export interface ProviderContextSpine<T> {
  readonly baseMessages: readonly T[];
  readonly descriptors: readonly RetainedContextDescriptor[];
  readonly removedPersistedHarnessMessages: number;
}

export interface StrippedProviderContext<T> {
  readonly baseMessages: readonly T[];
  readonly removedPersistedHarnessMessages: number;
}

interface Overlay {
  readonly generationId: string;
  readonly insertionIndex: number;
  readonly segmentIdentityHmac: string;
  readonly message: unknown;
  readonly customType: string;
}

export function ownedProviderContextMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const value = message as Record<string, unknown>;
  return value.role === "custom" && (
    value.customType === inputContextMessageType
    || value.customType === memoryContextType
    || value.customType === generationGovernorMessageType
  );
}

export function providerContextSpine<T>(messages: readonly T[]): ProviderContextSpine<T> {
  const stripped = stripOwnedProviderContextMessages(messages);
  return {
    ...stripped,
    descriptors: stripped.baseMessages.map((message) => retainedContextDescriptor(message)),
  };
}

export function stripOwnedProviderContextMessages<T>(messages: readonly T[]): StrippedProviderContext<T> {
  const baseMessages = messages.filter((message) => !ownedProviderContextMessage(message));
  return { baseMessages, removedPersistedHarnessMessages: messages.length - baseMessages.length };
}

export function applyContextProjection<T>(
  baseMessages: readonly T[],
  directive: Pick<ContextProjectionDirective, "overlays">,
): T[] {
  const byIndex = new Map<number, unknown[]>();
  for (const overlay of directive.overlays) {
    if (!Number.isSafeInteger(overlay.insertionIndex) || overlay.insertionIndex < 0 || overlay.insertionIndex > baseMessages.length) {
      throw new TypeError("Context projection overlay anchor is invalid");
    }
    const bucket = byIndex.get(overlay.insertionIndex) ?? [];
    bucket.push(overlay.message);
    byIndex.set(overlay.insertionIndex, bucket);
  }
  const projected: unknown[] = [];
  for (let index = 0; index <= baseMessages.length; index += 1) {
    projected.push(...(byIndex.get(index) ?? []));
    if (index < baseMessages.length) projected.push(baseMessages[index]);
  }
  return projected as T[];
}

function segmentMessage(segment: ProviderContextSegment, timestamp: number): unknown {
  return {
    role: "custom",
    customType: segment.customType,
    content: segment.content,
    display: false,
    timestamp,
    details: {
      sourceBindingSha256: segment.sourceBindingSha256,
      persistence: "EPHEMERAL_PROVIDER_CONTEXT",
      contributionClaim: segment.contributionClaim,
    },
  };
}

export class PiContextProjector {
  private readonly retainedLedger: RetainedContextLedger;
  private generationId: string | null = null;
  private overlays: Overlay[] = [];
  private pending: { readonly generationId: string; readonly segment: ProviderContextSegment; readonly identity: string; readonly message: unknown } | null = null;

  constructor(private readonly hmacKey: string | Uint8Array, private readonly nowMs: () => number = Date.now) {
    this.retainedLedger = new RetainedContextLedger(hmacKey);
  }

  beginGeneration(generationId: string): void {
    if (!generationId) throw new TypeError("PiContextProjector generation ID is required");
    if (this.generationId === generationId) return;
    this.generationId = generationId;
    this.overlays = [];
    this.pending = null;
  }

  prepareSystemPrompt(input: {
    readonly generationId: string;
    readonly systemPrompt: string;
    readonly additions: readonly { readonly marker: string; readonly content: string | null }[];
    readonly segment?: ProviderContextSegment | MemoryContextMessage | null;
  }): ProjectorPreparation {
    this.beginGeneration(input.generationId);
    const additions = input.additions
      .filter((entry) => entry.content !== null && entry.content.length > 0 && !input.systemPrompt.includes(entry.marker))
      .map((entry) => entry.content as string);
    const stagedSegment = this.stageSegment(input.generationId, input.segment ?? null);
    return {
      generationId: input.generationId,
      systemPrompt: additions.length === 0 ? input.systemPrompt : `${input.systemPrompt}\n\n${additions.join("\n\n")}`,
      systemPromptChanged: additions.length > 0,
      stagedSegment,
    };
  }

  project<T>(messages: readonly T[]): ProjectorResult<T> {
    const spine = providerContextSpine(messages);
    const directive = this.projectDescriptors(spine.descriptors, spine.removedPersistedHarnessMessages);
    return {
      messages: applyContextProjection(spine.baseMessages, directive), changed: directive.changed,
      retained: this.retainedLedger.current(), projectedSegmentCount: directive.projectedSegmentCount,
      removedPersistedHarnessMessages: directive.removedPersistedHarnessMessages, fallback: directive.fallback,
    };
  }

  projectDescriptors(
    descriptors: readonly RetainedContextDescriptor[],
    removedPersistedHarnessMessages = 0,
  ): ContextProjectionDirective {
    this.retainedLedger.reconcileDescriptors(descriptors);
    if (this.pending) {
      this.overlays.push({
        generationId: this.pending.generationId,
        insertionIndex: descriptors.length,
        segmentIdentityHmac: this.pending.identity,
        message: this.pending.message,
        customType: this.pending.segment.customType,
      });
      this.pending = null;
    }
    if (this.overlays.some((overlay) => overlay.generationId !== this.generationId || overlay.insertionIndex > descriptors.length)) {
      this.overlays = [];
      return {
        changed: removedPersistedHarnessMessages > 0, overlays: [], projectedSegmentCount: 0,
        removedPersistedHarnessMessages, fallback: "BASELINE_INVALID_ANCHOR",
      };
    }
    if (this.overlays.length === 0) {
      return {
        changed: removedPersistedHarnessMessages > 0, overlays: [], projectedSegmentCount: 0,
        removedPersistedHarnessMessages, fallback: "NONE",
      };
    }
    return {
      changed: true,
      overlays: this.overlays.map((overlay) => ({ insertionIndex: overlay.insertionIndex, message: overlay.message })),
      projectedSegmentCount: this.overlays.length, removedPersistedHarnessMessages, fallback: "NONE",
    };
  }

  hasProjection(): boolean { return this.pending !== null || this.overlays.length > 0; }

  currentRetained(): RetainedContextSnapshot {
    return this.retainedLedger.current();
  }

  reset(): void {
    this.generationId = null;
    this.overlays = [];
    this.pending = null;
    this.retainedLedger.reset();
  }

  private stageSegment(
    generationId: string,
    value: ProviderContextSegment | MemoryContextMessage | null,
  ): ProjectorPreparation["stagedSegment"] {
    if (!value || value.content.length === 0) {
      this.pending = null;
      return "NONE";
    }
    const segment = "segmentId" in value ? value : {
      segmentId: value.details.manifestSha256,
      customType: value.customType,
      content: value.content,
      sourceBindingSha256: value.details.manifestSha256,
      contributionClaim: value.details.contributionClaim,
    };
    const identity = hmacSha256Hex(this.hmacKey, canonicalJson({
      domain: "PCH-PROVIDER-CONTEXT-SEGMENT-V1",
      generationId, customType: segment.customType, content: segment.content,
      sourceBindingSha256: segment.sourceBindingSha256,
    }));
    if (this.pending?.identity === identity || this.overlays.some((entry) => entry.segmentIdentityHmac === identity)) return "UNCHANGED";
    if (this.overlays.some((entry) => entry.customType === segment.customType)) return "BOUNDARY_REQUIRED";
    const message = value.customType === memoryContextType && !("segmentId" in value)
      ? providerMemoryContextMessage(value, this.nowMs())
      : segmentMessage(segment, this.nowMs());
    this.pending = { generationId, segment, identity, message };
    return "STAGED";
  }
}
