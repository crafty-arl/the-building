/**
 * SessionTree — ported verbatim (in shape) from prototype/src/tree.ts.
 *
 * Same public API: add / branch / bindFact / addVow / getBranchMessages /
 * renderFacts / all / getLeaf / getFacts / getVows / toJSON / fromJSON.
 *
 * Differences vs prototype:
 *  - Uses local Message type (./messages.ts) instead of @mariozechner/pi-ai.
 *  - Drops the terminal `render()` pretty-printer (we don't print in a Worker).
 */

import type { Message, Usage } from "./messages.ts";

export const AUGUR_SESSION_FORMAT_VERSION = 1 as const;

export interface Entry {
  id: string;
  parentId: string | null;
  card?: { id: string; mechanic: string };
  messages: Message[];
  usage?: Usage;
  label?: string;
  timestamp: number;
}

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

export class SessionTree {
  private entries = new Map<string, Entry>();
  private leafId: string | null = null;
  private nextId = 1;
  private facts = new Map<string, string>();
  private vows: string[] = [];

  bindFact(key: string, value: string): void {
    this.facts.set(key, value);
  }

  addVow(text: string): void {
    this.vows.push(text);
  }

  getFacts(): ReadonlyMap<string, string> {
    return this.facts;
  }

  getVows(): readonly string[] {
    return this.vows;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  renderFacts(): string {
    const parts: string[] = [];
    if (this.facts.size > 0) {
      parts.push(
        "SCENE STATE (place.bind — these facts are TRUE now and must remain true in your prose):",
      );
      for (const [k, v] of this.facts) parts.push(`  — ${k}: ${v}`);
    }
    if (this.vows.length > 0) {
      if (parts.length > 0) parts.push("");
      parts.push(
        "ACTIVE VOWS (ward.vow — inviolable for the rest of this scene; you MUST NOT violate them in narration or dialogue):",
      );
      for (const v of this.vows) parts.push(`  — ${v}`);
    }
    return parts.join("\n");
  }

  add(entry: Omit<Entry, "id" | "timestamp">): Entry {
    const id = `e${this.nextId++}`;
    const full: Entry = { ...entry, id, timestamp: Date.now() };
    this.entries.set(id, full);
    this.leafId = id;
    return full;
  }

  branch(entryId: string): void {
    if (!this.entries.has(entryId)) {
      throw new Error(`can't branch to unknown entry ${entryId}`);
    }
    this.leafId = entryId;
  }

  getLeaf(): Entry | null {
    return this.leafId ? this.entries.get(this.leafId) ?? null : null;
  }

  getEntry(id: string): Entry | null {
    return this.entries.get(id) ?? null;
  }

  /** Walk leaf → root, returning messages in order. */
  getBranchMessages(): Message[] {
    const path: Entry[] = [];
    let cur = this.getLeaf();
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? this.entries.get(cur.parentId) ?? null : null;
    }
    return path.flatMap((e) => e.messages);
  }

  all(): Entry[] {
    return [...this.entries.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  toJSON(sessionId: string): SerializedSession {
    const entries: SerializedEntry[] = this.all().map((e) => {
      const out: SerializedEntry = {
        id: e.id,
        parentId: e.parentId,
        timestamp: e.timestamp,
        messages: e.messages,
      };
      if (e.card) out.card = e.card;
      if (e.label !== undefined) out.label = e.label;
      if (e.usage !== undefined) out.usage = e.usage;
      return out;
    });
    const facts: Record<string, string> = {};
    for (const [k, v] of this.facts) facts[k] = v;
    return {
      version: AUGUR_SESSION_FORMAT_VERSION,
      sessionId,
      savedAt: new Date().toISOString(),
      leafId: this.leafId,
      entries,
      facts,
      vows: [...this.vows],
    };
  }

  static fromJSON(data: SerializedSession): SessionTree {
    if (data.version !== AUGUR_SESSION_FORMAT_VERSION) {
      throw new Error(
        `unsupported session format version ${data.version}; expected ${AUGUR_SESSION_FORMAT_VERSION}`,
      );
    }
    const tree = new SessionTree();
    let maxN = 0;
    for (const se of data.entries) {
      const entry: Entry = {
        id: se.id,
        parentId: se.parentId,
        timestamp: se.timestamp,
        messages: se.messages,
        ...(se.card ? { card: se.card } : {}),
        ...(se.label !== undefined ? { label: se.label } : {}),
        ...(se.usage !== undefined ? { usage: se.usage } : {}),
      };
      tree.entries.set(entry.id, entry);
      const m = /^e(\d+)$/.exec(entry.id);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      }
    }
    tree.nextId = maxN + 1;
    tree.leafId = data.leafId;
    for (const [k, v] of Object.entries(data.facts)) tree.facts.set(k, v);
    tree.vows = [...data.vows];
    return tree;
  }
}
