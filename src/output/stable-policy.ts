export const stableResponsePolicy = Object.freeze({
  policyVersion: 1,
  conciseComplete: true,
  toolActionProse: "NO_PROSE_PREFERRED",
  expandForRequiredContent: true,
  hardTruncationAllowed: false,
  rewriteRequestAllowed: false,
  preserveUserRequestedFormat: true,
  generatedContentAccounting: "PROVIDER_OUTPUT_WITH_REASONING_AND_TOOL_ARGUMENT_ATTRIBUTION",
  toolResultProjectionPolicy: "EVIDENCE_LIVENESS_ROUTED",
} as const);

export const responseClassBudgets = Object.freeze({
  ACK: 32,
  QUESTION: 160,
  STATUS: 96,
  RESULT: 256,
  AUDIT: 512,
} as const);
