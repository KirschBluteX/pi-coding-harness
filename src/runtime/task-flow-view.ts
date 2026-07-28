export interface TaskFlowStatusView {
  readonly goalId: string;
  readonly objective: string;
  readonly mode: "PLAN" | "BUILD";
  readonly phase: string;
  readonly stage: string | null;
  readonly workCell?: string | null;
  readonly routeHealth: string;
  readonly nextAction: string;
  readonly blocker: string | null;
}

export type TaskFlowDetail =
  | "prd" | "plan" | "changes" | "assumptions" | "risks"
  | "graph" | "why" | "performance" | "efficiency";
