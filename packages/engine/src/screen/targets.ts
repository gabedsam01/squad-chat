import { randomUUID } from "node:crypto";
import type { ScreenKind } from "@agenteschat/adapters";
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge";
import { openImage } from "./crop";
import {
  describeElement,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  type ScreenRegion,
  screenRef,
} from "./observation";

/**
 * Targets in words (ADR 0054): the agent says "the Sign in button" instead of
 * reading the screen and copying a number. Code finds it, cheapest first:
 *
 * 1. a ref (`e12`) as given;
 * 2. one element whose name is exactly the words (no judge);
 * 3. what the same words found on this site before (the target cache);
 * 4. the judge picks among the screen's elements (a Choice over refs, plus
 *    whether it's there at all);
 * 5. on an image of the screen, when the text has nothing that fits (`locate`).
 *
 * The judge only points at something already on the screen; it never decides
 * whether the agent may act.
 */

/** What an action needs its target to be: only fitting elements are offered. */
export type TargetUse = "click" | "fill" | "select" | "check" | "type_secret" | "upload" | "hover" | "window";

const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);
const ROLES: Partial<Record<TargetUse, ReadonlySet<string>>> = {
  fill: FIELDS,
  type_secret: new Set(["textbox"]),
  select: new Set(["combobox", "listbox"]),
  check: new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]),
};
/** Controls, as opposed to text with a ref (a heading "Sign in" next to the button "Sign in"). */
export const CONTROLS = new Set([
  ...FIELDS,
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "listbox",
  "slider",
  "treeitem",
]);

export type TargetFound = {
  found: true;
  ref: string;
  element: ScreenElement | null;
  via: "ref" | "exact" | "cache" | "judge";
  confidence: number;
};
export type TargetMissing = {
  found: false;
  /** `unsure`: several fit; `absent`: nothing on the screen fits; `unjudged`: no calibrated judge answered. */
  reason: "unsure" | "absent" | "unjudged";
  candidates: ScreenElement[];
};
export type TargetResult = TargetFound | TargetMissing;

/** What a target's words found on a site, to find it again without the judge. */
export interface TargetMemory {
  role: string;
  name: string;
  /** Where it sat (its named containers): it is found again only there ("Delete" in the row for invoice 42). */
  context: string[];
  /** The judge found it can't be undone: it is never taken from memory. */
  costly?: boolean;
}

/** In-process memory of targets per agent and site (LRU). */
export interface TargetCache {
  get(key: string): TargetMemory | undefined;
  set(key: string, value: TargetMemory): void;
}

export function createTargetCache(max = 2000): TargetCache {
  const map = new Map<string, TargetMemory>();
  return {
    get(key) {
      const v = map.get(key);
      if (v) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

/** Words as targets and names are compared: lowercase, no accents or quotes, single spaces. */
export const normalizeWords = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/["'`“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The page a target belongs to, with ids in the path generalized (`/orders/:id`). */
export function pageKey(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((p) => (/^\d+$|^[0-9a-f-]{8,}$|^[A-Za-z0-9_-]{20,}$/i.test(p) ? ":id" : p))
      .join("/");
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 200);
  }
}

export const targetKey = (scope: string, url: string | null, use: TargetUse, words: string) =>
  `${scope}|${pageKey(url)}|${use}|${normalizeWords(words)}`;

const WINDOWS = new Set(["window", "dialog", "alertdialog"]);
/**
 * A panel's button for a window (`button "Files - Thunar" [window, ref=e3]`): read from the attributes
 * right after the quoted name, so a name with "[window]" in it can't pass for one.
 */
const WINDOW_BUTTON = /^-\s+button(?:\s+"(?:[^"\\]|\\.)*")?\s*\[(?:[^\]]*?,\s*)?window\s*[,\]]/;

export const fits = (use: TargetUse, e: ScreenElement) =>
  use === "window" ? WINDOWS.has(e.role) || WINDOW_BUTTON.test(e.line) : (ROLES[use]?.has(e.role) ?? true);

/** The elements an action may target, best guesses first when there are too many for one question. */
function candidatesFor(words: string, use: TargetUse, o: ScreenObservation, max: number): ScreenElement[] {
  const fitting = o.elements.filter((e) => fits(use, e));
  // Only a window is brought to the front: with none on the screen, nothing else stands in.
  const pool = fitting.length > 0 || use === "window" ? fitting : o.elements;
  if (pool.length <= max) return pool;
  const terms = normalizeWords(words)
    .split(" ")
    .filter((t) => t.length > 1);
  const scored = pool.map((e) => {
    const text = normalizeWords(`${e.role} ${e.name} ${e.context.join(" ")}`);
    return { e, score: terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.e.index - b.e.index)
    .slice(0, max)
    .map((s) => s.e)
    .sort((a, b) => a.index - b.index);
}

/** The one element with exactly these words as its name (and a fitting role), if there is exactly one. */
function exactMatch(words: string, use: TargetUse, o: ScreenObservation): ScreenElement | null {
  const w = normalizeWords(words.replace(/^(the|o|a|os|as)\s+/i, ""));
  if (!w) return null;
  const same = o.elements.filter((e) => fits(use, e) && normalizeWords(e.name) === w);
  if (same.length === 1) return same[0] as ScreenElement;
  // The same name on a heading and a button: the button is what one acts on.
  const controls = same.filter((e) => CONTROLS.has(e.role));
  if (controls.length === 1) return controls[0] as ScreenElement;
  // `button "Save"` written out.
  const m = /^([a-z]+)\s+"(.+)"$/i.exec(words.trim());
  if (m) {
    const role = (m[1] as string).toLowerCase();
    const name = normalizeWords(m[2] as string);
    const hits = o.elements.filter((e) => e.role.toLowerCase() === role && normalizeWords(e.name) === name);
    if (hits.length === 1) return hits[0] as ScreenElement;
  }
  return null;
}

/** The one element with the remembered role, name and place; none or several: the judge decides again. */
function fromMemory(memory: TargetMemory, o: ScreenObservation): ScreenElement | null {
  const place = memory.context.join(" › ");
  const same = o.elements.filter(
    (e) => e.role === memory.role && e.name === memory.name && e.context.join(" › ") === place,
  );
  return same.length === 1 ? (same[0] as ScreenElement) : null;
}

const memoryOf = (e: ScreenElement): TargetMemory => ({ role: e.role, name: e.name, context: e.context });

/** Most options one Choice offers (Jev takes 255, one is "none"). */
export const MAX_OPTIONS = 200;
/** The judge's pick is taken from this probability, this far ahead of the next one. */
export const PICK_AT = 0.55;
const PICK_MARGIN = 0.2;
/**
 * An element whose wrong pick costs (it pays, deletes, sends, throws work away): the judge must be this
 * sure, else the closest ones go back to the agent, which picks by number.
 */
export const COSTLY_PICK_AT = 0.85;
/**
 * Whether acting on the target can't be undone, asked of the judge with the pick: a screen in any language reads
 * the same. No answer is a yes.
 */
export const COSTLY: JudgeQuestion = {
  type: "noul",
  instructions:
    "Would acting on `target` pay, delete, send or do something else that can't be undone? A plain Yes or OK in a dialog that asks for such a thing does what the dialog asks.",
  criteria: {
    true: "It pays, buys, deletes, discards, empties, overwrites, replaces, sends, transfers, uninstalls, formats, cancels an account or a plan, closes without saving, or confirms one of these.",
    false: "It can be undone, or only opens, shows, selects or types something.",
  },
};
export const costlyOf = (answers: Record<string, JudgeAnswer>) => (answers.costly?.noul ?? 1) >= 0.5;
/** Below this, nothing on the screen is it. */
const ABSENT_BELOW = 0.3;

export interface ResolveInput {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  /** The ref or the words, as the agent gave them. */
  target: string;
  use: TargetUse;
  observation: ScreenObservation;
  cache?: TargetCache;
  /** Who the cache is for (the agent's browser): one agent's sites never steer another's. */
  scope: string;
}

/** Finds the element the agent means (see the file's comment for the order). */
export async function resolveTarget(input: ResolveInput): Promise<TargetResult> {
  const { observation: o } = input;
  const ref = screenRef(input.target);
  if (ref) {
    return {
      found: true,
      ref,
      element: o.elements.find((e) => e.ref === ref) ?? null,
      via: "ref",
      confidence: 1,
    };
  }
  const words = input.target.trim();
  const exact = exactMatch(words, input.use, o);
  if (exact) return { found: true, ref: exact.ref, element: exact, via: "exact", confidence: 1 };
  const key = targetKey(input.scope, o.url, input.use, words);
  const remembered = input.cache?.get(key);
  const again = remembered ? fromMemory(remembered, o) : null;
  // A costly one (delete, pay) is never taken from memory: its place is kept only in part (row text cut short).
  if (again && !remembered?.costly) return { found: true, ref: again.ref, element: again, via: "cache", confidence: 1 };

  const candidates = candidatesFor(words, input.use, o, MAX_OPTIONS);
  if (candidates.length === 0) return { found: false, reason: "absent", candidates: [] };
  const criteria: Record<string, string> = {};
  for (const e of candidates) criteria[e.ref] = describeElement(e);
  criteria.none = "None of these elements is it.";
  const questions: Record<string, JudgeQuestion> = {
    which: {
      type: "choice",
      instructions:
        "An agent is working on `screen` and wants to act on `target`. Which element is the one it means? Judge by what each element is, its name and where it sits.",
      criteria,
    },
    present: {
      type: "noul",
      instructions: "Is `target` one of the elements on `screen`?",
      criteria: {
        true: "One element on the screen is clearly what `target` describes.",
        false: "Nothing on the screen is what `target` describes, or it can't be told apart from others.",
      },
    },
    costly: COSTLY,
  };
  let answers: Record<string, JudgeAnswer>;
  try {
    answers = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_target",
      // The pick is taken on its probabilities (the margin, 0.85 for costly ones): only a calibrated
      // judge answers. The cheap model would say 1 to anything.
      calibrated: true,
      state: {
        target: words,
        action: input.use,
        screen: { address: o.url, elements: candidates.map((e) => `${e.ref}: ${describeElement(e)}`).join("\n") },
      },
      questions,
    });
  } catch {
    // No calibrated judge (or it failed): the closest by their words go back, and the agent picks by number.
    return { found: false, reason: "unjudged", candidates: closestByWords(words, candidates) };
  }
  return decide(answers, candidates, (picked, costly) => {
    input.cache?.set(key, { ...memoryOf(picked), costly });
  });
}

/**
 * The three elements that share the most words with the target: its name counts most, then its
 * role, then where it sits; a control comes before text with the same words.
 */
function closestByWords(words: string, candidates: ScreenElement[]): ScreenElement[] {
  const terms = normalizeWords(words)
    .split(" ")
    .filter((t) => t.length > 1);
  const hits = (text: string) => {
    const said = normalizeWords(text);
    return terms.filter((t) => said.includes(t)).length;
  };
  return candidates
    .map((e) => ({
      e,
      score: 2 * hits(e.name) + hits(e.role) + 0.5 * hits(e.context.join(" ")) + (CONTROLS.has(e.role) ? 0.5 : 0),
    }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score || a.e.index - b.e.index)
    .slice(0, 3)
    .map((s) => s.e);
}

function decide(
  answers: Record<string, JudgeAnswer>,
  candidates: ScreenElement[],
  remember: (e: ScreenElement, costly: boolean) => void,
): TargetResult {
  const which = answers.which;
  const probabilities = which?.probabilities ?? {};
  const present = answers.present?.noul ?? 0;
  const ranked = candidates
    .map((e) => ({ e, p: probabilities[e.ref] ?? 0 }))
    .filter((r) => r.p > 0.02)
    .sort((a, b) => b.p - a.p);
  const choice = which?.choice;
  const picked = choice && choice !== "none" ? candidates.find((e) => e.ref === choice) : undefined;
  const p = choice ? (probabilities[choice] ?? 0) : 0;
  // The pick must stand out: ahead of the next element (or of "none").
  const next = Math.max(
    ranked.find((r) => r.e.ref !== choice)?.p ?? 0,
    choice === "none" ? 0 : (probabilities.none ?? 0),
  );
  // Elements that read the same can't be told apart, whatever the judge says: the agent picks by number.
  const twins = picked ? candidates.filter((e) => e !== picked && describeElement(e) === describeElement(picked)) : [];
  if (picked && twins.length > 0) {
    return { found: false, reason: "unsure", candidates: [picked, ...twins].slice(0, 3) };
  }
  const costly = costlyOf(answers);
  if (picked && p >= (costly ? COSTLY_PICK_AT : PICK_AT) && p - next >= PICK_MARGIN && present >= ABSENT_BELOW) {
    remember(picked, costly);
    return { found: true, ref: picked.ref, element: picked, via: "judge", confidence: p };
  }
  const top = ranked.slice(0, 3).map((r) => r.e);
  if (present < ABSENT_BELOW || (choice === "none" && p >= PICK_AT)) {
    return { found: false, reason: "absent", candidates: top };
  }
  return { found: false, reason: "unsure", candidates: top };
}

/** Where a target is on an image of the screen (the surface's pixels), with the element there if marked. */
export type Located =
  | { found: true; x: number; y: number; ref: string | null; confidence: number }
  | {
      found: false;
      reason: string;
      /** It is there, but only as a spot on the image, and the judge found it can't be undone. */
      refused?: true;
    };

/** How the judge is asked about each kind of screen. */
// What `target` describes, never only "a control that does it": a field, a picture or a text is a target too.
const ON_IMAGE: Record<ScreenKind, { what: string; present: string; absent: string }> = {
  browser: {
    what: "`screenshot` is a web page. A control may be only an icon: a gear for settings, a trash can for delete, a pencil for edit, a magnifier for search, × for close.",
    present:
      "Does `screenshot` show what `target` describes (a control, a field, a picture or text; maybe only an icon)?",
    absent: "It isn't on the screenshot (hidden, scrolled away or not on this page).",
  },
  desktop: {
    what: "`screenshot` is a computer's desktop: windows, menus, a panel. A control may be only an icon: a gear for settings, a trash can for delete, a magnifier for search, x for close.",
    present:
      "Does `screenshot` show what `target` describes (a control, a field, a picture or text; maybe only an icon)?",
    absent: "It isn't on the screenshot.",
  },
};
/** The judge must say it's there at least this sure, in every round. */
const PRESENT_AT = 0.6;
/**
 * The decision model answers a choice over images but draws no box (ADR 9006), so a spot is found by
 * narrowing: a 3x3 grid of cells that overlap, so a control on a border is whole in one cell.
 */
const GRID = 3;
/** A cell side is this share of the region's: cells start every 30%, so each overlaps its neighbor by 10%. */
const CELL = 0.4;
/** The region is narrowed until both sides are this many screen pixels or fewer: a click at its center lands. */
const SPOT_PX = 40;
/** At most this many narrowing rounds (each nine requests at once): 1920x1080 ends near 49x28 px. */
const MAX_ROUNDS = 4;
/**
 * Each cell goes as its own picture, drawn to fit this size, so later rounds see a close-up enlarged: every
 * picture costs input tokens, but measured on a real desktop a judge reads no interface drawn smaller than it is.
 */
const CELL_PX = { width: 640, height: 400 };
/** The whole region beside its cells, at about its own size for the same reason. */
const WHOLE_PX = { width: 1280, height: 800 };

/** A cell the judge says yes to this surely holds the control's center (the spot is checked after). */
const CELL_AT = 0.5;
/** A cell this sure, and this far above the next, goes on past the first round though under `CELL_AT`. */
const CLEAR_AT = 0.3;
const CLEAR_MARGIN = 0.25;
/** A neighbor goes on with the surest cell when its yes is at most this much less sure. */
const JOIN_MARGIN = 0.25;
/** How far beside the aim the check also looks, in screen pixels: half a small control. */
const NUDGE_PX = 8;
/** A named mark picked this surely is taken without a check (every right pick of both models was, measured). */
const NAMED_AT = 0.75;
/** Spots this close are one spot: it is checked once. */
const SAME_PX = 4;
/** A cell this sure counts toward where to click, beside the surest one it touches. */
const AIM_AT = 0.25;
/** The close-up the spot is checked on, in screen pixels: room around a small control to tell it from its neighbors. */
const CHECK_PX = { width: 320, height: 200 };
/** What a picture of a cell is part of, by screen. */
const SCREEN_OF: Record<ScreenKind, string> = { browser: "a web page", desktop: "a computer's desktop" };
const touching = (a: ScreenRegion, b: ScreenRegion) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
const around = (a: ScreenRegion, b: ScreenRegion): ScreenRegion => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

/** The pick of a Choice: its key, and how sure the judge is of it. */
const pickOf = (a: JudgeAnswer | undefined) => {
  const choice = a?.choice;
  return { choice, p: choice ? (a?.probabilities?.[choice] ?? 0) : 0 };
};

/** The cells a region is split in, left to right and top to bottom, in screen pixels. */
export function narrowCells(region: ScreenRegion): ScreenRegion[] {
  const out: ScreenRegion[] = [];
  const stride = (1 - CELL) / (GRID - 1);
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      out.push({
        x: Math.round(region.x + c * stride * region.width),
        y: Math.round(region.y + r * stride * region.height),
        width: Math.round(CELL * region.width),
        height: Math.round(CELL * region.height),
      });
    }
  }
  return out;
}

/**
 * Looks for the target on an image of the screen, with `choice` questions only (ADR 9006).
 * With marks (an annotated screenshot) one question picks a marked element, so the action stays as
 * exact as a ref. Else, or when no mark fits, the screen is narrowed cell by cell (see `GRID`): each
 * round cuts the region into its 9 cells and asks of each, in its own request and all at once, whether
 * it holds the control's center. The next round cuts the chosen cell from a native
 * close-up through `zoom` when the surface gives one, else from the image we have, until the cell
 * is `SPOT_PX` or less. A target the judge finds can't be undone (delete, discard…) is
 * never taken at a bare spot.
 */
export async function locateOnImage(input: {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  target: string;
  image: ScreenImage;
  url?: string | null;
  /** Which screen the image shows (default the browser's page). */
  kind?: ScreenKind;
  /** A close-up of a region of the screen, at its native size, or null when it can't be taken. */
  zoom?: (region: ScreenRegion) => Promise<ScreenImage | null>;
}): Promise<Located> {
  const words = ON_IMAGE[input.kind ?? "browser"];
  const target = input.target.trim();
  // A page's address helps; a desktop's (`desktop://thunar/main`) made GPT say a browser on that screen had no
  // address bar: the screen holds more than the window in front (measured).
  const address = input.kind === "desktop" ? {} : { address: input.url ?? null };
  const ask = async (
    images: Record<string, { data: string; format: "jpeg" }>,
    state: Record<string, unknown>,
    which: JudgeQuestion,
    first: boolean,
  ) => {
    const answers: Record<string, JudgeAnswer> = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_locate",
      state: { ...state, ...address, target },
      images,
      // Whether it is there, and can't be undone, is asked once, on the whole screen.
      questions: {
        which,
        ...(first
          ? {
              present: {
                type: "noul",
                instructions: words.present,
                criteria: { true: "It is visible on the screenshot.", false: words.absent },
              },
              costly: COSTLY,
            }
          : {}),
      },
    });
    return {
      ...pickOf(answers.which),
      present: first ? (answers.present?.noul ?? 0) : 1,
      costly: first && costlyOf(answers),
    };
  };
  const fail = (error: unknown): Located => ({
    found: false,
    reason: error instanceof Error ? error.message : String(error),
  });

  // A spot is checked before it is given: a cross drawn on it in a close-up, and one yes/no on whether it sits on
  // what the target is. A cell's yes, or a mark's pick, says where it is; this says a click there lands on it.
  const check = async (img: ScreenImage, spot: { x: number; y: number }, area: { width: number; height: number }) => {
    const from = img.origin ?? { x: 0, y: 0 };
    const picture = await openImage(img.data);
    const kx = picture.width / img.viewport.width;
    const ky = picture.height / img.viewport.height;
    // Inside the image: a close-up past its edge came out stretched, and the check said no to a right spot in a
    // window's corner (measured).
    const width = Math.min(img.viewport.width, Math.max(CHECK_PX.width, area.width));
    const height = Math.min(img.viewport.height, Math.max(CHECK_PX.height, area.height));
    const within = (v: number, lo: number, size: number, most: number) =>
      Math.min(Math.max(lo, v - size / 2), lo + most - size);
    const near = {
      x: within(spot.x, from.x, width, img.viewport.width),
      y: within(spot.y, from.y, height, img.viewport.height),
      width,
      height,
    };
    // Enlarged up to twice: a small control reads better bigger (as the cells do).
    const fit = Math.min(2, CELL_PX.width / near.width, CELL_PX.height / near.height);
    const data = await picture.crop(
      { x: (near.x - from.x) * kx, y: (near.y - from.y) * ky, width: near.width * kx, height: near.height * ky },
      { width: Math.round(near.width * fit), height: Math.round(near.height * fit) },
      { cross: { x: (spot.x - from.x) * kx, y: (spot.y - from.y) * ky } },
    );
    const shot = `picture_${randomUUID()}`;
    const a = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_locate",
      state: { picture: shot, ...address, target },
      images: { [shot]: { data, format: "jpeg" } },
      questions: {
        on: {
          type: "noul",
          instructions: `\`picture\` is part of ${SCREEN_OF[input.kind ?? "browser"]}, with a red crosshair drawn on it: four arms around an empty middle. Is the point in that middle on what \`target\` describes, so a click there would reach it?`,
          criteria: {
            true: "The crosshair's middle is on it.",
            false: "The middle is beside it, or on something else.",
          },
        },
      },
    });
    return a.on?.noul ?? 0;
  };

  // Marks: one question over their numbers (the most a Choice takes, plus "none").
  const marks = (input.image.marks ?? []).slice(0, MAX_OPTIONS);
  let costly = true;
  // Asked once: beside the marks' choice, or else beside the cells' first round. Asked twice, GPT said once that a
  // target the marks' question had seen wasn't there (measured).
  let askedWhole = false;
  if (marks.length > 0) {
    const criteria: Record<string, string> = {};
    // Where each is, in the picture's pixels: a desktop's screenshot has no numbers drawn on it, and GPT took the
    // Edit menu for a search button known only by role and name (measured).
    const o = input.image.origin ?? { x: 0, y: 0 };
    for (const m of marks)
      criteria[m.ref] =
        `${m.number}: ${m.role}${m.name ? ` "${m.name}"` : ""}, its center at ${Math.round(m.box.x - o.x + m.box.width / 2)},${Math.round(m.box.y - o.y + m.box.height / 2)}`;
    criteria.none = "None of the listed elements is it.";
    try {
      const placeholder = `screen_${randomUUID()}`;
      const r = await ask(
        { [placeholder]: { data: input.image.data, format: "jpeg" } },
        { screenshot: placeholder },
        {
          type: "choice",
          instructions: `${words.what} The screen's elements are listed with their center, in pixels from the top left of the ${input.image.viewport.width}×${input.image.viewport.height} screenshot (on a web page each is also drawn with its number). Which one is what \`target\` describes?`,
          criteria,
        },
        true,
      );
      costly = r.costly;
      askedWhole = true;
      const m = r.choice && r.choice !== "none" ? marks.find((e) => e.ref === r.choice) : undefined;
      const spot = m && { x: Math.round(m.box.x + m.box.width / 2), y: Math.round(m.box.y + m.box.height / 2) };
      // A named mark picked surely is taken as it is, even when the same answer says the target isn't there: GPT
      // picked the Settings submenu at 0.99 and said 0.01 that it was on the screen, and the cross's check said no
      // to Gemini's right picks of menu items (measured).
      if (m && spot && m.name && r.p >= NAMED_AT) return { found: true, ...spot, ref: m.ref, confidence: r.p };
      if (r.present < PRESENT_AT) return { found: false, reason: "not on the screen" };
      // Any other pick is checked, and a no goes on to the cells: a mark without a name is picked by its looks
      // alone, a control the marks leave out (a window's title bar) went to one, and GPT took a terminal's panel
      // button for its text area at 0.62 (measured).
      if (m && spot && r.p >= PICK_AT) {
        const on = await check(input.image, spot, m.box);
        if (on >= PRESENT_AT) return { found: true, ...spot, ref: m.ref, confidence: Math.min(r.p, r.present, on) };
      }
    } catch (error) {
      return fail(error);
    }
  }

  // No mark fits: narrow the screen down. `region` is in screen pixels; `source` is the image the cells are cut from.
  const origin = input.image.origin ?? { x: 0, y: 0 };
  let region: ScreenRegion = { ...origin, ...input.image.viewport };
  let source = input.image;
  let confidence = 1;
  let aim: { x: number; y: number } | null = null;
  let last: { p: number; cell: ScreenRegion }[] = [];
  for (let round = 0; round < MAX_ROUNDS && (region.width > SPOT_PX || region.height > SPOT_PX); round++) {
    try {
      if (round > 0 && input.zoom) {
        // Only an image that says where it sits maps back; without one the cells are cut from the image we have.
        const taken = await input.zoom(region).catch(() => null);
        if (taken?.origin) source = taken;
      }
      const from = source.origin ?? { x: 0, y: 0 };
      const picture = await openImage(source.data);
      // Screen pixels to the image's own: it may be drawn at another size than what it shows.
      const kx = picture.width / source.viewport.width;
      const ky = picture.height / source.viewport.height;
      const inImage = (r: ScreenRegion) => ({
        x: (r.x - from.x) * kx,
        y: (r.y - from.y) * ky,
        width: r.width * kx,
        height: r.height * ky,
      });
      const cut = (r: ScreenRegion, most: { width: number; height: number }, box?: ScreenRegion) => {
        const fit = Math.min(most.width / r.width, most.height / r.height);
        return picture.crop(
          inImage(r),
          { width: Math.max(1, Math.round(r.width * fit)), height: Math.max(1, Math.round(r.height * fit)) },
          box ? { box: inImage(box) } : undefined,
        );
      };
      const cells = narrowCells(region);
      const asked = (
        images: Record<string, { data: string; format: "jpeg" }>,
        questions: Record<string, JudgeQuestion>,
      ) =>
        input.judge.ask({
          orgId: input.orgId,
          agentId: input.agentId,
          runId: input.runId,
          kind: "screen_locate",
          state: {
            ...Object.fromEntries(Object.keys(images).map((k) => [k.split("_")[0], k])),
            ...address,
            target,
          },
          images,
          questions,
        });
      // Whether it is there, and can't be undone, is asked once, on the whole screen.
      const whole =
        round === 0 && !askedWhole
          ? cut(region, WHOLE_PX).then(async (data) => {
              const a = await asked(
                { [`screenshot_${randomUUID()}`]: { data, format: "jpeg" } },
                {
                  present: {
                    type: "noul",
                    instructions: words.present,
                    criteria: { true: "It is visible on the screenshot.", false: words.absent },
                  },
                  costly: COSTLY,
                },
              );
              return { present: a.present?.noul ?? 0, costly: costlyOf(a) };
            })
          : null;
      // Its failure is the cells' failure too, read below: not one left unhandled while they are asked.
      whole?.catch(() => {});
      // One picture a request, all at once: measured on a real desktop, a judge told nine named pictures in one
      // request apart badly, and one picture at a time well (the center: a wide control is whole in no cell).
      // Each cell is a red rectangle on the whole region, not a crop of it: measured, a crop alone loses what is
      // around it, and past the first round the judge no longer told which control a close-up showed.
      const pictures = await Promise.all(cells.map((c) => cut(region, round === 0 ? WHOLE_PX : CELL_PX, c)));
      const holds = await Promise.all(
        pictures.map(async (data) => {
          const a = await asked(
            { [`picture_${randomUUID()}`]: { data, format: "jpeg" } },
            {
              holds: {
                type: "noul",
                instructions: `\`picture\` is ${round === 0 ? "" : "part of "}${SCREEN_OF[input.kind ?? "browser"]}, with a red rectangle drawn on it. Is the center of what \`target\` describes inside the red rectangle? It may be only an icon.`,
                criteria: {
                  true: "Its center is inside the red rectangle.",
                  false: "It is outside the rectangle, or only an edge of it is inside.",
                },
              },
            },
          );
          return a.holds?.noul ?? 0;
        }),
      );
      if (whole) {
        const w = await whole;
        costly = w.costly;
        if (w.present < PRESENT_AT) return { found: false, reason: "not on the screen" };
      }
      const ranked = holds.map((p, i) => ({ p, cell: cells[i] as ScreenRegion })).sort((x, y) => y.p - x.p);
      const best = ranked[0];
      // Past the first round a clear winner goes on below `CELL_AT` too: the spot is checked at the end anyway, and
      // a control at the screen's edge got 0.43 against 0.08 for every other cell (measured).
      const clear = round > 0 && !!best && best.p >= CLEAR_AT && best.p - (ranked[1]?.p ?? 0) >= CLEAR_MARGIN;
      if (!best || (best.p < CELL_AT && !clear)) {
        if (round === 0) return { found: false, reason: "unsure" };
        // Unsure only this close: the control may sit at an edge of the screen (measured: a window's close button
        // in its corner). The surest cells of this round go to the check beside the last aim.
        last = ranked;
        break;
      }
      last = ranked;
      // A control wider than a cell says yes in its neighbors too (measured): they go on together, when about as
      // sure as the surest (a far less sure yes beside it widened the region past a small dialog button).
      const next = ranked
        .filter((c) => c.p >= Math.max(CELL_AT, best.p - JOIN_MARGIN) && touching(c.cell, best.cell))
        .reduce((r, c) => around(r, c.cell), best.cell);
      confidence = Math.min(confidence, best.p);
      // Where to click is the cells' centers weighed by how sure each is: a small control where cells overlap sits
      // between them, not at the surest one's center (measured: 4 px off an 18-px button).
      const near = ranked.filter((c) => c.p >= AIM_AT && touching(c.cell, best.cell));
      const weight = near.reduce((n, c) => n + c.p, 0);
      aim = {
        x: Math.round(near.reduce((n, c) => n + c.p * (c.cell.x + c.cell.width / 2), 0) / weight),
        y: Math.round(near.reduce((n, c) => n + c.p * (c.cell.y + c.cell.height / 2), 0) / weight),
      };
      // No narrower than before: the control fills the region, and its center is where to check.
      if (next.width * next.height >= 0.9 * region.width * region.height) break;
      region = next;
    } catch (error) {
      return fail(error);
    }
  }
  const center = (r: ScreenRegion) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  const first = aim ?? center(region);
  // Around a spot too, half a small control away: a cell is only as exact as its size (measured: the aim fell
  // between a window's maximize and close buttons, 8 px left of the close one).
  const around4 = (p: { x: number; y: number }) =>
    [
      [NUDGE_PX, 0],
      [-NUDGE_PX, 0],
      [0, NUDGE_PX],
      [0, -NUDGE_PX],
    ].map(([dx, dy]) => ({ x: p.x + (dx as number), y: p.y + (dy as number) }));
  const checked: { x: number; y: number }[] = [];
  const fresh = (ps: { x: number; y: number }[]) =>
    ps.filter((p) => {
      const seen = checked.some((q) => Math.abs(q.x - p.x) <= SAME_PX && Math.abs(q.y - p.y) <= SAME_PX);
      if (!seen) checked.push(p);
      return !seen;
    });
  const best = { on: 0, spot: first };
  const checkAll = async (ps: { x: number; y: number }[]) => {
    const ons = await Promise.all(ps.map((p) => check(source, p, region)));
    ons.forEach((on, i) => {
      if (on > best.on) Object.assign(best, { on, spot: ps[i] });
    });
  };
  try {
    // The aim, the centers of the round's two surest cells and four spots beside the aim, at once; when none is a
    // yes, once more around the surest of them.
    await checkAll(fresh([first, ...last.slice(0, 2).map((c) => center(c.cell)), ...around4(first)]));
    if (best.on < PRESENT_AT) await checkAll(fresh(around4(best.spot)));
  } catch (error) {
    return fail(error);
  }
  if (best.on < PRESENT_AT) return { found: false, reason: "unsure" };
  const spot = best.spot;
  confidence = Math.min(confidence, best.on);
  // A spot is only as exact as a cell: something that can't be undone is done on an element, or not at all.
  if (costly) return { found: false, reason: "only a spot on the image", refused: true };
  return { found: true, ...spot, ref: null, confidence };
}
