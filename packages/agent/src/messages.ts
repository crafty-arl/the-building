/**
 * Local message + usage types shared by every Augur runtime (Node CLI,
 * Cloudflare Worker, and anything else that stores scene turns).
 *
 * Deliberately narrower than @mariozechner/pi-ai's Message — we only persist
 * text (no thinking blocks, no tool calls) and the minimum usage fields the
 * client renders. This IS the on-disk / DO-storage shape. Do not widen it
 * without a session-format version bump.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** Base64-encoded bytes (no `data:` prefix). */
  data: string;
  mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface UserMessage {
  role: "user";
  content: ContentPart[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: TextPart[];
  timestamp: number;
  provider?: string;
  model?: string;
  usage: Usage;
}

export interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: { input: number; output: number; total: number };
}

export function assistantText(msg: AssistantMessage): string {
  return msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}
