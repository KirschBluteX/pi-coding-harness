export type OrchBenchSchedulingV1 = "BARRIER" | "CONTINUOUS";
export type OrchBenchCoordinationV1 = "CENTRAL" | "VERIFIED_QUEUE";
export type OrchBenchTopologyV1 = "FIXED_ROLE" | "DYNAMIC_CAPABILITY";

export interface OrchBenchNodeV1 {
  readonly node_id: string;
  readonly capability: string;
  readonly dependency_ids: readonly string[];
  readonly compute_ms: number;
  readonly integration_ms: number;
  readonly attempts_before_success?: number;
  readonly invalidated_at_ms?: number | null;
}

export interface OrchBenchScenarioV1 {
  readonly scenario_id: string;
  readonly nodes: readonly OrchBenchNodeV1[];
}

export interface OrchBenchConfigV1 {
  readonly workers: 1 | 2 | 4 | 8;
  readonly scheduling: OrchBenchSchedulingV1;
  readonly coordination: OrchBenchCoordinationV1;
  readonly topology: OrchBenchTopologyV1;
  readonly central_dispatch_ms: number;
  readonly verified_queue_claim_ms: number;
  readonly fixed_role_count: number;
  readonly fixed_role_startup_ms: number;
  readonly capability_startup_ms: number;
}

export interface OrchBenchNodeReceiptV1 {
  readonly node_id: string;
  readonly attempts: number;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly worker_id: number;
  readonly status: "COMPLETED" | "STOPPED";
}

export interface OrchBenchResultV1 {
  readonly schema_version: 1;
  readonly scenario_id: string;
  readonly config: OrchBenchConfigV1;
  readonly makespan_ms: number;
  readonly critical_path_ms: number;
  readonly critical_path_idle_ms: number;
  readonly startup_ms: number;
  readonly coordination_events: number;
  readonly retries: number;
  readonly stale_work_ms: number;
  readonly useful_compute_ms: number;
  readonly total_compute_ms: number;
  readonly unique_work_basis_points: number;
  readonly completed_nodes: number;
  readonly stopped_nodes: number;
  readonly receipts: readonly OrchBenchNodeReceiptV1[];
}

interface NodeState {
  readonly spec: OrchBenchNodeV1;
  status: "PENDING" | "COMPUTING" | "INTEGRATING" | "COMPLETED" | "STOPPED";
  attempts: number;
  firstStartedAt: number | null;
  workerId: number | null;
}

interface SimEvent {
  readonly time: number;
  readonly kind: "COMPUTE_DONE" | "INTEGRATION_DONE";
  readonly nodeId: string;
  readonly workerId: number;
  readonly startedAt: number;
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}

function assertScenario(scenario: OrchBenchScenarioV1): void {
  const rawNodes: unknown = scenario.nodes;
  if (!scenario.scenario_id || !Array.isArray(rawNodes) || scenario.nodes.length === 0) {
    throw new TypeError("OrchBench scenario is invalid");
  }
  const ids = new Set(scenario.nodes.map((node) => node.node_id));
  if (ids.size !== scenario.nodes.length || [...ids].some((id) => id.length === 0)) {
    throw new TypeError("OrchBench node identities are invalid");
  }
  for (const node of scenario.nodes) {
    nonNegativeInteger(node.compute_ms, `${node.node_id} compute time`);
    nonNegativeInteger(node.integration_ms, `${node.node_id} integration time`);
    if (node.compute_ms === 0 || !node.capability || new Set(node.dependency_ids).size !== node.dependency_ids.length
      || node.dependency_ids.some((dependency) => dependency === node.node_id || !ids.has(dependency))) {
      throw new TypeError(`OrchBench node ${node.node_id} is invalid`);
    }
    const attempts = node.attempts_before_success ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 32) {
      throw new TypeError(`OrchBench node ${node.node_id} attempt bound is invalid`);
    }
    if (node.invalidated_at_ms !== undefined && node.invalidated_at_ms !== null) {
      nonNegativeInteger(node.invalidated_at_ms, `${node.node_id} invalidation time`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(scenario.nodes.map((node) => [node.node_id, node]));
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new TypeError("OrchBench scenario contains a cycle");
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of byId.get(nodeId)!.dependency_ids) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of scenario.nodes) visit(node.node_id);
}

function assertConfig(config: OrchBenchConfigV1): void {
  if (![1, 2, 4, 8].includes(config.workers)) throw new TypeError("OrchBench worker count is invalid");
  for (const [value, label] of [
    [config.central_dispatch_ms, "central dispatch"],
    [config.verified_queue_claim_ms, "verified queue claim"],
    [config.fixed_role_count, "fixed role count"],
    [config.fixed_role_startup_ms, "fixed role startup"],
    [config.capability_startup_ms, "capability startup"],
  ] as const) nonNegativeInteger(value, `OrchBench ${label}`);
  if (config.fixed_role_count === 0) throw new TypeError("OrchBench fixed role count must be positive");
}

function criticalPathByNode(scenario: OrchBenchScenarioV1): ReadonlyMap<string, number> {
  const successors = new Map(scenario.nodes.map((node) => [node.node_id, [] as string[]]));
  for (const node of scenario.nodes) for (const dependency of node.dependency_ids) successors.get(dependency)!.push(node.node_id);
  const byId = new Map(scenario.nodes.map((node) => [node.node_id, node]));
  const memo = new Map<string, number>();
  const visit = (nodeId: string): number => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    const node = byId.get(nodeId)!;
    const value = node.compute_ms + node.integration_ms
      + Math.max(0, ...successors.get(nodeId)!.map(visit));
    memo.set(nodeId, value);
    return value;
  };
  for (const node of scenario.nodes) visit(node.node_id);
  return memo;
}

function insertEvent(events: SimEvent[], event: SimEvent): void {
  events.push(event);
  events.sort((left, right) => left.time - right.time
    || left.kind.localeCompare(right.kind) || left.nodeId.localeCompare(right.nodeId));
}

export function simulateOrchBenchV1(
  scenario: OrchBenchScenarioV1,
  config: OrchBenchConfigV1,
): OrchBenchResultV1 {
  assertScenario(scenario);
  assertConfig(config);
  const states = new Map<string, NodeState>(scenario.nodes.map((node): [string, NodeState] => [node.node_id, {
    spec: node, status: "PENDING", attempts: 0, firstStartedAt: null, workerId: null,
  }]));
  const criticalPaths = criticalPathByNode(scenario);
  const criticalPathMs = Math.max(...criticalPaths.values());
  const capabilities = new Set(scenario.nodes.map((node) => node.capability));
  const startupMs = config.topology === "FIXED_ROLE"
    ? config.fixed_role_count * config.fixed_role_startup_ms
    : capabilities.size * config.capability_startup_ms;
  const workerAvailable = Array.from({ length: config.workers }, () => startupMs);
  const events: SimEvent[] = [];
  const completionTime = new Map<string, number>();
  let now = startupMs;
  let integrationAvailable = startupMs;
  let coordinatorAvailable = startupMs;
  let waveOpen = true;
  let coordinationEvents = 0;
  let retries = 0;
  let staleWorkMs = 0;
  let totalComputeMs = 0;
  let usefulComputeMs = 0;

  const activeCount = (): number => [...states.values()]
    .filter((state) => state.status === "COMPUTING" || state.status === "INTEGRATING").length;
  const ready = (): NodeState[] => [...states.values()]
    .filter((state) => state.status === "PENDING")
    .filter((state) => state.spec.dependency_ids.every((dependency) => states.get(dependency)!.status === "COMPLETED"))
    .sort((left, right) => (criticalPaths.get(right.spec.node_id) ?? 0) - (criticalPaths.get(left.spec.node_id) ?? 0)
      || left.spec.node_id.localeCompare(right.spec.node_id));

  while ([...states.values()].some((state) => state.status === "PENDING"
    || state.status === "COMPUTING" || state.status === "INTEGRATING")) {
    while (events[0]?.time === now) {
      const event = events.shift()!;
      const state = states.get(event.nodeId)!;
      if (event.kind === "COMPUTE_DONE") {
        workerAvailable[event.workerId] = now;
        totalComputeMs += state.spec.compute_ms;
        const invalidatedAt = state.spec.invalidated_at_ms;
        if (invalidatedAt !== undefined && invalidatedAt !== null
          && invalidatedAt >= event.startedAt && invalidatedAt <= now) {
          staleWorkMs += now - invalidatedAt;
          state.status = "STOPPED";
          continue;
        }
        if (state.attempts < (state.spec.attempts_before_success ?? 1)) {
          staleWorkMs += state.spec.compute_ms;
          retries += 1;
          state.status = "PENDING";
          continue;
        }
        usefulComputeMs += state.spec.compute_ms;
        if (state.spec.integration_ms === 0) {
          state.status = "COMPLETED";
          completionTime.set(state.spec.node_id, now);
        } else {
          state.status = "INTEGRATING";
          const integrationDone = Math.max(now, integrationAvailable) + state.spec.integration_ms;
          integrationAvailable = integrationDone;
          insertEvent(events, { ...event, time: integrationDone, kind: "INTEGRATION_DONE" });
        }
      } else {
        state.status = "COMPLETED";
        completionTime.set(state.spec.node_id, now);
      }
    }

    if (config.scheduling === "BARRIER" && activeCount() === 0) waveOpen = true;
    const freeWorkers = workerAvailable
      .map((availableAt, workerId) => ({ availableAt, workerId }))
      .filter((worker) => worker.availableAt <= now)
      .sort((left, right) => left.workerId - right.workerId);
    const candidates = (config.scheduling === "CONTINUOUS" || waveOpen) ? ready() : [];
    let dispatched = 0;
    while (freeWorkers.length > 0 && candidates.length > 0) {
      const worker = freeWorkers.shift()!;
      const state = candidates.shift()!;
      const delay = config.coordination === "CENTRAL" ? config.central_dispatch_ms : config.verified_queue_claim_ms;
      const dispatchStart = config.coordination === "CENTRAL"
        ? Math.max(now, coordinatorAvailable)
        : now;
      const start = dispatchStart + delay;
      if (config.coordination === "CENTRAL") coordinatorAvailable = start;
      state.status = "COMPUTING";
      state.attempts += 1;
      state.firstStartedAt ??= start;
      state.workerId = worker.workerId;
      workerAvailable[worker.workerId] = start + state.spec.compute_ms;
      insertEvent(events, {
        time: workerAvailable[worker.workerId]!, kind: "COMPUTE_DONE", nodeId: state.spec.node_id,
        workerId: worker.workerId, startedAt: start,
      });
      coordinationEvents += 1;
      dispatched += 1;
    }
    if (config.scheduling === "BARRIER" && dispatched > 0) waveOpen = false;

    if (events.length === 0) {
      const pending = [...states.values()].filter((state) => state.status === "PENDING");
      for (const state of pending) state.status = "STOPPED";
      break;
    }
    if (dispatched === 0 || events[0]!.time > now) now = events[0]!.time;
  }

  const receipts = [...states.values()].map((state): OrchBenchNodeReceiptV1 => ({
    node_id: state.spec.node_id,
    attempts: state.attempts,
    started_at_ms: state.firstStartedAt ?? startupMs,
    completed_at_ms: state.status === "COMPLETED" ? completionTime.get(state.spec.node_id)! : null,
    worker_id: state.workerId ?? -1,
    status: state.status === "COMPLETED" ? "COMPLETED" : "STOPPED",
  })).sort((left, right) => left.node_id.localeCompare(right.node_id));
  const makespanMs = Math.max(startupMs, ...receipts.map((receipt) => receipt.completed_at_ms ?? now));
  return {
    schema_version: 1,
    scenario_id: scenario.scenario_id,
    config,
    makespan_ms: makespanMs,
    critical_path_ms: criticalPathMs,
    critical_path_idle_ms: Math.max(0, makespanMs - criticalPathMs),
    startup_ms: startupMs,
    coordination_events: coordinationEvents,
    retries,
    stale_work_ms: staleWorkMs,
    useful_compute_ms: usefulComputeMs,
    total_compute_ms: totalComputeMs,
    unique_work_basis_points: totalComputeMs === 0 ? 10_000 : Math.floor(usefulComputeMs * 10_000 / totalComputeMs),
    completed_nodes: receipts.filter((receipt) => receipt.status === "COMPLETED").length,
    stopped_nodes: receipts.filter((receipt) => receipt.status === "STOPPED").length,
    receipts,
  };
}

export function compareWorkerMarginalContributionV1(
  scenario: OrchBenchScenarioV1,
  base: Omit<OrchBenchConfigV1, "workers">,
): readonly { readonly workers: 1 | 2 | 4 | 8; readonly makespan_ms: number; readonly marginal_gain_ms: number }[] {
  let previous: number | null = null;
  return ([1, 2, 4, 8] as const).map((workers) => {
    const makespan = simulateOrchBenchV1(scenario, { ...base, workers }).makespan_ms;
    const result = { workers, makespan_ms: makespan, marginal_gain_ms: previous === null ? 0 : previous - makespan };
    previous = makespan;
    return result;
  });
}
