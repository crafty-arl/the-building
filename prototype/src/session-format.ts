/**
 * Augur session serialization format (v1).
 *
 * Pinned format. Round-trip guarantee: load → new SessionTree → re-save
 * should be byte-identical modulo `savedAt`.
 */

import type { Message, Usage } from "@mariozechner/pi-ai";

export const AUGUR_SESSION_FORMAT_VERSION = 1 as const;

export interface SerializedEntry {
  id: string;
  parentId: string | null;
  card?: { id: string; mechanic: string };
  label?: string;
  timestamp: number;
  messages: Message[];
  usage?: Usage;
}

export interface SerializedSession {
  version: typeof AUGUR_SESSION_FORMAT_VERSION;
  sessionId: string;
  savedAt: string;
  leafId: string | null;
  entries: SerializedEntry[];
  facts: Record<string, string>;
  vows: string[];
}
