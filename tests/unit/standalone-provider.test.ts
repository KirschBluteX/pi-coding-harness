import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleModel } from "../../src/standalone/provider.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixture(events: readonly object[]): Promise<string> {
  const server = createServer((request, response) => {
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer fixture-key");
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("Missing fixture port");
  return `http://127.0.0.1:${address.port}/v1`;
}

const choice = (delta: object, finishReason: string | null = null) => ({
  id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

describe("standalone provider stream", () => {
  it("assembles split tool arguments and reports only provider-supplied usage", async () => {
    const baseURL = await fixture([
      choice({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] }),
      choice({ tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] }, "tool_calls"),
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 4 } } },
    ]);
    const model = new OpenAiCompatibleModel({ apiKey: "fixture-key", baseURL, model: "fixture-model" });
    const result = await model.turn([{ role: "user", content: "inspect" }], []);
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read", arguments: { path: "src/a.ts" } }]);
    expect(result.usage).toMatchObject({ input: 20, output: 8, cacheRead: 4 });
  });

  it("never exposes a truncated tool argument as executable", async () => {
    const baseURL = await fixture([
      choice({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: '{"path":"src/a.ts"' } }] }, "length"),
    ]);
    const model = new OpenAiCompatibleModel({ apiKey: "fixture-key", baseURL, model: "fixture-model" });
    await expect(model.turn([{ role: "user", content: "write" }], [])).rejects.toThrow(/incomplete|truncated/iu);
  });
});
