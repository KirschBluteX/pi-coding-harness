import { canonicalJson } from "../authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import type { ContextTrust, RepresentationFidelity } from "./domain.js";

export interface RetainedContextEntry {
  readonly ordinal: number;
  readonly entryIdentityHmac: string;
  readonly predecessorRootHmac: string;
  readonly rootHmac: string;
  readonly role: string;
  readonly customType: string | null;
  readonly trust: ContextTrust;
  readonly representationFidelity: RepresentationFidelity;
}

export interface RetainedContextSnapshot {
  readonly rootSha256: string;
  readonly entries: readonly RetainedContextEntry[];
  readonly messageCount: number;
  readonly commonPrefixCount: number;
  readonly hashedMessageCount: number;
  readonly branchChanged: boolean;
}

export interface RetainedContextDescriptor {
  readonly contentSha256: string;
  readonly role: string;
  readonly customType: string | null;
}

function jsonTransport(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Retained provider context is not JSON serializable");
  return JSON.parse(serialized) as unknown;
}

function metadata(message: unknown): {
  readonly role: string;
  readonly customType: string | null;
  readonly trust: ContextTrust;
  readonly representationFidelity: RepresentationFidelity;
} {
  const value = typeof message === "object" && message !== null && !Array.isArray(message)
    ? message as Record<string, unknown> : {};
  const role = typeof value.role === "string" ? value.role : "unknown";
  const customType = typeof value.customType === "string" ? value.customType : null;
  const pchOwned = customType?.startsWith("pch-") === true;
  return {
    role,
    customType,
    trust: pchOwned ? "VERIFIED_EVIDENCE" : "UNTRUSTED_CONTEXT",
    representationFidelity: "EXACT_DECODED",
  };
}

export function retainedContextDescriptor(message: unknown): RetainedContextDescriptor {
  const details = metadata(message);
  return {
    contentSha256: sha256Hex(canonicalJson(jsonTransport(message))),
    role: details.role,
    customType: details.customType,
  };
}

function assertDescriptor(value: RetainedContextDescriptor): void {
  if (!/^[a-f0-9]{64}$/u.test(value.contentSha256) || !value.role
    || (value.customType !== null && typeof value.customType !== "string")) {
    throw new TypeError("Retained context descriptor is invalid");
  }
}

function descriptorMetadata(value: RetainedContextDescriptor): ReturnType<typeof metadata> {
  assertDescriptor(value);
  const pchOwned = value.customType?.startsWith("pch-") === true;
  return {
    role: value.role, customType: value.customType,
    trust: pchOwned ? "VERIFIED_EVIDENCE" : "UNTRUSTED_CONTEXT",
    representationFidelity: "EXACT_DECODED",
  };
}

export class RetainedContextLedger {
  private readonly emptyRoot: string;
  private messages: readonly unknown[] = [];
  private descriptors: readonly RetainedContextDescriptor[] = [];
  private entries: readonly RetainedContextEntry[] = [];

  constructor(private readonly hmacKey: string | Uint8Array) {
    this.emptyRoot = hmacSha256Hex(hmacKey, "PCH-RETAINED-CONTEXT-ROOT-V1:EMPTY");
  }

  current(): RetainedContextSnapshot {
    return {
      rootSha256: this.entries.at(-1)?.rootHmac ?? this.emptyRoot,
      entries: this.entries,
      messageCount: this.entries.length,
      commonPrefixCount: this.entries.length,
      hashedMessageCount: 0,
      branchChanged: false,
    };
  }

  reset(): void {
    this.messages = [];
    this.descriptors = [];
    this.entries = [];
  }

  reconcile(messages: readonly unknown[]): RetainedContextSnapshot {
    let common = 0;
    const limit = Math.min(this.messages.length, messages.length);
    while (common < limit && this.messages[common] === messages[common]) common += 1;

    let hashed = 0;
    while (common < limit) {
      const candidate = this.entryIdentity(messages[common]);
      hashed += 1;
      if (candidate !== this.entries[common]?.entryIdentityHmac) break;
      common += 1;
    }

    const descriptors = messages.map((message) => retainedContextDescriptor(message));
    const result = this.rebuild(descriptors, common, hashed);
    this.messages = [...messages];
    return result;
  }

  reconcileDescriptors(descriptors: readonly RetainedContextDescriptor[]): RetainedContextSnapshot {
    if (descriptors.length > 16_384) throw new TypeError("Retained context descriptor limit exceeded");
    let common = 0;
    let hashed = 0;
    const limit = Math.min(this.descriptors.length, descriptors.length);
    while (common < limit) {
      const candidate = this.descriptorIdentity(descriptors[common]!);
      hashed += 1;
      if (candidate !== this.entries[common]?.entryIdentityHmac) break;
      common += 1;
    }
    const result = this.rebuild(descriptors, common, hashed);
    this.messages = [];
    return result;
  }

  private rebuild(
    descriptors: readonly RetainedContextDescriptor[],
    common: number,
    alreadyHashed: number,
  ): RetainedContextSnapshot {
    const nextEntries = this.entries.slice(0, common);
    let predecessor = nextEntries.at(-1)?.rootHmac ?? this.emptyRoot;
    let hashed = alreadyHashed;
    for (let ordinal = common; ordinal < descriptors.length; ordinal += 1) {
      const item = descriptors[ordinal]!;
      const details = descriptorMetadata(item);
      const entryIdentityHmac = this.descriptorIdentity(item);
      hashed += 1;
      const rootHmac = hmacSha256Hex(this.hmacKey, canonicalJson({
        domain: "PCH-RETAINED-CONTEXT-ROOT-V1", ordinal, predecessor, entryIdentityHmac,
      }));
      nextEntries.push({
        ordinal, entryIdentityHmac, predecessorRootHmac: predecessor, rootHmac, ...details,
      });
      predecessor = rootHmac;
    }
    const branchChanged = common < this.entries.length;
    this.descriptors = [...descriptors];
    this.entries = nextEntries;
    return {
      rootSha256: predecessor,
      entries: this.entries,
      messageCount: descriptors.length,
      commonPrefixCount: common,
      hashedMessageCount: hashed,
      branchChanged,
    };
  }

  private entryIdentity(message: unknown): string {
    return this.descriptorIdentity(retainedContextDescriptor(message));
  }

  private descriptorIdentity(descriptor: RetainedContextDescriptor): string {
    const details = descriptorMetadata(descriptor);
    return hmacSha256Hex(this.hmacKey, canonicalJson({
      domain: "PCH-RETAINED-CONTEXT-ENTRY-V1",
      role: details.role,
      customType: details.customType,
      trust: details.trust,
      representationFidelity: details.representationFidelity,
      contentSha256: descriptor.contentSha256,
    }));
  }
}
