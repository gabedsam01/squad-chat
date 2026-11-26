/**
 * The app icons a person can pick (ADR 0179): the squadchat mark (src/brand/squad-mark.js, the web's `LogoMark`) on
 * the pixel skies. Each icon is a 1024 scene on a grid of 32 cells, in light and dark, plus its favicon at 16 and
 * 32 px. Layers: `mask`/`color` (see raster.mjs), `bg` for what Android puts on the icon's back layer, and `part`
 * ("agent" for the agent's body or the mark's bubble, "eyes" for its eyes or the mark's dots and square, "moon",
 * "accessory") for the one-color icon.
 *
 * Besides those, the icons a person makes on their phone (`madeScene`): a sky, a color and either a face or an
 * accessory, every combination drawn when the phone app is built.
 */
import {
  ACCESSORIES,
  ACCESSORY_CHECK,
  ACCESSORY_PALETTE,
  AGENT_GRADIENTS,
  bodyTones,
  EYE_STYLES,
  eyeShapes,
  inBody,
  toneAt,
} from "../../src/agent/engine.js";
import { markPart } from "../../src/brand/squad-mark.js";

/** The ids, in the order the pickers show them; the first is the icon the apps ship with. */
export const APP_ICON_IDS = ["night", "moon", "sky", "peekNight", "peekSky"];
/** The icon the phone ships with (packages/client's `PHONE_APP_ICON`); the web and desktop ship the first. */
export const PHONE_APP_ICON_ID = "peekNight";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const by = (x, y) => BAYER[(x & 3) + (y & 3) * 4];
const pick = (list, i) => list[Math.max(0, Math.min(list.length - 1, i))];

/** The sky's small agents are navy (`spriteBody`); this is that navy in five tones, deep to light. */
const NIGHT = ["#0b0a1f", "#13113a", "#1c1a4d", "#272463"];
const DAY = ["#4693e8", "#8cc3ff", "#c6e1ff", "#e8f2ff"];
const NAVY_TILE = "#0e0c2a";
const BLACK_NIGHT = "#07061a";
const WHITE = "#ffffff";

/* ---------- Layers in the 1024 scene ---------- */

const always = () => true;
const fill = (hex) => ({ bg: true, mask: always, color: () => hex });
function grid(cols, colorAt) {
  const c = 1024 / cols;
  return { bg: true, mask: always, color: (x, y) => colorAt(Math.floor(x / c), Math.floor(y / c), cols) };
}
function cells(cols, list, extra = {}) {
  const c = 1024 / cols;
  const at = new Map(list.map(([i, j, col]) => [i * 4096 + j, col]));
  const color = (x, y) => at.get(Math.floor(x / c) * 4096 + Math.floor(y / c));
  return { bg: true, mask: (x, y) => color(x, y) !== undefined, color, ...extra };
}
/** Pixel art from rows of "X". */
function shape(cols, rows, ox, oy, col) {
  const list = [];
  for (const [j, row] of rows.entries())
    for (const [i, ch] of [...row].entries()) if (ch === "X") list.push([ox + i, oy + j, col]);
  return cells(cols, list);
}
/** A crescent: the cells inside one circle and outside another (in cells). */
function moon(cols, [cx, cy, r], [cx2, cy2, r2], col) {
  const list = [];
  for (let j = 0; j < cols; j++)
    for (let i = 0; i < cols; i++) {
      const x = i + 0.5;
      const y = j + 0.5;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && (x - cx2) ** 2 + (y - cy2) ** 2 > r2 * r2) list.push([i, j, col]);
    }
  return cells(cols, list, { bg: false, part: "moon" });
}
export function inRound(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
/** A line of `width` through `points`, its ends and corners round (the canvas's round caps and joins). */
function stroke(points, width) {
  const r = width / 2;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const box = [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r];
  return (X, Y) => {
    if (X < box[0] || Y < box[1] || X > box[2] || Y > box[3]) return false;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by_] = points[i];
      const dx = bx - ax;
      const dy = by_ - ay;
      const len = dx * dx + dy * dy;
      const k = len ? Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / len)) : 0;
      if ((X - ax - k * dx) ** 2 + (Y - ay - k * dy) ** 2 <= r * r) return true;
    }
    return false;
  };
}
/** The inside of a closed outline. */
function polygon(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return (X, Y) => {
    if (X < box[0] || Y < box[1] || X > box[2] || Y > box[3]) return false;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > Y !== yj > Y && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}
const CURVE = 24;
/** Points along an ellipse's arc, from angle `a0` to `a1` (y down, as a canvas). */
const arc = (cx, cy, rx, ry, a0, a1) =>
  Array.from({ length: CURVE + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / CURVE;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
const cubic = ([x0, y0], [x1, y1], [x2, y2], [x3, y3]) =>
  Array.from({ length: CURVE + 1 }, (_, i) => {
    const t = i / CURVE;
    const u = 1 - t;
    return [
      u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
      u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3,
    ];
  });
const quad = ([x0, y0], [x1, y1], [x2, y2]) =>
  Array.from({ length: CURVE + 1 }, (_, i) => {
    const t = i / CURVE;
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2];
  });
/**
 * One eye's shape, as the engine's `drawEyes` draws each kind on a canvas: `e` is its box in the scene's units and
 * `s` the body's side (the line's width follows it).
 */
function eyeMask(e, s) {
  const { x: ex, y: ey, w, h } = e;
  const cx = ex + w / 2;
  const cy = ey + h / 2;
  const lw = Math.max(1.4, s * 0.055);
  switch (e.kind) {
    case "arc":
      return stroke(arc(cx, ey + h, Math.max(0.5, w / 2 - lw / 2), h, Math.PI, 2 * Math.PI), lw);
    case "cup":
      return stroke(arc(cx, ey, Math.max(0.5, w / 2 - lw / 2), h, 0, Math.PI), lw);
    case "lid":
      return (X, Y) => Y >= ey && ((X - cx) / (w / 2)) ** 2 + ((Y - ey) / h) ** 2 <= 1;
    case "heart": {
      const tip = [cx, ey + h];
      const dip = [cx, ey + h * 0.3];
      return polygon([
        ...cubic(tip, [ex - w * 0.1, ey + h * 0.55], [ex, ey - h * 0.1], dip),
        ...cubic(dip, [ex + w, ey - h * 0.1], [ex + w * 1.1, ey + h * 0.55], tip),
      ]);
    }
    case "star": {
      const r = Math.min(w, h) / 2;
      return polygon(
        Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
          const rr = i % 2 ? r * 0.32 : r;
          return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
        }),
      );
    }
    case "cross": {
      const a = stroke(
        [
          [ex + lw / 2, ey + lw / 2],
          [ex + w - lw / 2, ey + h - lw / 2],
        ],
        lw,
      );
      const b = stroke(
        [
          [ex + w - lw / 2, ey + lw / 2],
          [ex + lw / 2, ey + h - lw / 2],
        ],
        lw,
      );
      return (X, Y) => a(X, Y) || b(X, Y);
    }
    case "ring":
      return stroke(arc(cx, cy, Math.max(0.5, w / 2 - lw / 2), Math.max(0.5, h / 2 - lw / 2), 0, 2 * Math.PI), lw);
    case "slant": {
      const inner = e.side === 0 ? ex + w : ex;
      const outer = e.side === 0 ? ex : ex + w;
      return polygon([
        [outer, ey],
        [inner, ey + h * 0.38],
        ...quad([inner, ey + h - w / 2], [inner, ey + h], [cx, ey + h]),
        ...quad([cx, ey + h], [outer, ey + h], [outer, ey + h - w / 2]),
      ]);
    }
    default:
      return (X, Y) => inRound(X, Y, ex, ey, w, h, Math.min(w, h) / 2);
  }
}
/** A layer turned `deg` clockwise around `about`, a point of the scene. */
function turned(layer, { deg, about: [ax, ay] }) {
  const cos = Math.cos((deg * Math.PI) / 180);
  const sin = Math.sin((deg * Math.PI) / 180);
  const back = (f) => (X, Y) => f(ax + (X - ax) * cos + (Y - ay) * sin, ay - (X - ax) * sin + (Y - ay) * cos);
  return { ...layer, mask: back(layer.mask), color: back(layer.color) };
}
/**
 * The agent: its body (the engine's shape, dithered in `tones` or one `solid` color) and its white eyes, both leaning
 * with `turn`.
 */
function agent({ x, y, s, n, tones, solid, style = "round", pose = {}, turn }) {
  const c = s / n;
  const eyes = eyeShapes(style, pose).map((e) =>
    eyeMask({ ...e, x: x + e.x * s, y: y + e.y * s, w: e.w * s, h: e.h * s }, s),
  );
  const layers = [
    {
      part: "agent",
      mask: (X, Y) => inBody((X - x) / s, (Y - y) / s),
      color: solid ? () => solid : (X, Y) => tones[toneAt(Math.floor((X - x) / c), Math.floor((Y - y) / c), n)],
    },
    {
      part: "eyes",
      mask: (X, Y) => eyes.some((eye) => eye(X, Y)),
      color: () => WHITE,
    },
  ];
  return turn ? layers.map((l) => turned(l, turn)) : layers;
}

/** The mark's colors: light on the night (the web's dark theme), ink on the day (the web's favicon). */
const MARK_ON_NIGHT = { bubble: "#eeecfa", dot: "#0e0c2a", square: "#ffb46a" };
const MARK_ON_DAY = { bubble: "#0e0c2a", dot: "#eeecfa", square: "#ffb46a" };
/** The squadchat mark: its 32 grid drawn `s` wide at (x, y), its dots and square cut in the one-color icon. */
function mark({ x, y, s, turn }, colors) {
  const k = s / 32;
  const at = (X, Y) => markPart((X - x) / k, (Y - y) / k);
  const layers = [
    { part: "agent", mask: (X, Y) => at(X, Y) !== null, color: () => colors.bubble },
    {
      part: "eyes",
      mask: (X, Y) => {
        const p = at(X, Y);
        return p === "dot" || p === "square";
      },
      color: (X, Y) => (at(X, Y) === "square" ? colors.square : colors.dot),
    },
  ];
  return turn ? layers.map((l) => turned(l, turn)) : layers;
}

function nightAt(halo) {
  return (i, j, cols) => {
    const u = (i + 0.5) / cols;
    const v = (j + 0.5) / cols;
    let val = 0.18 + 0.28 * v;
    if (halo) val += 2.4 * Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.47) / 0.6) ** 1.6;
    return pick(NIGHT, Math.floor(val + by(i, j)));
  };
}
const dayAt = (i, j, cols) => pick(DAY, Math.floor(((j + 0.5) / cols) * 2.7 + by(i, j)));

/** The agent on the 32-cell grid: cells 7..24 × 6..23, one dither cell = one cell of the sky. */
const AG = { x: 224, y: 192, s: 576, n: 18 };
/**
 * Big, leaning in from the bottom right corner and looking up: 30 cells a side, turned around the middle of its eyes,
 * so its cells lean with it and no longer sit on the sky's.
 */
const PEEK = { x: 170, y: 202, s: 960, n: 30, pose: { look: [-0.035, -0.045] }, turn: { deg: -18, about: [650, 600] } };
/** The mark in the middle (its 32 grid's middle on the icon's). */
const MK = { x: 224, y: 220, s: 576 };
/** Smaller and to the left, so the moon fits. */
const MK_MOON = { x: 176, y: 272, s: 544 };
/** Big, coming in from the bottom right corner, leaning. */
const MK_PEEK = { x: 400, y: 420, s: 700, turn: { deg: -8, about: [700, 700] } };
/** The favicon's mark on its tile, in pixels. */
const markFav = (N) => ({ x: N * 0.0625, y: N * 0.03, s: N * 0.875 });

const STARS = [
  [4, 4, "#eeecfa"],
  [27, 5, "#ffb46a"],
  [16, 2, "#6f69b8"],
  [3, 18, "#6f69b8"],
  [28, 25, "#eeecfa"],
  [9, 28, "#ffb46a"],
  [22, 28, "#6f69b8"],
];
const STARS_MOON = [
  [4, 4, "#eeecfa"],
  [11, 3, "#ffb46a"],
  [16, 5, "#6f69b8"],
  [3, 14, "#6f69b8"],
  [28, 17, "#ffb46a"],
  [27, 26, "#eeecfa"],
  [4, 27, "#ffb46a"],
  [26, 12, "#6f69b8"],
];
/** The stars around the leaning agent: over it and down its left side. */
const STARS_PEEK = [
  [4, 3, "#eeecfa"],
  [24, 1, "#ffb46a"],
  [16, 2, "#6f69b8"],
  [9, 6, "#6f69b8"],
  [2, 15, "#eeecfa"],
  [4, 25, "#ffb46a"],
];
const CLOUD_A = ["..XX...", ".XXXXX.", "XXXXXXX"];
const CLOUD_B = [".XXX.", "XXXXX"];
/** What is behind the leaning agent: the night's stars or the day's clouds, clear of it. */
const PEEK_BACK = {
  night: () => [grid(32, nightAt(false)), cells(32, STARS_PEEK)],
  sky: () => [grid(32, dayAt), shape(32, CLOUD_A, 3, 2, WHITE), shape(32, CLOUD_B, 17, 1, WHITE)],
};
const MOON = [
  [25, 5.2, 3.3],
  [26.6, 4.2, 2.7],
];

/* ---------- Favicons, in pixels ---------- */

const tile = (N, r, color) => ({
  mask: (x, y) => inRound(x, y, 0, 0, N, N, r),
  color: typeof color === "function" ? color : () => color,
});
const clipped = (N, r, layer) => ({ ...layer, mask: (x, y) => inRound(x, y, 0, 0, N, N, r) && layer.mask(x, y) });
const crescent = ([cx, cy, r], [cx2, cy2, r2], color) => ({
  mask: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r && (x - cx2) ** 2 + (y - cy2) ** 2 > r2 * r2,
  color: () => color,
});

/* ---------- The icons ---------- */

export const SCENES = {
  /** Noite: the night sky, a glow in dither around the mark, loose stars. */
  night: {
    light: () => [grid(32, nightAt(true)), cells(32, STARS), ...mark(MK, MARK_ON_NIGHT)],
    dark: () => [fill(BLACK_NIGHT), cells(32, STARS), ...mark(MK, MARK_ON_NIGHT)],
    favicon: (N) => [tile(N, N * 0.22, NAVY_TILE), ...mark(markFav(N), MARK_ON_NIGHT)],
  },
  /** Lua: a pixel moon in the corner over the mark. */
  moon: {
    light: () => [
      grid(32, nightAt(false)),
      cells(32, STARS_MOON),
      moon(32, MOON[0], MOON[1], "#eeecfa"),
      ...mark(MK_MOON, MARK_ON_NIGHT),
    ],
    dark: () => [
      fill(BLACK_NIGHT),
      cells(32, STARS_MOON),
      moon(32, MOON[0], MOON[1], "#ffd09e"),
      ...mark(MK_MOON, MARK_ON_NIGHT),
    ],
    favicon: (N) => [
      tile(N, N * 0.22, NAVY_TILE),
      crescent([N * 0.83, N * 0.17, N * 0.11], [N * 0.875, N * 0.13, N * 0.094], "#eeecfa"),
      ...mark({ x: 0, y: N * 0.1, s: N * 0.8 }, MARK_ON_NIGHT),
    ],
  },
  /** Céu: the landing's sky by day, two pixel clouds and the mark in ink; at night, the night. */
  sky: {
    light: () => [
      grid(32, dayAt),
      shape(32, CLOUD_A, 3, 2, WHITE),
      shape(32, CLOUD_B, 26, 12, WHITE),
      ...mark(MK, MARK_ON_DAY),
    ],
    dark: () => [grid(32, nightAt(false)), cells(32, STARS), ...mark(MK, MARK_ON_NIGHT)],
    favicon: (N) => [tile(N, N * 0.22, "#8cc3ff"), ...mark(markFav(N), MARK_ON_DAY)],
  },
  /** Espiando à noite: the mark big, coming in from the bottom right corner, under the night's stars. */
  peekNight: {
    light: () => [...PEEK_BACK.night(), ...mark(MK_PEEK, MARK_ON_NIGHT)],
    dark: () => [fill(BLACK_NIGHT), cells(32, STARS_PEEK), ...mark(MK_PEEK, MARK_ON_NIGHT)],
    favicon: (N) => [
      tile(N, N * 0.22, NAVY_TILE),
      ...mark({ x: N * 0.2, y: N * 0.25, s: N * 1.1 }, MARK_ON_NIGHT).map((l) => clipped(N, N * 0.22, l)),
    ],
  },
  /** Espiando no céu: the same, in the day sky with clouds, the mark in ink. */
  peekSky: {
    light: () => [...PEEK_BACK.sky(), ...mark(MK_PEEK, MARK_ON_DAY)],
    dark: () => [...PEEK_BACK.night(), ...mark(MK_PEEK, MARK_ON_NIGHT)],
    favicon: (N) => [
      tile(N, N * 0.22, "#8cc3ff"),
      ...mark({ x: N * 0.2, y: N * 0.25, s: N * 1.1 }, MARK_ON_DAY).map((l) => clipped(N, N * 0.22, l)),
    ],
  },
};

/* ---------- The icons a person makes on their phone ---------- */

/** What a made icon is made of. The phone's plugin and the apps' list name the same (tests keep them equal). */
export const MADE_SKIES = ["night", "sky"];
export const MADE_COLORS = Object.keys(AGENT_GRADIENTS);
/** The eye styles, then the expressions that hold as a still picture. */
export const MADE_FACES = ["round", "dots", "wide", "happy", "sleepy", "wink", "heart", "star", "surprised", "angry"];
export const MADE_ACCESSORIES = Object.keys(ACCESSORIES);
/** A face or an accessory, never both: a build carries every combination, and both together would be 1,920 icons. */
export const MADE_LOOKS = [...MADE_FACES, ...MADE_ACCESSORIES];
/** Facing, as the shipped icon, or leaning in from the corner as the Peeking ones (a face only: nothing it wears fits). */
export const MADE_POSES = ["front", "peek"];
export const madeId = ({ sky, color, look, pose }) => `made-${sky}-${color}-${look}${pose === "peek" ? "-peek" : ""}`;
export const madeIcons = () =>
  MADE_POSES.flatMap((pose) =>
    MADE_SKIES.flatMap((sky) =>
      MADE_COLORS.flatMap((color) =>
        (pose === "peek" ? MADE_FACES : MADE_LOOKS).map((look) => ({ sky, color, look, pose })),
      ),
    ),
  );

/** Wearing something, the agent is smaller and lower so it fits: cells 8..23 × 13..28 (as the web draws it). */
const AG_WEARING = { x: 256, y: 416, s: 512, n: 16 };

/** An accessory on the body's 16 cells (the engine's `drawAccessory`), its antenna's light off. */
function accessory({ x, y, s }, name) {
  const a = ACCESSORIES[name];
  const u = s / 16;
  const key = (gx, gy) => (gx + 64) * 4096 + gy + 64;
  const at = new Map();
  for (const [j, row] of a.rows.entries())
    for (const [i, raw] of [...row].entries()) {
      if (raw === " ") continue;
      const gx = a.ox + i;
      const gy = a.oy + j;
      const ch = ACCESSORY_CHECK[raw] ? ACCESSORY_CHECK[raw][(gx + gy) & 1] : raw;
      at.set(key(gx, gy), ch === "A" ? "#ff6b5e" : (ACCESSORY_PALETTE[ch] ?? "#000000"));
    }
  const color = (X, Y) => at.get(key(Math.floor((X - x) / u), Math.floor((Y - y) / u)));
  return { part: "accessory", mask: (X, Y) => color(X, Y) !== undefined, color };
}

/**
 * A made icon's 1024 scene: the Night's sky or the day's, and the agent in its color with its face or accessory,
 * or leaning in with its face as the Peeking icons' agent.
 */
export function madeScene({ sky, color, look, pose = "front" }) {
  const wears = Object.hasOwn(ACCESSORIES, look);
  const face = wears ? "round" : look;
  if (pose === "peek") {
    const leaning = EYE_STYLES[face] ? { style: face } : { pose: { ...PEEK.pose, expression: face } };
    return [...PEEK_BACK[sky](), ...agent({ ...PEEK, tones: bodyTones(color), ...leaning })];
  }
  const eyes = EYE_STYLES[face] ? { style: face } : { pose: { expression: face } };
  const at = wears ? AG_WEARING : AG;
  const back =
    sky === "night"
      ? [grid(32, nightAt(true)), cells(32, STARS)]
      : [grid(32, dayAt), shape(32, CLOUD_A, 3, 2, WHITE), shape(32, CLOUD_B, 26, 12, WHITE)];
  return [...back, ...agent({ ...at, tones: bodyTones(color), ...eyes }), ...(wears ? [accessory(at, look)] : [])];
}

/* ---------- The phone's launch image and notification icon ---------- */

/**
 * The launch image (512 px, the mark 400 wide in the middle, on nothing): in the theme's ink, ground and agent colors
 * (packages/tokens), as the animated splash draws it over that ground (apps/mobile/src/features/launch).
 */
export const LAUNCH_MARK = {
  light: { bubble: "#12102b", dot: "#f6f6fb", square: "#b34d00" },
  dark: { bubble: "#eeecfa", dot: "#0e0c2a", square: "#ffb46a" },
};
export const splashLayers = (look) => mark({ x: 56, y: 56, s: 400 }, LAUNCH_MARK[look]);
/** Android's notification icon (96 px): the mark in white, its dots and square cut out. */
export const notificationLayers = () => monoLayers(mark({ x: 3, y: 1, s: 90 }, MARK_ON_NIGHT));

/* ---------- The same scene for each place ---------- */

/** Android's back layer: what is drawn behind the agent. */
export const backLayers = (layers) => layers.filter((l) => l.bg);
/** Android's front layer: the agent (and the moon), on nothing. */
export const frontLayers = (layers) => layers.filter((l) => !l.bg);
/** Android 13's one-color icon: the agent's shape (and the moon) with the eyes cut out. */
export const monoLayers = (layers) =>
  layers
    .filter((l) => l.part)
    .map((l) => (l.part === "eyes" ? { mask: l.mask, erase: true } : { mask: l.mask, color: () => WHITE }));

/** The scene cut to a rounded square (r in the scene's units): the browser's and Windows' icons. */
export const tiled = (layers, r = 225) =>
  layers.map((l) => ({ ...l, mask: (x, y) => inRound(x, y, 0, 0, 1024, 1024, r) && l.mask(x, y) }));

/** macOS's shape: a superellipse of 824 in the 1024 canvas (Apple's grid), with a soft shadow under it. */
const MAC = { at: 100, size: 824, n: 5 };
function squircleF(x, y, dy = 0) {
  const a = MAC.size / 2;
  const c = MAC.at + a;
  return (Math.abs((x - c) / a) ** MAC.n + Math.abs((y - c - dy) / a) ** MAC.n) ** (1 / MAC.n);
}
export function macLayers(layers) {
  const a = MAC.size / 2;
  const k = 1024 / MAC.size;
  const shadow = {
    mask: always,
    alpha: (x, y) => {
      const d = (squircleF(x, y, 10) - 1) * a;
      return d <= 0 ? 0.3 : 0.3 * Math.max(0, 1 - d / 26) ** 2;
    },
    color: () => "#000000",
  };
  const inside = (x, y) => squircleF(x, y) <= 1;
  const toScene = (f) => (x, y) => f((x - MAC.at) * k, (y - MAC.at) * k);
  return [
    shadow,
    ...layers.map((l) => ({
      ...l,
      mask: (x, y) => inside(x, y) && toScene(l.mask)(x, y),
      color: toScene(l.color),
      ...(l.alpha ? { alpha: toScene(l.alpha) } : {}),
    })),
  ];
}
