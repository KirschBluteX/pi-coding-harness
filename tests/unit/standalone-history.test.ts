import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHistoryStore } from "../../src/standalone/history.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("standalone conversation recovery", () => {
  it("keeps a checked non-authoritative transcript under the selected data root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pch-history-"));
    roots.push(root);
    const store = new SessionHistoryStore(resolve(root, "data"));
    const value = { sessionId: "SESSION-1", goalId: "GOAL-1", workspace: resolve(root, "workspace"),
      messages: [{ role: "system" as const, content: "PCH" }, { role: "user" as const, content: "Fix file" }] };
    const path = store.save(value);
    expect(path.startsWith(resolve(root, "data"))).toBe(true);
    expect(store.load(value.sessionId)).toMatchObject(value);
    const tampered = JSON.parse(readFileSync(path, "utf8")) as { messages: unknown[] };
    tampered.messages = [{ role: "user", content: "altered" }];
    writeFileSync(path, JSON.stringify(tampered));
    expect(() => store.load(value.sessionId)).toThrow(/integrity/i);
  });
});
