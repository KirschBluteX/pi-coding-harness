export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly additionalModelRequests: 0;
}

export function validationResult(issues: readonly ValidationIssue[]): ValidationResult {
  return { valid: issues.length === 0, issues, additionalModelRequests: 0 };
}

export function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message };
}
