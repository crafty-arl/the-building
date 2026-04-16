/**
 * Local message + usage types for the Worker runtime.
 *
 * Mirrors the subset of @mariozechner/pi-ai's `Message` shape we actually use,
 * but stays Workers-runtime-pure (no Node deps). The wire format is JSON-safe.
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
