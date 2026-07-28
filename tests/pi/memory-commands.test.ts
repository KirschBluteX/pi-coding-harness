import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseMemoryCommand, registerMemoryCommands, type MemoryCommandRequest, type MemoryCommandSource } from "../../src/memory/commands.js";

describe("PCH Memory v2 command", () => {
  it("parses the complete local control surface", () => {
    expect(parseMemoryCommand("")).toEqual({ action: "status" });
    expect(parseMemoryCommand("add workspace Keep output concise")).toEqual({ action: "add", scope: "WORKSPACE", value: "Keep output concise" });
    expect(parseMemoryCommand('evidence file goal "docs/architecture notes.md" current source')).toEqual({
      action: "evidence_file", scope: "GOAL", locator: "docs/architecture notes.md", description: "current source",
    });
    expect(parseMemoryCommand("evidence receipt workspace RCP-1 accepted build")).toEqual({
      action: "evidence_receipt", scope: "WORKSPACE", locator: "RCP-1", description: "accepted build",
    });
    expect(parseMemoryCommand("experience receipt workspace RCP-1 Avoid the failed route")).toEqual({
      action: "experience_receipt", scope: "WORKSPACE", locator: "RCP-1", value: "Avoid the failed route",
    });
    expect(parseMemoryCommand("endorse MEM-1")).toEqual({ action: "endorse", claimId: "MEM-1" });
    expect(parseMemoryCommand("restore MEM-1")).toEqual({ action: "restore", claimId: "MEM-1" });
    expect(parseMemoryCommand("purge MEM-1")).toEqual({ action: "purge", claimId: "MEM-1" });
    expect(parseMemoryCommand("purge MEM-1 --confirm")).toEqual({ action: "purge", claimId: "MEM-1", confirmed: true });
    expect(parseMemoryCommand("proposed --after MPRP-1 --limit 12")).toEqual({
      action: "proposed", afterProposalId: "MPRP-1", limit: 12,
    });
    expect(parseMemoryCommand("reject-all --limit 8")).toEqual({ action: "reject_all", limit: 8 });
    expect(parseMemoryCommand("cleanup")).toEqual({ action: "cleanup" });
  });

  it("executes parsed commands locally without a model request", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const pi = { registerCommand: (name: string, value: unknown) => commands.set(name, value as never) } as unknown as ExtensionAPI;
    const calls: MemoryCommandRequest[] = [];
    const source: MemoryCommandSource = { execute: (request) => { calls.push(request); return request.action; } };
    registerMemoryCommands(pi, source);
    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as never;
    await commands.get("memory")?.handler("list exact route", ctx);
    await commands.get("memory")?.handler("why MEM-1", ctx);
    await commands.get("memory")?.handler("forget MEM-1", ctx);
    await commands.get("memory")?.handler("unendorse MEM-2", ctx);
    expect(calls.map((request) => request.action)).toEqual(["list", "why", "forget", "unendorse"]);
    expect(notifications).toHaveLength(4);
  });

  it("rejects incomplete or unknown arguments locally", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const pi = { registerCommand: (name: string, value: unknown) => commands.set(name, value as never) } as unknown as ExtensionAPI;
    let executions = 0;
    registerMemoryCommands(pi, { execute: () => { executions += 1; return "unexpected"; } });
    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as never;
    await commands.get("memory")?.handler("edit MEM-1", ctx);
    await commands.get("memory")?.handler("unknown", ctx);
    expect(executions).toBe(0);
    expect(notifications.every((message) => message.startsWith("Usage:"))).toBe(true);
  });

  it("requires explicit confirmation before irreversible purge", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const pi = { registerCommand: (name: string, value: unknown) => commands.set(name, value as never) } as unknown as ExtensionAPI;
    const calls: MemoryCommandRequest[] = [];
    registerMemoryCommands(pi, { execute: (request) => { calls.push(request); return "purged"; } });
    const notifications: string[] = [];
    const nonInteractive = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
    await commands.get("memory")?.handler("purge MEM-1", nonInteractive);
    expect(calls).toHaveLength(0);
    expect(notifications.at(-1)).toMatch(/--confirm/u);
    await commands.get("memory")?.handler("purge MEM-1 --confirm", nonInteractive);
    expect(calls).toEqual([{ action: "purge", claimId: "MEM-1" }]);
  });
});
