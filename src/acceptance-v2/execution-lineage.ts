import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { AuthorityConnection } from "../authority/database.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface ExecutionLineageKeyV2 {
  readonly goal_id: string;
  readonly route_id: string;
  readonly work_cell_id: string;
  readonly authorization_sha256: string;
}

export interface ExecutionLineageV2 {
  readonly integration_root_sha256: string;
  readonly topology_revision_sha256: string;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new AuthorityIntegrityError(`${label} is not a SHA-256`);
  }
  return value;
}

function memberRoot(domain: string, hashes: readonly string[]): string {
  return canonicalJsonSha256({ domain, members: [...hashes].sort() });
}

export function currentExecutionLineageV2(
  connection: AuthorityConnection,
  key: ExecutionLineageKeyV2,
): ExecutionLineageV2 {
  const integrationHashes = (connection.prepare(`SELECT i.receipt_sha256 FROM integration_receipts_v1 i
    JOIN work_shards_v1 s ON s.shard_id=i.shard_id JOIN managed_runs_v1 r ON r.run_id=i.run_id
    WHERE r.goal_id=? AND s.work_cell_id=? AND i.result IN ('APPLIED','NO_CHANGES') ORDER BY i.receipt_sha256`)
    .all(key.goal_id, key.work_cell_id) as Record<string, unknown>[])
    .map((row) => sha(row.receipt_sha256, "Integration receipt"));
  const topology = connection.prepare(`SELECT t.record_sha256 FROM topology_revisions_v1 t
    JOIN managed_runs_v1 r ON r.run_id=t.run_id JOIN work_shards_v1 s ON s.run_id=r.run_id
    WHERE r.goal_id=? AND s.work_cell_id=? ORDER BY t.revision DESC LIMIT 1`)
    .get(key.goal_id, key.work_cell_id) as Record<string, unknown> | undefined;
  return {
    integration_root_sha256: memberRoot("PCH-INTEGRATION-SET-ROOT-V2", integrationHashes),
    topology_revision_sha256: topology ? sha(topology.record_sha256, "Topology revision") : canonicalJsonSha256({
      domain: "PCH-SUPERVISOR-SINGLE-TOPOLOGY-V2",
      route_id: key.route_id,
      work_cell_id: key.work_cell_id,
      authorization_sha256: key.authorization_sha256,
    }),
  };
}
