import type { Model } from "@mariozechner/pi-ai";

/**
 * Cloudflare Workers AI — OpenAI-compat endpoint, Kimi K2.5 (the deep mind).
 * 256k context, Thinking Mode, multi-turn tool calling, vision.
 * Paid: $0.60/M input, $3/M output.
 */
export function kimi(accountId: string): Model<"openai-completions"> {
  return {
    id: "@cf/moonshotai/kimi-k2.5",
    name: "Kimi K2.5 (the deep mind)",
    api: "openai-completions",
    provider: "cloudflare",
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 16_384,
  };
}

/**
 * Cloudflare Workers AI — Llama 3.3 70B fp8-fast (the fast mind).
 *
 * Picked over Gemma 3 12B because Gemma on Cloudflare leaks raw
 * chain-of-thought preambles ("Drafting:", "Word count: 36. Good.")
 * that corrupt downstream context. Llama 3.3 70B fp8-fast is a strong
 * instruction-follower, free on most Cloudflare tiers, and was verified
 * to produce clean short-form output during earlier CarlOS testing.
 */
export function fastMind(accountId: string): Model<"openai-completions"> {
  return {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B fp8-fast (the fast mind)",
    api: "openai-completions",
    provider: "cloudflare",
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 2_048,
  };
}
