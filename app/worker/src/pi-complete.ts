/**
 * pi-ai-backed implementation of the worker's legacy `complete()` contract.
 *
 * Same signature as `cf-ai.ts`'s `complete()` — accepts ChatMessage[] and
 * ToolDefinition[] in OpenAI wire format, streams tokens through `onToken`,
 * returns `{ text, toolCalls, usage, finishReason }` — but routes through
 * `@mariozechner/pi-ai`'s openai-completions driver against Cloudflare.
 *
 * This is Step 4 of the pi-agent migration: swap the HTTP layer only. The
 * hand-rolled agent loop in `seams.ts` is unchanged. `cf-ai.ts` stays as a
 * revert safety net; nothing inside the worker still imports its `complete()`
 * once this file is wired in.
 */

import {
  complete as piComplete,
  stream as piStream,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent,
  type Context as PiContext,
  type Message as PiMessage,
  type Model,
  type TextContent as PiTextContent,
  type ToolCall as PiToolCall,
  type ToolResultMessage as PiToolResultMessage,
  type UserMessage as PiUserMessage,
  type Usage as PiUsage,
} from "@mariozechner/pi-ai";
import { Type, type TSchema } from "@sinclair/typebox";
import { kimi, fastMind } from "@augur/agent";
import type {
  ChatMessage,
  CompleteOpts,
  CompleteResult,
  ModelDescriptor,
  OpenAiContentPart,
  ToolCall,
  ToolDefinition,
} from "./cf-ai.ts";
import { KIMI, FAST } from "./cf-ai.ts";
import type { Usage } from "./messages.ts";

const MAGIC_FALLBACK_RATE = 4;

/**
 * Same external contract as `cf-ai.ts`'s `complete()`. Routes through pi-ai's
 * stream() so we pick up session-affinity headers, retry logic, and tool-call
 * aggregation from upstream — while keeping our hand-rolled agent loop.
 */
export async function complete(opts: CompleteOpts): Promise<CompleteResult> {
  const model = buildPiModel(opts.model, opts.accountId);
  const { systemPrompt, messages: piMessages } = threadToPiContext(opts.messages);
  const toolNameByCallId = buildToolNameLookup(opts.messages);

  const context: PiContext = {
    systemPrompt,
    messages: piMessages,
    ...(opts.tools && opts.tools.length > 0
      ? { tools: toolDefsToPi(opts.tools) }
      : {}),
  };

  const callOpts = {
    apiKey: opts.apiKey,
    sessionId: opts.sessionId,
    headers: { "x-session-affinity": opts.sessionId },
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
  } satisfies Record<string, unknown>;

  console.log(
    `[pi-ai] DO→pi-ai complete model=${model.id} api=${model.api} provider=${model.provider} stream=${!!opts.onToken} tools=${opts.tools?.length ?? 0} toolChoice=${opts.toolChoice ?? "auto"} sessionId=${opts.sessionId} msgs=${piMessages.length} sysLen=${systemPrompt.length}`,
  );

  if (opts.onToken) {
    // Streaming path — aggregate text deltas and fire onToken per chunk.
    return streamToResult(opts, model, context, callOpts, toolNameByCallId);
  }

  const assistant = await piComplete(model, context, callOpts);
  console.log(
    `[pi-ai] DO←pi-ai complete(non-stream) stopReason=${assistant.stopReason} in=${assistant.usage.input} out=${assistant.usage.output} toolCalls=${assistant.content.filter((c) => c.type === "toolCall").length}`,
  );
  return assistantToResult(opts, assistant);
}

function buildPiModel(descriptor: ModelDescriptor, accountId: string): Model<"openai-completions"> {
  // KIMI / FAST descriptors in cf-ai.ts are identity-compared references. Map
  // them to @augur/agent's pre-built Model factories so we hit the same
  // Cloudflare openai-compat endpoint with the same model ids.
  if (descriptor === KIMI || descriptor.id === KIMI.id) return kimi(accountId);
  if (descriptor === FAST || descriptor.id === FAST.id) return fastMind(accountId);
  // Unknown model — fall back to Kimi (same endpoint, different model id).
  const base = kimi(accountId);
  return { ...base, id: descriptor.id };
}

async function streamToResult(
  opts: CompleteOpts,
  model: Model<"openai-completions">,
  context: PiContext,
  callOpts: Record<string, unknown>,
  toolNameByCallId: Map<string, string>,
): Promise<CompleteResult> {
  const iterable = piStream(model, context, callOpts as Parameters<typeof piStream>[2]);
  let finalMessage: PiAssistantMessage | undefined;
  let deltaCount = 0;
  let firstDeltaSeen = false;
  for await (const ev of iterable as AsyncIterable<AssistantMessageEvent>) {
    if (ev.type === "text_delta") {
      const delta = (ev as { delta?: string }).delta ?? "";
      if (!firstDeltaSeen && delta) {
        firstDeltaSeen = true;
        console.log(`[pi-ai] DO←pi-ai first text_delta (streaming confirmed)`);
      }
      if (delta) deltaCount++;
      if (delta && opts.onToken) opts.onToken(delta);
    } else if (ev.type === "done") {
      finalMessage = (ev as { message: PiAssistantMessage }).message;
    } else if (ev.type === "error") {
      const err = (ev as { error: PiAssistantMessage }).error;
      finalMessage = err;
      console.log(`[pi-ai] DO←pi-ai error ${err.errorMessage ?? "(no message)"}`);
    }
  }
  if (!finalMessage) {
    throw new Error("pi-ai stream ended without a done/error event");
  }
  console.log(
    `[pi-ai] DO←pi-ai stream done deltas=${deltaCount} stopReason=${finalMessage.stopReason} in=${finalMessage.usage.input} out=${finalMessage.usage.output} toolCalls=${finalMessage.content.filter((c) => c.type === "toolCall").length}`,
  );
  return assistantToResult(opts, finalMessage, toolNameByCallId);
}

function assistantToResult(
  opts: CompleteOpts,
  assistant: PiAssistantMessage,
  _toolNameByCallId?: Map<string, string>,
): CompleteResult {
  const text = assistant.content
    .filter((c): c is PiTextContent => c.type === "text")
    .map((c) => c.text)
    .join("");

  const toolCalls: ToolCall[] = assistant.content
    .filter((c): c is PiToolCall => c.type === "toolCall")
    .map((c) => ({
      id: c.id,
      name: c.name,
      argumentsJson: JSON.stringify(c.arguments ?? {}),
    }));

  const usage = piUsageToOurs(opts.model, assistant.usage, text, opts.messages);

  return {
    text,
    toolCalls,
    usage,
    provider: "cloudflare",
    modelId: assistant.model || opts.model.id,
    finishReason: assistant.stopReason ?? null,
  };
}

/**
 * pi-ai reports full usage (input / output / cacheRead / cacheWrite / cost).
 * Our wire shape collapses costs into a single total triple (input/output/total).
 * Fall back to the same 4-chars-per-token heuristic cf-ai uses when the
 * provider omitted a usage block.
 */
function piUsageToOurs(
  descriptor: ModelDescriptor,
  piUsage: PiUsage,
  text: string,
  thread: ChatMessage[],
): Usage {
  let input = piUsage.input;
  let output = piUsage.output;
  if (input === 0 && output === 0) {
    const inputChars = thread.reduce((n, m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return n + c.length;
      if (Array.isArray(c)) {
        return (
          n +
          c.reduce(
            (nn: number, p: OpenAiContentPart) => nn + (p.type === "text" ? p.text.length : 0),
            0,
          )
        );
      }
      return n;
    }, 0);
    input = Math.ceil(inputChars / MAGIC_FALLBACK_RATE);
    output = Math.ceil(text.length / MAGIC_FALLBACK_RATE);
  }
  const inCost = (input / 1_000_000) * descriptor.cost.input;
  const outCost = (output / 1_000_000) * descriptor.cost.output;
  const cacheRead = piUsage.cacheRead || 0;
  const cacheWrite = piUsage.cacheWrite || 0;
  return {
    input,
    output,
    ...(cacheRead ? { cacheRead } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
    cost: { input: inCost, output: outCost, total: inCost + outCost },
  };
}

/**
 * Convert the worker's OpenAI-shaped ChatMessage[] into pi-ai's Context
 * (systemPrompt + Message[]). System messages are pulled out to `systemPrompt`
 * (concatenated if multiple).
 */
function threadToPiContext(
  thread: ChatMessage[],
): { systemPrompt: string; messages: PiMessage[] } {
  const systemParts: string[] = [];
  const messages: PiMessage[] = [];
  for (const m of thread) {
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? [{ type: "text" as const, text: m.content }]
          : m.content.map((p) => openAiContentToPi(p));
      const userMsg: PiUserMessage = {
        role: "user",
        content,
        timestamp: Date.now(),
      };
      messages.push(userMsg);
      continue;
    }
    if (m.role === "assistant") {
      const parts: PiAssistantMessage["content"] = [];
      const text = typeof m.content === "string" ? m.content : "";
      if (text) parts.push({ type: "text", text });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = {};
          }
          parts.push({
            type: "toolCall",
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          });
        }
      }
      const asst: PiAssistantMessage = {
        role: "assistant",
        content: parts,
        api: "openai-completions",
        provider: "cloudflare" as PiAssistantMessage["provider"],
        model: "",
        usage: emptyUsage(),
        stopReason: parts.some((p) => p.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      messages.push(asst);
      continue;
    }
    if (m.role === "tool") {
      const toolName = findPrecedingToolName(thread, m.tool_call_id);
      const result: PiToolResultMessage = {
        role: "toolResult",
        toolCallId: m.tool_call_id,
        toolName,
        content: [{ type: "text", text: m.content }],
        isError: false,
        timestamp: Date.now(),
      };
      messages.push(result);
    }
  }
  return { systemPrompt: systemParts.join("\n\n"), messages };
}

type PiUserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function openAiContentToPi(p: OpenAiContentPart): PiUserContentPart {
  if (p.type === "text") return { type: "text", text: p.text };
  const url = p.image_url.url;
  // data:<mime>;base64,<payload>
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { type: "image", data: m[2], mimeType: m[1] };
  return { type: "image", data: url, mimeType: "image/png" };
}

/**
 * Convert our OpenAI-style ToolDefinition[] into pi-ai's Tool[] (which uses
 * a TypeBox schema for `parameters`). The schema we import here is a thin
 * TypeBox wrapper around the existing JSON Schema — pi-ai only inspects
 * `.parameters` when serializing to the wire, so the shape is preserved.
 */
function toolDefsToPi(defs: ToolDefinition[]): { name: string; description: string; parameters: TSchema }[] {
  return defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    parameters: jsonSchemaToTypeBox(d.function.parameters),
  }));
}

function jsonSchemaToTypeBox(js: Record<string, unknown>): TSchema {
  // Pragmatic shim: wrap the raw JSON Schema as a TypeBox-compatible value.
  // pi-ai's openai-completions driver serializes `parameters` back to the
  // wire as-is, so wrapping preserves both behaviours: the object is
  // TypeBox-typed at the boundary but structurally identical on the wire.
  return Type.Unsafe(js);
}

function buildToolNameLookup(thread: ChatMessage[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const msg of thread) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) m.set(tc.id, tc.function.name);
    }
  }
  return m;
}

function findPrecedingToolName(thread: ChatMessage[], toolCallId: string): string {
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id === toolCallId) return tc.function.name;
      }
    }
  }
  return "unknown";
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
