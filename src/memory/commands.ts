import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryScope } from "./types.js";

export type MemoryCommandRequest =
  | { readonly action: "status" | "conflicts" | "cleanup" }
  | { readonly action: "proposed"; readonly afterProposalId: string | null; readonly limit: number }
  | { readonly action: "reject_all"; readonly limit: number }
  | { readonly action: "list"; readonly query: string | null; readonly includeForgotten: boolean }
  | { readonly action: "why" | "approve" | "reject" | "endorse" | "unendorse" | "forget" | "restore"; readonly claimId: string }
  | { readonly action: "purge"; readonly claimId: string; readonly confirmed?: boolean }
  | { readonly action: "add"; readonly scope: MemoryScope; readonly value: string }
  | { readonly action: "edit"; readonly claimId: string; readonly value: string }
  | { readonly action: "evidence_file"; readonly scope: MemoryScope; readonly locator: string; readonly description: string }
  | { readonly action: "evidence_receipt"; readonly scope: MemoryScope; readonly locator: string; readonly description: string }
  | { readonly action: "experience_receipt"; readonly scope: MemoryScope; readonly locator: string; readonly value: string };

export interface MemoryCommandSource {
  execute(request: MemoryCommandRequest): Promise<string> | string;
}

const usage = "Usage: /memory status | list [query] | proposed [--after <proposal-id>] [--limit 1..64] | reject-all [--limit 1..64] | cleanup | why <id> | conflicts | add [goal|workspace] <policy> | evidence file|receipt [goal|workspace] <locator> [description] | experience receipt [goal|workspace] <receipt-id> <lesson> | edit <id> <value> | approve|reject|endorse|unendorse|forget|restore <id> | purge <id> [--confirm]";

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}

function words(value: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of value.matchAll(pattern)) result.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  return result.filter(Boolean);
}

function scope(tokens: string[]): MemoryScope {
  const value = tokens[0]?.toLowerCase();
  if (value === "workspace") { tokens.shift(); return "WORKSPACE"; }
  if (value === "goal") tokens.shift();
  return "GOAL";
}

export function parseMemoryCommand(args: string): MemoryCommandRequest | null {
  const tokens = words(args.trim());
  if (tokens.length === 0) return { action: "status" };
  const action = tokens.shift()?.toLowerCase();
  if (action === "status" || action === "conflicts" || action === "cleanup") {
    return tokens.length === 0 ? { action } : null;
  }
  if (action === "proposed" || action === "reject-all") {
    let afterProposalId: string | null = null;
    let limit = 20;
    while (tokens.length > 0) {
      const option = tokens.shift();
      if (option === "--after" && action === "proposed" && tokens[0]) afterProposalId = tokens.shift()!;
      else if (option === "--limit" && tokens[0] && /^\d+$/u.test(tokens[0])) limit = Number(tokens.shift());
      else return null;
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) return null;
    return action === "proposed" ? { action, afterProposalId, limit } : { action: "reject_all", limit };
  }
  if (action === "list") {
    const includeForgotten = tokens.includes("--all");
    return { action: "list", query: tokens.filter((token) => token !== "--all").join(" ") || null, includeForgotten };
  }
  if (["why", "approve", "reject", "endorse", "unendorse", "forget", "restore"].includes(action ?? "") && tokens.length === 1) {
    return { action: action as "why" | "approve" | "reject" | "endorse" | "unendorse" | "forget" | "restore", claimId: tokens[0]! };
  }
  if (action === "purge" && (tokens.length === 1 || (tokens.length === 2 && tokens[1] === "--confirm"))) {
    return { action: "purge", claimId: tokens[0]!, ...(tokens[1] === "--confirm" ? { confirmed: true } : {}) };
  }
  if (action === "add") {
    const selectedScope = scope(tokens);
    const value = tokens.join(" ").trim();
    return value ? { action: "add", scope: selectedScope, value } : null;
  }
  if (action === "edit" && tokens.length >= 2) {
    return { action: "edit", claimId: tokens.shift()!, value: tokens.join(" ") };
  }
  if (action === "evidence" && (tokens[0] === "file" || tokens[0] === "receipt")) {
    const kind = tokens.shift();
    const selectedScope = scope(tokens);
    const locator = tokens.shift();
    if (!locator) return null;
    return kind === "file"
      ? { action: "evidence_file", scope: selectedScope, locator, description: tokens.join(" ") }
      : { action: "evidence_receipt", scope: selectedScope, locator, description: tokens.join(" ") };
  }
  if (action === "experience" && tokens.shift()?.toLowerCase() === "receipt") {
    const selectedScope = scope(tokens);
    const locator = tokens.shift();
    const value = tokens.join(" ").trim();
    return locator && value ? { action: "experience_receipt", scope: selectedScope, locator, value } : null;
  }
  return null;
}

export function registerMemoryCommands(pi: ExtensionAPI, source: MemoryCommandSource): void {
  pi.registerCommand("memory", {
    description: "Inspect and control local Coding Harness Memory",
    getArgumentCompletions: (prefix) => {
      const choices = ["status", "list", "proposed", "reject-all", "cleanup", "why", "conflicts", "add", "evidence", "experience", "edit", "approve", "reject", "endorse", "unendorse", "forget", "restore", "purge"];
      const matches = choices.filter((choice) => choice.startsWith(prefix.trim().toLowerCase()))
        .map((choice) => ({ value: choice, label: choice }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const request = parseMemoryCommand(args);
      if (!request) { notify(ctx, usage, "warning"); return; }
      try {
        let executable = request;
        if (request.action === "purge") {
          if (request.confirmed !== true) {
            if (!ctx.hasUI) throw new TypeError("Non-interactive purge requires: /memory purge <id> --confirm");
            const selected = await ctx.ui.select(`Permanently purge Memory ${request.claimId}?`, [
              "[Recommended] Keep memory",
              "Permanently purge content and local key material",
            ]);
            if (selected !== "Permanently purge content and local key material") {
              notify(ctx, "Memory purge was not applied");
              return;
            }
          }
          executable = { action: "purge", claimId: request.claimId };
        }
        notify(ctx, await source.execute(executable));
      }
      catch (error) {
        notify(ctx, `Memory command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
