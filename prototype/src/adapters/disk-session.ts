/**
 * Node-only disk adapter for SessionTree save/load. Lives here (not in
 * `@augur/agent`) so the shared package stays free of `node:*` deps.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionTree, type SerializedSession } from "@augur/agent";

export function saveSessionToDisk(
  tree: SessionTree,
  sessionId: string,
  absPath: string,
): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(tree.toJSON(sessionId), null, 2));
}

export function loadSessionFromDisk(absPath: string): {
  tree: SessionTree;
  data: SerializedSession;
} {
  const raw = readFileSync(absPath, "utf-8");
  const data = JSON.parse(raw) as SerializedSession;
  return { tree: SessionTree.fromJSON(data), data };
}
