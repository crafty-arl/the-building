/**
 * Cloudflare Workers AI client (OpenAI-compat) — direct fetch, SSE streaming.
 *
 * The prototype uses @mariozechner/pi-ai. That's a Node lib; we can't ship it
 * inside a Worker. This is the minimum surface we need for the seams:
 *   - chat/completions with stream=true
 *   - SSE parsing of `data: {...}` lines
 *   - extract delta.content and forward to a per-token callback
 *
 * Returns the final assembled assistant text + a coarse usage estimate
 * (Cloudflare's OpenAI-compat layer surfaces `usage` on the terminal frame
 * for most models; if absent we fall back to a token-character heuristic).
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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** OpenAI-compat: string OR multi-part content array (for vision). */
  content: string | OpenAiContentPart[];
}

export type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface CompleteOpts {
  accountId: string;
  apiKey: string;
  model: ModelDescriptor;
  messages: ChatMessage[];
  /** Stable id sent as `x-session-affinity` to keep momentum.hold cache hits. */
  sessionId: string;
  maxTokens?: number;
  /** Per-token streaming callback. */
  onToken?: (delta: string) => void;
  /** AbortSignal to cancel mid-stream. */
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  provider: "cloudflare";
  modelId: string;
}

export async function complete(opts: CompleteOpts): Promise<CompleteResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/v1/chat/completions`;
  const body = {
    model: opts.model.id,
    messages: opts.messages,
    stream: true,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  };

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
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        opts.onToken?.(delta);
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
      if (typeof m.content === "string") return n + m.content.length;
      return n + m.content.reduce((nn, p) => nn + (p.type === "text" ? p.text.length : 0), 0);
    }, 0);
    usage = computeUsage(opts.model, Math.ceil(inputChars / 4), Math.ceil(text.length / 4));
  }

  return { text, usage, provider: "cloudflare", modelId: opts.model.id };
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

/** Convert our internal ContentPart[] (with optional image) to OpenAI-compat content. */
export function toOpenAiContent(parts: ContentPart[]): string | OpenAiContentPart[] {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.map<OpenAiContentPart>((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
  });
}
