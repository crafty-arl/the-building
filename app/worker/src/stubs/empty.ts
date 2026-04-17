/**
 * Empty-module stub for provider SDKs pi-ai references but we never call at
 * runtime (Anthropic / OpenAI / Google / Mistral / Bedrock). Wrangler
 * `[alias]` rewrites those specifiers to this file so they don't bloat the
 * worker bundle.
 *
 * pi-ai loads providers lazily via dynamic `import()`. We only ever call the
 * `openai-completions` driver against Cloudflare's endpoint, so the other
 * branches never execute — but esbuild still includes them in the static
 * import graph unless aliased away.
 */

// Proxy target MUST be a regular function (not an arrow) so it exposes the
// [[Construct]] internal slot — pi-ai's openai-completions driver does
// `new OpenAI(...)` with the default import, which requires the target to
// be constructible or the `construct` trap to be reachable.
function target(): unknown {
  return proxy;
}
const proxy: unknown = new Proxy(target, {
  get: () => proxy,
  apply: () => proxy,
  construct: () => proxy as object,
});

export default proxy;
export const __esModule = true;

// Named re-exports for symbols pi-ai provider files import by name. esbuild
// resolves named imports statically even inside lazy dynamic-import branches,
// so we must satisfy every name. All of these are no-ops — the containing
// provider functions are never invoked at runtime (only openai-completions
// is ever used against Cloudflare).
export const GoogleGenAI = proxy;
export const ThinkingLevel = proxy;
export const FunctionCallingConfigMode = proxy;
export const FinishReason = proxy;
export const Mistral = proxy;
export const AzureOpenAI = proxy;
