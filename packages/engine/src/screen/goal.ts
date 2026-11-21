import type { JudgeAnswer, JudgeQuestion } from "../judge";
import {
  describeElement,
  type ScreenElement,
  type ScreenObservation,
  screenDigest,
  screenOverview,
} from "./observation";
import type { PlanDeps, ScreenAction, ScreenStep, StepReport } from "./plan";
import { CONTROLS, COSTLY, costlyOf, fits, MAX_OPTIONS, PICK_AT } from "./targets";

/**
 * A goal (ADR 9006): a short task on one screen done in a loop of small decisions, so the agent's own model
 * isn't asked at every click. Each round is one judge request over the screen's elements: the operation, the
 * target for each operation that could apply, which of the agent's `values` to use and whether the goal is
 * reached. Text typed comes only from `values`; no model writes any. The loop stops at anything it isn't sure
 * of, and before anything that can't be undone, and hands the screen back to the agent.
 */

export const DEFAULT_GOAL_STEPS = 12;
export const MAX_GOAL_STEPS = 25;
/** The goal is reached only when the judge is this sure. */
const REACHED_AT = 0.6;
const MAX_VALUES = 20;
const MAX_VALUE_NAME = 64;
const MAX_VALUE_TEXT = 2000;
const SCROLL_PIXELS = 600;
const WAIT_MS = 1500;

/** The schema fields of a `goal` step, shared by `browser_do` and `desktop_do`. */
export const GOAL_STEP_PROPERTIES = {
  goal: {
    type: "string",
    description:
      "`goal`: a short task on this screen in words (`log in with the saved email`, `fill the form and submit`). It acts until it is done, stops when unsure, and stops before anything that can't be undone.",
    maxLength: 500,
  },
  values: {
    type: "object",
    description:
      '`goal`: the texts it may type or choose, by name (`{ "email": "ana@example.com" }`). It types nothing else. Never passwords: use `type_secret` steps for them.',
    additionalProperties: { type: "string", maxLength: MAX_VALUE_TEXT },
  },
  steps: {
    type: "integer",
    minimum: 1,
    maximum: MAX_GOAL_STEPS,
    description: `\`goal\`: at most this many actions (default ${DEFAULT_GOAL_STEPS}).`,
  },
} as const;

/** `values` from a model's input: only text to text, a few, of a sane length. */
export function goalValuesOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(v)) {
    const name = k.trim();
    if (typeof t !== "string" || !name || name.length > MAX_VALUE_NAME || name === "none") continue;
    if (Object.keys(out).length >= MAX_VALUES) break;
    out[name] = t.slice(0, MAX_VALUE_TEXT);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const goalLimit = (step: ScreenStep) =>
  Math.min(MAX_GOAL_STEPS, Math.max(1, Math.round(step.steps ?? DEFAULT_GOAL_STEPS) || DEFAULT_GOAL_STEPS));

export interface GoalResult {
  /** Every action taken, as a step of the plan's report. */
  actions: StepReport[];
  /** The screen at the end (null when it was never seen). */
  screen: ScreenObservation | null;
  /** Why it stopped before the goal was reached; absent when it was. */
  stop?: { reason: string; candidates?: ScreenElement[] };
}

type Operation = "click" | "type" | "select" | "scroll_down" | "scroll_up" | "wait" | "done" | "blocked";

const OPERATIONS: Record<Operation, string> = {
  click: "Click the element chosen in `click_target`.",
  type: "Type one of `values` into the field chosen in `type_target`.",
  select: "Choose one of `values` in the list chosen in `select_target`.",
  scroll_down: "Scroll down: what the goal needs isn't in view.",
  scroll_up: "Scroll up: what the goal needs isn't in view.",
  wait: "Wait: the screen is still loading or changing.",
  done: "Nothing is left to do: the goal is reached.",
  blocked:
    "The goal can't be done from here (an error, a missing permission, something that must be done by a person).",
};

const noneOption = "None of these elements fits.";

const elementsQuestion = (what: string, elements: ScreenElement[]): JudgeQuestion => {
  const criteria: Record<string, string> = {};
  for (const e of elements) criteria[e.ref] = describeElement(e);
  criteria.none = noneOption;
  return {
    type: "choice",
    instructions: `An agent is working on \`goal\` on \`screen\`. If the next action is to ${what}, which element does it act on? Judge by what each element is, its name and where it sits.`,
    criteria,
  };
};

const pickOf = (a: JudgeAnswer | undefined) => {
  const choice = a?.choice;
  return { choice, p: choice ? (a?.probabilities?.[choice] ?? 0) : 0 };
};

/** The three most likely elements of one choice, for the agent to pick from by number. */
const topOf = (a: JudgeAnswer | undefined, elements: ScreenElement[]) =>
  elements
    .map((e) => ({ e, p: a?.probabilities?.[e.ref] ?? 0 }))
    .filter((r) => r.p > 0.02)
    .sort((x, y) => y.p - x.p)
    .slice(0, 3)
    .map((r) => r.e);

const quoted = (e: Pick<ScreenElement, "role" | "ref">) => `${e.role} (${e.ref})`;
const capped = (list: ScreenElement[]) => list.slice(0, MAX_OPTIONS);

class GoalStop extends Error {
  constructor(
    readonly reason: string,
    readonly candidates?: ScreenElement[],
  ) {
    super(reason);
  }
}

/** Runs `step` (a `goal`) on `deps.surface`; see the file's comment. */
export async function runGoal(deps: PlanDeps, step: ScreenStep): Promise<GoalResult> {
  const now = deps.now ?? Date.now;
  const goal = step.goal?.trim();
  const values = step.values ?? {};
  const names = Object.keys(values);
  const limit = goalLimit(step);
  const actions: StepReport[] = [];
  const costly = new Map<string, boolean>();
  const did: string[] = [];
  let screen: ScreenObservation | null = deps.last ?? null;
  let unchanged: string | null = null;

  const stop = (reason: string, candidates?: ScreenElement[]): GoalResult => ({
    actions,
    screen,
    stop: { reason, ...(candidates && candidates.length > 0 ? { candidates } : {}) },
  });

  async function ask(kind: string, state: Record<string, unknown>, questions: Record<string, JudgeQuestion>) {
    try {
      return await deps.judge.ask({
        orgId: deps.orgId,
        agentId: deps.agentId,
        runId: deps.runId,
        kind,
        // Acted on by probabilities: only a calibrated judge answers (as for targets).
        calibrated: true,
        state,
        questions,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new GoalStop(`couldn't decide the next action (${why.slice(0, 200)}): go on with normal steps`);
    }
  }

  /** Whether acting on `e` can't be undone: asked once per element in this goal; no answer is a yes. */
  async function isCostly(e: ScreenElement, o: ScreenObservation, op: Operation) {
    const key = `${e.ref}:${describeElement(e)}`;
    const known = costly.get(key);
    if (known !== undefined) return known;
    const answers = await ask(
      "screen_goal_costly",
      {
        target: describeElement(e),
        action: op,
        screen: { address: o.url, elements: `${e.ref}: ${describeElement(e)}` },
      },
      { costly: COSTLY },
    );
    const yes = costlyOf(answers);
    costly.set(key, yes);
    return yes;
  }

  async function act(action: ScreenAction, settle: boolean) {
    const out = await deps.surface.perform(action, { settle });
    if (!out.ok) throw new GoalStop(out.error);
    screen = out.observation ?? (await deps.surface.observe().catch(() => screen));
  }

  try {
    if (!goal) throw new GoalStop("say the goal (`goal`)");
    for (let n = 0; n < limit; n++) {
      if (deps.signal?.aborted) throw new GoalStop("stopped");
      const held = await deps.hold?.();
      if (held) throw new GoalStop(held);
      const o: ScreenObservation = n === 0 && screen ? screen : await deps.surface.observe();
      screen = o;
      const t0 = now();

      const controls = o.elements.filter((e) => CONTROLS.has(e.role));
      const clicks = capped(controls.length > 0 ? controls : o.elements.filter((e) => fits("click", e)));
      const fields = capped(o.elements.filter((e) => fits("fill", e)));
      const selects = capped(o.elements.filter((e) => fits("select", e)));
      const ops = (Object.keys(OPERATIONS) as Operation[]).filter(
        (op) =>
          (op !== "click" || clicks.length > 0) &&
          (op !== "type" || (fields.length > 0 && names.length > 0)) &&
          (op !== "select" || (selects.length > 0 && names.length > 0)),
      );
      const operationCriteria: Record<string, string> = {};
      for (const op of ops) operationCriteria[op] = OPERATIONS[op];

      const questions: Record<string, JudgeQuestion> = {
        operation: {
          type: "choice",
          instructions:
            "An agent wants `goal` done on `screen`, in small steps. `done` lists what it did already in this goal. Which operation comes next?",
          criteria: operationCriteria,
        },
        reached: {
          type: "noul",
          instructions: "Is `goal` already done on `screen`, with nothing left to do?",
          criteria: {
            true: "The screen shows the goal done (a confirmation, the state it asked for).",
            false: "Something of the goal is left to do, or the screen doesn't show it done.",
          },
        },
      };
      if (clicks.length > 0) questions.click_target = elementsQuestion("click something", clicks);
      if (names.length > 0 && fields.length > 0) questions.type_target = elementsQuestion("type into a field", fields);
      if (names.length > 0 && selects.length > 0) {
        questions.select_target = elementsQuestion("choose an option in a list", selects);
      }
      if (names.length > 0) {
        const criteria: Record<string, string> = {};
        for (const k of names) criteria[k] = `The value named ${JSON.stringify(k)}.`;
        criteria.none = "None of the values fits.";
        questions.value = {
          type: "choice",
          instructions:
            "If the next action types or chooses one of `values`, which one? Judge by what the field or option asks for.",
          criteria,
        };
      }

      const answers = await ask(
        "screen_goal",
        {
          goal,
          screen: { address: o.url, overview: screenOverview(o).text },
          values: Object.fromEntries(names.map((k) => [k, (values[k] as string).slice(0, 120)])),
          done: did,
        },
        questions,
      );

      const { choice, p } = pickOf(answers.operation);
      const op = ops.find((x) => x === choice);
      if (!op || p < PICK_AT) throw new GoalStop("couldn't tell what to do next on this screen");
      if (op === "blocked") throw new GoalStop("the goal can't be done from here");
      if (op === "done") {
        if ((answers.reached?.noul ?? 0) < REACHED_AT) {
          throw new GoalStop("it looked done but the screen doesn't clearly show the goal reached");
        }
        return { actions, screen };
      }

      let action: ScreenAction;
      let acted: ScreenElement | null = null;
      let report: Pick<StepReport, "step" | "note" | "element">;
      if (op === "scroll_down" || op === "scroll_up") {
        const direction = op === "scroll_down" ? "down" : "up";
        action = { kind: "scroll", direction, pixels: SCROLL_PIXELS };
        report = { step: { do: "scroll", direction } };
      } else if (op === "wait") {
        action = { kind: "pause", ms: WAIT_MS };
        report = { step: { do: "wait" } };
      } else {
        const pool = op === "click" ? clicks : op === "type" ? fields : selects;
        const head = answers[`${op}_target`];
        const target = pickOf(head);
        const el = pool.find((e) => e.ref === target.choice);
        if (!el || target.p < PICK_AT) {
          throw new GoalStop("couldn't tell which element to use", topOf(head, pool));
        }
        acted = el;
        let text = "";
        if (op !== "click") {
          const value = pickOf(answers.value);
          if (!value.choice || value.choice === "none" || !(value.choice in values) || value.p < PICK_AT) {
            throw new GoalStop("couldn't tell which of the values to use", topOf(head, pool));
          }
          text = values[value.choice] as string;
        }
        if (op !== "type" && (await isCostly(el, o, op))) {
          throw new GoalStop(
            `stopped before ${op === "click" ? "clicking" : "choosing in"} ${quoted(el)}: it may do something that can't be undone, so nothing was done there. If you mean it, do it with a normal step`,
            [el],
          );
        }
        action =
          op === "click"
            ? { kind: "click", at: { ref: el.ref } }
            : op === "type"
              ? { kind: "fill", at: { ref: el.ref }, text }
              : { kind: "select", at: { ref: el.ref }, value: text };
        const verb = op === "click" ? "click" : op === "type" ? "fill" : "select";
        report = {
          step: { do: verb, target: el.ref },
          note: quoted(el),
          element: { ref: el.ref, role: el.role, name: el.name },
        };
      }

      const before = screenDigest(o);
      await act(action, op !== "wait");
      actions.push({
        ...report,
        status: "done",
        ran: true,
        ...(report.element ? { via: "judge" as const } : {}),
        ms: now() - t0,
      });
      did.push(acted ? `${report.step.do} ${describeElement(acted)}` : report.step.do);
      if (op === "wait") continue;
      // The same action twice and the screen didn't move: going on would repeat it for ever.
      if (screen && screenDigest(screen) === before) {
        const key = `${op}:${report.step.target ?? ""}:${action.kind === "fill" ? action.text : ""}`;
        if (unchanged === key) throw new GoalStop("the same action changed nothing twice");
        unchanged = key;
      } else unchanged = null;
    }
    throw new GoalStop(`${limit} actions weren't enough to reach the goal`);
  } catch (error) {
    if (error instanceof GoalStop) return stop(error.reason, error.candidates);
    throw error;
  }
}
