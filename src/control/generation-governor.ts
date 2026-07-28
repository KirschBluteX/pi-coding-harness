import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { sha256Hex } from "../foundation/crypto.js";

export const generationGovernorMessageType = "pch-generation-governor-v1";

export type GenerationGovernorDecision =
  | "CONTINUE"
  | "NUDGE"
  | "HALT_AUTOMATION"
  | "WAIT_USER"
  | "TERMINAL";

export interface GenerationFrontier {
  readonly controlFrameSha256: string;
  readonly terminal: boolean;
  readonly userDecisionRequired: boolean;
}

export interface GenerationGovernorSnapshot {
  readonly schema_version: 1;
  readonly decision: GenerationGovernorDecision;
  readonly material_progress: boolean;
  readonly authority_progress: boolean;
  readonly evidence_progress: boolean;
  readonly no_progress_turns: number;
  readonly provider_turns: number;
  readonly unique_evidence: number;
  readonly blocked_repeated_routes: number;
  readonly frontier_sha256: string;
  readonly directive: string | null;
  readonly reason_code:
    | "AGENT_RUN_STARTED"
    | "MATERIAL_PROGRESS"
    | "FIRST_NO_PROGRESS"
    | "REPEATED_NO_PROGRESS"
    | "NO_PROGRESS_LIMIT"
    | "USER_DECISION_REQUIRED"
    | "GOAL_TERMINAL"
    | "AGENT_SETTLED";
}

export interface GenerationRouteDecision {
  readonly allow: boolean;
  readonly reason: string | null;
}

const emptyEvidenceRoot = sha256Hex("PCH-GENERATION-EVIDENCE-V1:EMPTY");
const maximumRememberedFingerprints = 512;
const maximumTurnRoutes = 128;
const nudgeDirective = "No authority or evidence progress. Follow only the current next action; do not repeat an unchanged tool route.";
const haltDirective = "Automatic progress is stalled. Do not repeat an unchanged tool route; use a changed repair route, ask one material question, or stop with the blocker.";

function sha(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
}

function frontierSha256(controlFrameSha256: string, evidenceRootSha256: string): string {
  return canonicalJsonSha256({
    domain: "PCH-GENERATION-FRONTIER-V1",
    control_frame_sha256: controlFrameSha256,
    evidence_root_sha256: evidenceRootSha256,
  });
}

/**
 * Bounds repeated provider/tool loops without treating provider activity or prose
 * as task progress. This state is deliberately advisory and process-local: a Host
 * restart resets the guard instead of risking a false denial from stale state.
 */
export class GenerationGovernor {
  private runId: string | null = null;
  private priorControlFrameSha256: string | null = null;
  private priorEvidenceRootSha256 = emptyEvidenceRoot;
  private evidenceRootSha256 = emptyEvidenceRoot;
  private noProgressTurns = 0;
  private providerTurns = 0;
  private uniqueEvidence = 0;
  private blockedRepeatedRoutes = 0;
  private decision: GenerationGovernorDecision = "CONTINUE";
  private reasonCode: GenerationGovernorSnapshot["reason_code"] = "AGENT_RUN_STARTED";
  private directiveValue: string | null = null;
  private materialProgress = false;
  private authorityProgress = false;
  private evidenceProgress = false;
  private readonly evidenceFingerprints = new Set<string>();
  private readonly evidenceFingerprintOrder: string[] = [];
  private readonly stalledRouteFingerprints = new Set<string>();
  private readonly currentTurnRouteFingerprints = new Set<string>();

  beginAgentRun(runId: string, frontier: GenerationFrontier): GenerationGovernorSnapshot {
    if (!runId.trim() || runId.length > 256) throw new TypeError("Generation agent run ID is invalid");
    sha(frontier.controlFrameSha256, "Generation control frame");
    if (this.runId !== runId) {
      this.runId = runId;
      this.priorControlFrameSha256 = frontier.controlFrameSha256;
      this.priorEvidenceRootSha256 = this.evidenceRootSha256;
      this.noProgressTurns = 0;
      this.providerTurns = 0;
      this.decision = frontier.terminal ? "TERMINAL" : frontier.userDecisionRequired ? "WAIT_USER" : "CONTINUE";
      this.reasonCode = frontier.terminal ? "GOAL_TERMINAL"
        : frontier.userDecisionRequired ? "USER_DECISION_REQUIRED" : "AGENT_RUN_STARTED";
      this.directiveValue = null;
      this.materialProgress = false;
      this.authorityProgress = false;
      this.evidenceProgress = false;
      this.evidenceFingerprints.clear();
      this.evidenceFingerprintOrder.length = 0;
      this.stalledRouteFingerprints.clear();
      this.currentTurnRouteFingerprints.clear();
    }
    return this.snapshot(frontier.controlFrameSha256);
  }

  recordProviderTurn(): void {
    this.providerTurns += 1;
  }

  recordEvidence(fingerprintSha256: string): boolean {
    sha(fingerprintSha256, "Generation evidence fingerprint");
    if (this.evidenceFingerprints.has(fingerprintSha256)) return false;
    this.evidenceFingerprints.add(fingerprintSha256);
    this.evidenceFingerprintOrder.push(fingerprintSha256);
    if (this.evidenceFingerprintOrder.length > maximumRememberedFingerprints) {
      this.evidenceFingerprints.delete(this.evidenceFingerprintOrder.shift()!);
    }
    this.uniqueEvidence += 1;
    this.evidenceRootSha256 = sha256Hex(
      `PCH-GENERATION-EVIDENCE-V1\0${this.evidenceRootSha256}\0${fingerprintSha256}`,
    );
    return true;
  }

  registerRoute(fingerprintSha256: string): GenerationRouteDecision {
    sha(fingerprintSha256, "Generation route fingerprint");
    if (this.noProgressTurns >= 2 && this.stalledRouteFingerprints.has(fingerprintSha256)) {
      this.blockedRepeatedRoutes += 1;
      return {
        allow: false,
        reason: "PCH_GENERATION_ROUTE_STALLED: this exact route repeated without authority or evidence progress; change the repair route, ask the material question, or stop with the blocker",
      };
    }
    if (this.currentTurnRouteFingerprints.size < maximumTurnRoutes) {
      this.currentTurnRouteFingerprints.add(fingerprintSha256);
    }
    return { allow: true, reason: null };
  }

  observeTurn(turnIndex: number, frontier: GenerationFrontier): GenerationGovernorSnapshot {
    if (!Number.isSafeInteger(turnIndex) || turnIndex < 0 || turnIndex > 1_000_000) {
      throw new TypeError("Generation turn index is invalid");
    }
    sha(frontier.controlFrameSha256, "Generation control frame");
    if (this.runId === null) throw new TypeError("Generation agent run must begin before observing a turn");

    this.authorityProgress = this.priorControlFrameSha256 !== frontier.controlFrameSha256;
    this.evidenceProgress = this.priorEvidenceRootSha256 !== this.evidenceRootSha256;
    this.materialProgress = this.authorityProgress || this.evidenceProgress;

    if (frontier.terminal) {
      this.noProgressTurns = 0;
      this.decision = "TERMINAL";
      this.reasonCode = "GOAL_TERMINAL";
      this.directiveValue = null;
      this.stalledRouteFingerprints.clear();
    } else if (frontier.userDecisionRequired) {
      this.noProgressTurns = 0;
      this.decision = "WAIT_USER";
      this.reasonCode = "USER_DECISION_REQUIRED";
      this.directiveValue = null;
      this.stalledRouteFingerprints.clear();
    } else if (this.materialProgress) {
      this.noProgressTurns = 0;
      this.decision = "CONTINUE";
      this.reasonCode = "MATERIAL_PROGRESS";
      this.directiveValue = null;
      this.stalledRouteFingerprints.clear();
    } else {
      this.noProgressTurns += 1;
      for (const fingerprint of this.currentTurnRouteFingerprints) {
        if (this.stalledRouteFingerprints.size >= maximumRememberedFingerprints) break;
        this.stalledRouteFingerprints.add(fingerprint);
      }
      if (this.noProgressTurns === 1) {
        this.decision = "CONTINUE";
        this.reasonCode = "FIRST_NO_PROGRESS";
        this.directiveValue = null;
      } else if (this.noProgressTurns === 2) {
        this.decision = "NUDGE";
        this.reasonCode = "REPEATED_NO_PROGRESS";
        this.directiveValue = nudgeDirective;
      } else {
        this.decision = "HALT_AUTOMATION";
        this.reasonCode = "NO_PROGRESS_LIMIT";
        this.directiveValue = haltDirective;
      }
    }

    this.priorControlFrameSha256 = frontier.controlFrameSha256;
    this.priorEvidenceRootSha256 = this.evidenceRootSha256;
    this.currentTurnRouteFingerprints.clear();
    return this.snapshot(frontier.controlFrameSha256);
  }

  settleAgentRun(frontier: GenerationFrontier): GenerationGovernorSnapshot {
    sha(frontier.controlFrameSha256, "Generation control frame");
    this.directiveValue = null;
    if (!frontier.terminal && !frontier.userDecisionRequired) {
      this.decision = "CONTINUE";
      this.reasonCode = "AGENT_SETTLED";
    }
    this.currentTurnRouteFingerprints.clear();
    return this.snapshot(frontier.controlFrameSha256);
  }

  current(frontier: GenerationFrontier): GenerationGovernorSnapshot {
    sha(frontier.controlFrameSha256, "Generation control frame");
    return this.snapshot(frontier.controlFrameSha256);
  }

  private snapshot(controlFrameSha256: string): GenerationGovernorSnapshot {
    return {
      schema_version: 1,
      decision: this.decision,
      material_progress: this.materialProgress,
      authority_progress: this.authorityProgress,
      evidence_progress: this.evidenceProgress,
      no_progress_turns: this.noProgressTurns,
      provider_turns: this.providerTurns,
      unique_evidence: this.uniqueEvidence,
      blocked_repeated_routes: this.blockedRepeatedRoutes,
      frontier_sha256: frontierSha256(controlFrameSha256, this.evidenceRootSha256),
      directive: this.directiveValue,
      reason_code: this.reasonCode,
    };
  }
}
