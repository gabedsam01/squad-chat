import { dark, light } from "@agenteschat/tokens";
import { ditherCells, mixHex } from "@agenteschat/ui/agent/engine";
import { markPart } from "@agenteschat/ui/brand/squad-mark";
import { bayerAt } from "@agenteschat/ui/sky/math";

/**
 * The launch splash: pure pieces the screen and the tests share. No React
 * Native imports. Times in seconds.
 */
export const LAUNCH = {
  /** The shortest it plays before it may leave, once its rise is under way: the sky nearly up and the name in. */
  min: 0.6,
  /**
   * Ready this soon (its first frames: the session and the workspace kept from last time), it leaves at once, with no
   * minimum to sit through: its rise had barely begun.
   */
  quick: 0.15,
  /** The sky rising and the agent lifting with it. */
  rise: 0.85,
  /** Leaving with reduced motion: a short fade. */
  reducedExit: 0.25,
  /** When the name comes in, and how long it takes: in before the shortest launch leaves. */
  nameAt: 0.2,
  nameIn: 0.3,
  /** How long it waits before one line says why it is still here. */
  lineAfter: 2.5,
  /** How high the sky rises (share of the screen's height). */
  sky: 0.5,
  /** How far the agent lifts with it (points). */
  lift: 26,
  /** Waiting on something the person can act on (a server that doesn't answer): the agent's height, as a share of the screen. */
  waitingAgent: 0.3,
  /** And the sky's level then (its top just under the name). */
  waitingSky: 0.56,
} as const;

/** The native launch image (assets/images/splash-icon.png, 512 px with the body at 56–456) is 120 pt wide. */
export const NATIVE_IMAGE = 120;
/** So the mark's 32 grid there is this wide, centered on the screen: the splash starts exactly on it. */
export const LOGO = (NATIVE_IMAGE * 400) / 512;
/**
 * The mark's bubble, dots and square, in the theme's ink, ground and agent colors (the native image's, drawn by
 * packages/ui/scripts/app-icons.mjs): never the workspace's accent, which the native image can't know.
 */
export const launchMarkColors = (isDark: boolean): [bubble: string, dot: string, square: string] => {
  const t = isDark ? dark : light;
  return [t.ink, t.bg, t.agent];
};
const MARK_TONE = { bubble: 0, dot: 1, square: 2 } as const;

/**
 * Leaving into the app (motion on): the mark holds a moment (`gather`), then comes apart into its own pixels while a
 * ring of pixel sky goes out from it to past every corner (`wave`). Outside the ring the splash is still there, inside
 * it the app, already drawn under the splash, settling from a little larger. All on the UI thread; times in seconds
 * from the moment it leaves.
 */
export const EXIT = {
  gather: 0.08,
  wave: 0.5,
  /** The ring's band of pixel sky, in points. */
  band: 72,
  /** The app's scale as the ring starts opening it. */
  appFrom: 1.03,
  /** How long the agent's pixels take to go, from the moment the ring starts. */
  burst: 0.26,
} as const;

/** From leaving until the app alone shows. */
export const EXIT_TOTAL = EXIT.gather + EXIT.wave;

const clamp01 = (x: number) => {
  "worklet";
  return x < 0 ? 0 : x > 1 ? 1 : x;
};
const smooth01 = (x: number) => {
  "worklet";
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** cubic-bezier(0.65, 0, 0.35, 1): the ring starts gently and arrives gently. */
const inOutCubic = (x: number) => {
  "worklet";
  const k = clamp01(x);
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
};
/** cubic-bezier(0.22, 1, 0.36, 1): fast out, long settle. */
const outQuint = (x: number) => {
  "worklet";
  return 1 - (1 - clamp01(x)) ** 5;
};

/** How far the gather is (0 → 1, smoothed) `e` seconds after leaving. */
export function gatherOf(e: number): number {
  "worklet";
  return smooth01(e / EXIT.gather);
}

/**
 * The ring's outer edge (points from the agent's center) `e` seconds after leaving: from just outside the agent's
 * body to past the farthest corner of a `width` × `height` screen, the agent standing at `cy`. 0 while it gathers.
 */
export function ringRadius(e: number, cy: number, width: number, height: number): number {
  "worklet";
  const k = e - EXIT.gather;
  if (k < 0) return 0;
  const far = Math.hypot(width / 2, Math.max(cy, height - cy)) + EXIT.band + 12;
  const from = LOGO * 0.55;
  return from + (far - from) * inOutCubic(k / EXIT.wave);
}

/**
 * What a cell `d` points from the agent's center shows with the ring's edge at `r` (`b`: the cell's Bayer threshold),
 * as the shader decides (./ring.ts): "splash" (outside the ring, or the band's palest step), "app" (inside it, or
 * dithered through on the band's inner half), or the band's tone (1 to 3).
 */
export function ringCell(d: number, r: number, b: number): "splash" | "app" | 1 | 2 | 3 {
  if (d > r) return "splash";
  const k = (r - d) / EXIT.band;
  if (k >= 1 || (k > 0.5 && b < (k - 0.5) / 0.5)) return "app";
  const f = 3 * (1 - Math.abs(2 * k - 1));
  const base = Math.floor(f);
  const idx = Math.min(3, f - base > b ? base + 1 : base);
  return idx === 0 ? "splash" : (idx as 1 | 2 | 3);
}

/** The ring's tones: the screen's background, then its sky from soft to bright (dusk: the lilac one). */
export function ringTones(bg: string, dark: boolean, dusk = false): [string, string, string, string] {
  if (dusk)
    return dark
      ? [bg, mixHex(bg, "#4a40a8", 0.35), mixHex(bg, "#7b6fe0", 0.66), "#7b6fe0"]
      : [bg, mixHex(bg, "#c9c0ff", 0.55), "#c9c0ff", "#aaa6f5"];
  return dark
    ? [bg, mixHex(bg, "#2b74e6", 0.35), mixHex(bg, "#4b93ff", 0.66), "#4b93ff"]
    : [bg, mixHex(bg, "#a6cfff", 0.55), "#a6cfff", "#78b4ff"];
}

/** Where the name starts below the agent's center (its top), and how far it reaches past that. */
const NAME_NEAR = LOGO / 2 + 18;
const NAME_SPAN = 46;

/** The name (and what is under it) as the ring passes over it, ring edge at `r`: there, then gone under the band. */
export function nameUnderRing(r: number): number {
  "worklet";
  return 1 - smooth01((r - EXIT.band * 0.5 - NAME_NEAR) / NAME_SPAN);
}

/** What waits at the bottom (a server that doesn't answer) goes first, as the agent gathers itself. */
export function panelOut(e: number): number {
  "worklet";
  return 1 - smooth01(e / 0.12);
}

/** One of the agent's pixels as it comes apart: where it sits from the center, its tone, how far it drifts, when it goes. */
export interface BurstCell {
  dx: number;
  dy: number;
  tone: number;
  drift: number;
  gone: number;
}

/**
 * The mark's cells (the engine's dither grid over its 32 grid), each in its part's tone: each drifts out a little and
 * goes out on its own, from the middle first in the dither's order, between 0.02 and 0.26 s after the ring starts.
 */
export function burstCells(): BurstCell[] {
  const n = ditherCells(LOGO);
  const p = LOGO / n;
  const cells: BurstCell[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const v = (j + 0.5) / n;
      const part = markPart(u * 32, v * 32);
      if (part === null) continue;
      const b = bayerAt(i, j);
      cells.push({
        dx: (i + 0.5) * p - LOGO / 2,
        dy: (j + 0.5) * p - LOGO / 2,
        tone: MARK_TONE[part],
        drift: 0.2 + 0.45 * ((((i * 73 + j * 151) % 97) + 0.5) / 97),
        gone: 0.02 + 0.14 * (1 - Math.hypot(u - 0.5, v - 0.5) / 0.71) + 0.1 * b,
      });
    }
  return cells;
}

/** How far out a cell has drifted (1 = where it sat) `k` seconds after the ring started; null once it has gone. */
export function burstDrift(cell: BurstCell, k: number): number | null {
  "worklet";
  if (k > cell.gone) return null;
  return 1 + cell.drift * outQuint(k / EXIT.burst);
}

/** Whether the app, ready `readyMs` after the splash came up, skips its minimum (`LAUNCH.quick`). */
export const launchesAtOnce = (readyMs: number) => readyMs <= LAUNCH.quick * 1000;

/** The line under the name while it waits: none at first, then why (no network, or just slow). */
export function waitLine(late: boolean, offline: boolean): "offline" | "slow" | null {
  if (!late) return null;
  return offline ? "offline" : "slow";
}

/** The little pixel agents going up through the sky: a column each, their own pace and start. */
export const SPRITES = [
  { x: 0.08, speed: 0.05, phase: 0.1, blink: 0.4 },
  { x: 0.25, speed: 0.072, phase: 0.55, blink: 2.1 },
  { x: 0.41, speed: 0.04, phase: 0.3, blink: 1.2 },
  { x: 0.58, speed: 0.065, phase: 0.8, blink: 3.0 },
  { x: 0.74, speed: 0.045, phase: 0.05, blink: 0.9 },
  { x: 0.9, speed: 0.06, phase: 0.62, blink: 2.6 },
] as const;

/**
 * Where a sprite is (share of the height from the top) with the sky at `level`: it rises from `bottom` (near the
 * screen's bottom, or above what the splash shows there) to a little under the sky's top and starts again; null
 * while the sky is too low to hold it.
 */
export function spriteY(sprite: (typeof SPRITES)[number], t: number, level: number, bottom = 0.95): number | null {
  "worklet";
  const travel = bottom - (1 - level) - 0.06;
  if (travel <= 0.04) return null;
  const k = t * sprite.speed + sprite.phase * travel;
  return bottom - (k - travel * Math.floor(k / travel));
}

/** A sprite blinks for a moment every 3.6 s. */
export function spriteBlinks(sprite: (typeof SPRITES)[number], t: number): boolean {
  "worklet";
  return (t + sprite.blink) % 3.6 < 0.12;
}

/** The sprites' body color (deep navy, white eyes: the sky's agents). */
export const SPRITE_BODY = "#04203f";

/**
 * The sky's tones, deep to light from the screen's background. `dusk`: the sky of a team's own server (lilac, as
 * the workspace's sky at dusk), so the splash that waits on that server says which one fell silent.
 */
export function launchSkyTones(bg: string, dark: boolean, dusk = false): string[] {
  if (dusk) {
    const [deep, light] = dark ? ["#4a40a8", "#7b6fe0"] : ["#c9c0ff", "#aaa6f5"];
    return dark
      ? [bg, mixHex(bg, deep, 0.14), mixHex(bg, deep, 0.3), mixHex(bg, deep, 0.48), mixHex(bg, light, 0.66)]
      : [bg, mixHex(bg, deep, 0.22), mixHex(bg, deep, 0.48), mixHex(bg, deep, 0.78), deep, light];
  }
  if (dark)
    return [
      bg,
      mixHex(bg, "#2b74e6", 0.14),
      mixHex(bg, "#2b74e6", 0.3),
      mixHex(bg, "#2b74e6", 0.48),
      mixHex(bg, "#4b93ff", 0.66),
    ];
  return [
    bg,
    mixHex(bg, "#a6cfff", 0.22),
    mixHex(bg, "#a6cfff", 0.48),
    mixHex(bg, "#a6cfff", 0.78),
    "#a6cfff",
    "#78b4ff",
  ];
}
