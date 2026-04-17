/**
 * Cloudflare Workers AI client (OpenAI-compat) — direct fetch, SSE streaming.
 *
 * The prototype uses @mariozechner/pi-ai. That's a Node lib; we can't ship it
 * inside a Worker. This is the minimum surface we need for the seams:
 *   - chat/completions with stream=true
 *   - SSE parsing of `data: {...}` lines
 *   - extract delta.content and forward to a per-token callback
 *   - extract delta.tool_calls and accumulate across frames (function-calling)
 *
 * Returns the final assembled assistant text, any tool_calls the model made,
 * and a coarse usage estimate.
 */

import type { ContentPart, Usage } from "./messages.ts";

export interface ModelDescriptor {
  id: string; // e.g. "@cf/moonshotai/kimi-k2.5"
  name: string;
  /** USD per 1M tokens. */
  cost: { input: number; output: number; cacheRead?: number };
}

export const KIMI: ModelDescriptor = {
  id: "@cf/moonshotai/kimi-k2.5",
  name: "Kimi K2.5",
  cost: { input: 0.6, output: 3, cacheRead: 0.1 },
};

export const FAST: ModelDescriptor = {
  id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  name: "Llama 3.3 70B fp8-fast",
  cost: { input: 0, output: 0 },
};

// ── Chat message shapes (OpenAI-compat) ──────────────────────────────────────

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAiContentPart[] }
  | {
      role: "assistant";
      content?: string | null;
      tool_calls?: ChatToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// ── Tool definitions ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema for arguments. */
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

// ── Call options + result ────────────────────────────────────────────────────

export interface CompleteOpts {
  accountId: string;
  apiKey: string;
  model: ModelDescriptor;
  messages: ChatMessage[];
  /** Stable id sent as `x-session-affinity` to keep momentum.hold cache hits. */
  sessionId: string;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Per-token streaming callback — only fires on content deltas, not tool_call deltas. */
  onToken?: (delta: string) => void;
  /** AbortSignal to cancel mid-stream. */
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw accumulated JSON string from the stream; parse at call-site. */
  argumentsJson: string;
}

export interface CompleteResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  provider: "cloudflare";
  modelId: string;
  /** Why the model stopped: "stop" | "tool_calls" | "length" | etc. */
  finishReason: string | null;
}

export async function complete(opts: CompleteOpts): Promise<CompleteResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model.id,
    messages: opts.messages,
    stream: true,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      "x-session-affinity": opts.sessionId,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`cf ai ${res.status}: ${errText.slice(0, 500)}`);
  }

  let text = "";
  let usage: Usage = {
    input: 0,
    output: 0,
    cost: { input: 0, output: 0, total: 0 },
  };
  let finishReason: string | null = null;

  // Tool calls can stream across many frames. OpenAI-compat: each delta has
  // `tool_calls: [{ index, id?, type?, function: { name?, arguments? } }]`.
  // Accumulate by index; id/name arrive early, arguments chunk in over time.
  const toolAcc = new Map<
    number,
    { id: string; name: string; argumentsJson: string }
  >();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames are split by blank line (\n\n). Each frame may have multiple
    // `data:` lines; per spec we concatenate them.
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      if (payload === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = json?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        text += delta.content;
        opts.onToken?.(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === "number" ? tc.index : 0;
          const prev = toolAcc.get(i) ?? { id: "", name: "", argumentsJson: "" };
          if (typeof tc.id === "string" && tc.id.length > 0) prev.id = tc.id;
          if (typeof tc.function?.name === "string" && tc.function.name.length > 0) {
            prev.name = tc.function.name;
          }
          if (typeof tc.function?.arguments === "string") {
            prev.argumentsJson += tc.function.arguments;
          }
          toolAcc.set(i, prev);
        }
      }
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      // Cloudflare emits a final frame with usage on most models.
      if (json?.usage) {
        const u = json.usage;
        usage = computeUsage(opts.model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0);
      }
    }
  }

  if (usage.input === 0 && usage.output === 0) {
    // Heuristic fallback: ~4 chars/token.
    const inputChars = opts.messages.reduce((n, m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return n + c.length;
      if (Array.isArray(c)) {
        return n + c.reduce((nn: number, p: OpenAiContentPart) => nn + (p.type === "text" ? p.text.length : 0), 0);
      }
      return n;
    }, 0);
    usage = computeUsage(opts.model, Math.ceil(inputChars / 4), Math.ceil(text.length / 4));
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => ({
      id: v.id || cryptoRandomId(),
      name: v.name,
      argumentsJson: v.argumentsJson,
    }))
    .filter((t) => t.name.length > 0);

  return {
    text,
    toolCalls,
    usage,
    provider: "cloudflare",
    modelId: opts.model.id,
    finishReason,
  };
}

function computeUsage(model: ModelDescriptor, input: number, output: number): Usage {
  const inCost = (input / 1_000_000) * model.cost.input;
  const outCost = (output / 1_000_000) * model.cost.output;
  return {
    input,
    output,
    cost: { input: inCost, output: outCost, total: inCost + outCost },
  };
}

function cryptoRandomId(): string {
  // Fallback if the model omits an id on a streamed tool_call fragment.
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert our internal ContentPart[] (with optional image) to OpenAI-compat content. */
export function toOpenAiContent(parts: ContentPart[]): string | OpenAiContentPart[] {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.map<OpenAiContentPart>((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
  });
}
