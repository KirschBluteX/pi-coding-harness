import OpenAI from "openai";
import type { HostProviderUsage } from "../harness/host/application-protocol.js";

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: readonly {
      readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string };
    }[] }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

export interface ChatTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: HostProviderUsage | null;
  readonly finishReason: string;
}

export interface ChatModel {
  turn(messages: readonly ChatMessage[], tools: readonly ChatTool[], signal?: AbortSignal): Promise<ModelTurn>;
}

export interface OpenAiCompatibleOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

interface PartialToolCall {
  id: string | null;
  name: string | null;
  argumentsText: string;
}

function usageOf(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): HostProviderUsage | null {
  const usage = chunk.usage;
  if (!usage) return null;
  return {
    input: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    output: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    cacheRead: typeof usage.prompt_tokens_details?.cached_tokens === "number"
      ? usage.prompt_tokens_details.cached_tokens : null,
    cacheWrite: null,
    reasoning: typeof usage.completion_tokens_details?.reasoning_tokens === "number"
      ? usage.completion_tokens_details.reasoning_tokens : null,
  };
}

export class OpenAiCompatibleModel implements ChatModel {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleOptions) {
    if (!options.apiKey || !options.model || !options.baseURL) throw new TypeError("Model credentials, base URL and model ID are required");
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 0 });
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async turn(messages: readonly ChatMessage[], tools: readonly ChatTool[], signal?: AbortSignal): Promise<ModelTurn> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      ...(tools.length === 0 ? {} : { tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] }),
      stream: true,
      stream_options: { include_usage: true },
    }, { signal, timeout: this.timeoutMs });
    let text = "";
    let finishReason: string | null = null;
    let usage: HostProviderUsage | null = null;
    const partial = new Map<number, PartialToolCall>();
    for await (const chunk of stream) {
      usage = usageOf(chunk) ?? usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason !== null) {
        if (finishReason !== null && finishReason !== choice.finish_reason) throw new TypeError("Conflicting provider finish reasons");
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (typeof delta.content === "string") {
        text += delta.content;
        if (Buffer.byteLength(text, "utf8") > 524_288) throw new TypeError("Provider text exceeds the bounded response limit");
      }
      for (const call of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index > 31) {
          throw new TypeError("Provider tool index is invalid");
        }
        const current = partial.get(call.index) ?? { id: null, name: null, argumentsText: "" };
        if (call.id) {
          if (current.id !== null && current.id !== call.id) throw new TypeError("Provider tool ID changed during streaming");
          current.id = call.id;
        }
        if (call.function?.name) {
          if (current.name !== null && current.name !== call.function.name) throw new TypeError("Provider tool name changed during streaming");
          current.name = call.function.name;
        }
        current.argumentsText += call.function?.arguments ?? "";
        if (Buffer.byteLength(current.argumentsText, "utf8") > 262_144) {
          throw new TypeError("Provider tool arguments exceed the bounded response limit");
        }
        partial.set(call.index, current);
      }
    }
    if (finishReason === null || !["stop", "tool_calls"].includes(finishReason)) {
      throw new TypeError(`Provider turn is incomplete or truncated: ${finishReason ?? "missing finish"}`);
    }
    const seen = new Set<string>();
    const toolCalls = [...partial].sort(([a], [b]) => a - b).map(([, call]) => {
      if (!call.id || !call.name || seen.has(call.id)) throw new TypeError("Provider returned an incomplete or duplicate tool call");
      seen.add(call.id);
      let parsed: unknown;
      try { parsed = JSON.parse(call.argumentsText); }
      catch { throw new TypeError(`Provider tool arguments are incomplete for ${call.name}`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError(`Provider tool arguments must be an object for ${call.name}`);
      }
      return { id: call.id, name: call.name, arguments: parsed as Readonly<Record<string, unknown>> };
    });
    if (finishReason === "tool_calls" && toolCalls.length === 0) throw new TypeError("Provider declared tool calls without a complete call");
    return { text, toolCalls, usage, finishReason };
  }
}
