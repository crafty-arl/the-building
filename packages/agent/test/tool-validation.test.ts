/**
 * Validation smoke test — proves each tool's TypeBox schema rejects junk at
 * the execute() boundary. Ajv is a no-op in Workers (CSP blocks new Function);
 * this test guarantees our own validator catches what ajv would have missed.
 *
 * Run with: node --test --experimental-strip-types test/tool-validation.test.ts
 * Or via tsx: npx tsx --test test/tool-validation.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  addVowTool,
  bindFactTool,
  branchTimeTool,
  checkNameTool,
  recallMemoryTool,
  SessionTree,
  type ToolCtx,
} from "../src/index.ts";

function ctx(): ToolCtx {
  return { tree: new SessionTree(), strangerTrueName: "Adrik" };
}

async function expectThrow<T>(fn: () => Promise<T>, match: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.match((err as Error).message, match);
    return;
  }
  assert.fail("expected tool to throw on invalid args");
}

test("bindFact rejects missing key", async () => {
  const tool = bindFactTool(ctx());
  await expectThrow(
    () => tool.execute("call-1", { value: "bolted" } as unknown as { key: string; value: string }),
    /bindFact args invalid/i,
  );
});

test("bindFact rejects non-string value", async () => {
  const tool = bindFactTool(ctx());
  await expectThrow(
    () => tool.execute("call-2", { key: "door", value: 42 } as unknown as { key: string; value: string }),
    /bindFact args invalid/i,
  );
});

test("bindFact accepts valid args and mutates tree", async () => {
  const c = ctx();
  const tool = bindFactTool(c);
  await tool.execute("call-3", { key: "door", value: "bolted" });
  assert.equal(c.tree.getFacts().get("door"), "bolted");
});

test("addVow rejects empty text", async () => {
  const tool = addVowTool(ctx());
  await expectThrow(() => tool.execute("call-4", { text: "   " }), /non-empty text/);
});

test("addVow rejects extra properties", async () => {
  const tool = addVowTool(ctx());
  await expectThrow(
    () =>
      tool.execute("call-5", { text: "ok", bogus: 1 } as unknown as { text: string }),
    /addVow args invalid/i,
  );
});

test("recallMemory rejects missing entryLabel", async () => {
  const tool = recallMemoryTool(ctx());
  await expectThrow(
    () => tool.execute("call-6", {} as unknown as { entryLabel: string }),
    /recallMemory args invalid/i,
  );
});

test("checkName rejects non-string name", async () => {
  const tool = checkNameTool(ctx());
  await expectThrow(
    () => tool.execute("call-7", { name: null } as unknown as { name: string }),
    /checkName args invalid/i,
  );
});

test("branchTime rejects turns below 1", async () => {
  const tool = branchTimeTool(ctx());
  await expectThrow(
    () => tool.execute("call-8", { turns: 0, moodBias: "soft" }),
    /branchTime args invalid/i,
  );
});

test("branchTime rejects turns above 4", async () => {
  const tool = branchTimeTool(ctx());
  await expectThrow(
    () => tool.execute("call-9", { turns: 99, moodBias: "soft" }),
    /branchTime args invalid/i,
  );
});
