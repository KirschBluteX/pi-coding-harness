import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { createProductionDynamicMultiHostPortsFactory } from "../../src/harness/host/production-dynamic-multi.js";
import { finalizeExecutionIntegrationJournalV2 } from "../../src/harness/execution-v2/integration-journal.js";
import type { TaskFlowSession } from "../../src/runtime/task-flow-session.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Production Dynamic Multi integration", () => {
  it("serially rebases disjoint PatchSets and returns the real workspace postimage", async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), "pch-production-multi-"));
    roots.push(workspace);
    const paths = ["a.txt", "b.txt"] as const;
    writeFileSync(resolve(workspace, paths[0]), "a0", "utf8");
    writeFileSync(resolve(workspace, paths[1]), "b0", "utf8");
    const contentRoot = () => canonicalJsonSha256(paths.map((path) => ({
      path,
      sha256: sha256Hex(readFileSync(resolve(workspace, path))),
    })));
    const originalRoot = contentRoot();
    const artifactStore = new ArtifactStore(resolve(workspace, ".cas"));
    let operation = 0;
    const session = {
      workspaceRoot: () => workspace,
      prepareToolOperation: () => ({ allow: true }),
      resources: () => ({
        workspaceSecret: Buffer.alloc(32, 1),
        artifacts: artifactStore,
        authority: {
          withLeaseFence: (_lease: unknown, effect: () => void) => effect(),
          readUnresolvedTaskFlowOperations: () => [],
        },
      }),
      binding: () => ({ lease: {}, mutation: () => ({ lease: {} }) }),
      observeToolResult: () => `PCH_OPERATION_COMMITTED operation=OPERATION-${operation += 1};`,
      captureCurrentWorkspaceBaseline: () => ({ content_root_sha256: contentRoot() }),
    } as unknown as TaskFlowSession;
    const integration = createProductionDynamicMultiHostPortsFactory().create({
      session,
      workspace,
      now: () => 10_000,
    }).integration!;
    const patch = (path: string, before: string, after: string, node: string) => {
      const bytes = Buffer.from(after);
      const afterSha256 = sha256Hex(bytes);
      const { created: _created, ...metadata } = artifactStore.put(bytes, {
        mediaType: "application/octet-stream",
        classification: "INTERNAL",
        retentionClass: "GOAL",
      });
      void _created;
      return {
        packet: {
          packet_sha256: sha256Hex(`packet:${node}`),
          baseline_content_root_sha256: originalRoot,
        },
        patch_set: {
          patch_set_id: `PATCH-${node}`,
          goal_id: "GOAL-TEST",
          run_id: "RUN-TEST",
          graph_revision_id: "GRAPH-TEST",
          graph_revision_sha256: sha256Hex("graph-test"),
          node_id: `NODE-${node}`,
          node_spec_sha256: sha256Hex(`node:${node}`),
          packet_id: `PACKET-${node}`,
          packet_sha256: sha256Hex(`packet:${node}`),
          baseline_sha256: originalRoot,
          record_sha256: sha256Hex(`patch:${node}`),
          proposed_postimage_root_sha256: sha256Hex(`synthetic:${node}`),
          created_at_ms: 10_000,
          entries: [{
            operation: "MODIFY",
            path,
            before_sha256: sha256Hex(before),
            after_sha256: afterSha256,
            byte_length: bytes.byteLength,
            record_sha256: sha256Hex(`entry:${node}`),
          }],
        },
        proposal: { proposal_id: `PROPOSAL-${node}` },
        artifacts: [{ metadata, bytes }],
      };
    };
    const first = patch("a.txt", "a0", "a1", "A");
    const firstInput = {
      graph: {} as never,
      signal: new AbortController().signal,
      expected_preimage_root_sha256: originalRoot,
      ...first,
    } as unknown as Parameters<typeof integration.prepare>[0];
    const firstJournal = finalizeExecutionIntegrationJournalV2({
      integration_attempt_id: "INTEGRATION-A",
      prepared: await integration.prepare(firstInput),
    });
    const firstResult = await integration.integrate({ ...firstInput, journal: firstJournal });
    expect(firstResult).toEqual({ status: "APPLIED", postimage_root_sha256: contentRoot() });

    const second = patch("b.txt", "b0", "b1", "B");
    const secondInput = {
      graph: {} as never,
      signal: new AbortController().signal,
      expected_preimage_root_sha256: firstResult.status === "APPLIED"
        ? firstResult.postimage_root_sha256 : "unreachable",
      ...second,
    } as unknown as Parameters<typeof integration.prepare>[0];
    const secondJournal = finalizeExecutionIntegrationJournalV2({
      integration_attempt_id: "INTEGRATION-B",
      prepared: await integration.prepare(secondInput),
    });
    const secondResult = await integration.integrate({ ...secondInput, journal: secondJournal });
    expect(secondResult).toEqual({ status: "APPLIED", postimage_root_sha256: contentRoot() });
    expect(readFileSync(resolve(workspace, "a.txt"), "utf8")).toBe("a1");
    expect(readFileSync(resolve(workspace, "b.txt"), "utf8")).toBe("b1");

    const partialPreimageRoot = contentRoot();
    const partialEntries = paths.map((path, index) => {
      const before = index === 0 ? "a1" : "b1";
      const after = index === 0 ? "a2" : "b2";
      const bytes = Buffer.from(after);
      const { created: _created, ...metadata } = artifactStore.put(bytes, {
        mediaType: "application/octet-stream",
        classification: "INTERNAL",
        retentionClass: "GOAL",
      });
      void _created;
      return {
        entry: {
          operation: "MODIFY" as const,
          path,
          before_sha256: sha256Hex(before),
          after_sha256: metadata.sha256,
          byte_length: bytes.byteLength,
          record_sha256: sha256Hex(`partial-entry:${path}`),
        },
        artifact: { metadata, bytes },
      };
    });
    const partialInput = {
      graph: {} as never,
      packet: { packet_sha256: sha256Hex("partial-packet"), baseline_content_root_sha256: originalRoot },
      proposal: { proposal_id: "PROPOSAL-PARTIAL" },
      patch_set: {
        patch_set_id: "PATCH-PARTIAL",
        goal_id: "GOAL-TEST",
        run_id: "RUN-TEST",
        graph_revision_id: "GRAPH-TEST",
        graph_revision_sha256: sha256Hex("graph-test"),
        node_id: "NODE-PARTIAL",
        node_spec_sha256: sha256Hex("node-partial"),
        packet_id: "PACKET-PARTIAL",
        packet_sha256: sha256Hex("partial-packet"),
        baseline_sha256: originalRoot,
        affected_paths: [...paths],
        entries: partialEntries.map((member) => member.entry),
        proposed_postimage_root_sha256: sha256Hex("partial-synthetic-postimage"),
        created_at_ms: 10_000,
        record_sha256: sha256Hex("partial-patch"),
      },
      artifacts: partialEntries.map((member) => member.artifact),
      expected_preimage_root_sha256: partialPreimageRoot,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof integration.prepare>[0];
    const partialJournal = finalizeExecutionIntegrationJournalV2({
      integration_attempt_id: "INTEGRATION-PARTIAL",
      prepared: await integration.prepare(partialInput),
    });
    writeFileSync(resolve(workspace, "a.txt"), "a2", "utf8");
    const recovered = await integration.observe({
      ...partialInput,
      journal: partialJournal,
      integration_attempt_id: "INTEGRATION-PARTIAL",
      proposed_postimage_root_sha256: partialInput.patch_set.proposed_postimage_root_sha256,
    });
    expect(recovered).toMatchObject({
      status: "NOT_APPLIED",
      current_postimage_root_sha256: partialPreimageRoot,
    });
    expect(readFileSync(resolve(workspace, "a.txt"), "utf8")).toBe("a1");
    expect(readFileSync(resolve(workspace, "b.txt"), "utf8")).toBe("b1");
  });
});
