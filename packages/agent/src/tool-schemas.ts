/**
 * TypeBox parameter schemas for every narrator-callable tool.
 *
 * Why TypeBox and not ajv (which pi-ai ships): ajv uses `new Function()` to
 * compile validators, which is blocked by Cloudflare Workers' CSP. In that
 * runtime ajv silently no-ops and passes junk through. We validate at our
 * own tool boundary with `Value.Check` to guarantee the model can't drive
 * us into bad state.
 */

import { Type, type Static } from "@sinclair/typebox";

export const BindFactSchema = Type.Object(
  {
    key: Type.String({
      description:
        "Short stable identifier (e.g., 'door', 'candle', 'lantern', 'strangers-hand').",
    }),
    value: Type.String({
      description:
        "The fact in present tense (e.g., 'bolted from the inside; no one may enter or leave').",
    }),
  },
  { additionalProperties: false },
);
export type BindFactParams = Static<typeof BindFactSchema>;

export const AddVowSchema = Type.Object(
  {
    text: Type.String({
      description:
        "The full vow as an inviolable rule, written for the narrator to read before each turn (e.g., 'The Claw has vowed never again to speak the Stranger's true name aloud in this scene...').",
    }),
  },
  { additionalProperties: false },
);
export type AddVowParams = Static<typeof AddVowSchema>;

export const RecallMemorySchema = Type.Object(
  {
    entryLabel: Type.String({
      description:
        "Label of a prior entry (e.g., 'named-true', 'vow-spoken', 'door-bolted'). If no matching entry exists, an empty result is returned.",
    }),
  },
  { additionalProperties: false },
);
export type RecallMemoryParams = Static<typeof RecallMemorySchema>;

export const CheckNameSchema = Type.Object(
  {
    name: Type.String({
      description: "The exact name spoken aloud by the Claw this turn.",
    }),
  },
  { additionalProperties: false },
);
export type CheckNameParams = Static<typeof CheckNameSchema>;

export const BranchTimeSchema = Type.Object(
  {
    turns: Type.Integer({
      minimum: 1,
      maximum: 4,
      description: "How many turns to rewind from the current leaf.",
    }),
    moodBias: Type.String({
      description:
        "How the re-rendered moment should feel (e.g., 'tender, forgiving, soft-lit by candlelight').",
    }),
  },
  { additionalProperties: false },
);
export type BranchTimeParams = Static<typeof BranchTimeSchema>;
