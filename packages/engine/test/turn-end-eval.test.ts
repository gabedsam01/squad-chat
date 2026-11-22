import { expect, test } from "bun:test";
import { TURN_END_CASES, type TurnEndCase, turnEndOf } from "../eval/turn-end-cases";
import type { Judge } from "../src/judge";

// The turn-end eval's cases and harness, with a fake judge (no network). The eval itself is manual:
// `bun run eval:turn-end`.

const byId = (id: string) => TURN_END_CASES.find((c) => c.id === id) as TurnEndCase;
const judgeSaying = (choice: string): Judge => ({
  name: "fake",
  ask: async () => ({ verdict: { choice, probabilities: { [choice]: 0.9 } } }),
});

test("every case is well formed, and both kinds are there", () => {
  expect(new Set(TURN_END_CASES.map((c) => c.id)).size).toBe(TURN_END_CASES.length);
  expect(TURN_END_CASES.some((c) => c.want === "answered")).toBe(true);
  expect(TURN_END_CASES.some((c) => c.want === "nudged")).toBe(true);
});

test("the harness reads the controller's decision: a done verdict answers, a give-up or a promise is sent on", async () => {
  expect(await turnEndOf(judgeSaying("done"), byId("greeting-back"))).toEqual({ got: "answered", rule: "judged" });
  expect(await turnEndOf(judgeSaying("continue"), byId("promise-nothing-done"))).toEqual({
    got: "nudged",
    rule: "promise",
  });
  expect(await turnEndOf(judgeSaying("untried"), byId("one-empty-search"))).toEqual({ got: "nudged", rule: "untried" });
});
