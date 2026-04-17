/**
 * Shared helpers for parsing llama JSON outputs. Factored out of index.ts so
 * daily-plan.ts and other modules can reuse without a circular import.
 */

/**
 * Best-effort balance of unmatched braces/brackets at the end. Models often
 * truncate JSON one bracket short.
 */
export function balanceJson(text: string): string {
  const start = text.indexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (start < 0) return text;
  let s = text.slice(start, lastClose >= 0 ? lastClose + 1 : undefined);
  let braces = 0, brackets = 0, inString = false, escape = false;
  for (const c of s) {
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
  }
  while (brackets > 0) { s += "]"; brackets--; }
  while (braces > 0) { s += "}"; braces--; }
  return s;
}

export function parseAiResponse(aiResponse: unknown): unknown {
  const r = (aiResponse as { response?: unknown })?.response;
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  const text =
    typeof r === "string" ? r : typeof aiResponse === "string" ? aiResponse : "";
  if (!text) return null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(balanceJson(text));
  } catch {
    return null;
  }
}
