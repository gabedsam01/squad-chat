/**
 * The squadchat mark's shapes on its 32-unit grid (the web's `LogoMark`): a speech bubble, the two people's dots and
 * the agent's square. Plain JavaScript, so the app icons' generator (scripts/app-icons) reads it as the apps do.
 */

/** The bubble, as an SVG path. */
export const MARK_BUBBLE =
  "M9 4h14a7 7 0 0 1 7 7v6a7 7 0 0 1-7 7H12.4l-5.6 4.4a.9.9 0 0 1-1.46-.7v-4.5A7 7 0 0 1 2 17v-6a7 7 0 0 1 7-7Z";
/** The people's two dots: [cx, cy, r]. */
export const MARK_DOTS = [
  [9.6, 14, 2.4],
  [16, 14, 2.4],
];
/** The agent's square, its corners rounded by `r`. */
export const MARK_SQUARE = { x: 20, y: 11.6, size: 4.8, r: 1.2 };

/** The dots and the square as SVG paths (a canvas that draws paths alone takes them so). */
export const MARK_DOT_PATHS = MARK_DOTS.map(
  ([cx, cy, r]) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`,
);
const { x: sx, y: sy, size: ss, r: sr } = MARK_SQUARE;
const side = ss - 2 * sr;
export const MARK_SQUARE_PATH = `M${sx + sr} ${sy}h${side}a${sr} ${sr} 0 0 1 ${sr} ${sr}v${side}a${sr} ${sr} 0 0 1 ${-sr} ${sr}h${-side}a${sr} ${sr} 0 0 1 ${-sr} ${-sr}v${-side}a${sr} ${sr} 0 0 1 ${sr} ${-sr}Z`;

function inRound(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
/** The tail under the bubble's bottom left (the path's tail, its tip's small round taken as straight). */
const TAIL = [
  [5.34, 19],
  [12.4, 19],
  [12.4, 24],
  [6.8, 28.4],
  [6, 28.6],
  [5.34, 27.7],
];
function inTail(x, y) {
  let inside = false;
  for (let i = 0, j = TAIL.length - 1; i < TAIL.length; j = i++) {
    const [xi, yi] = TAIL[i];
    const [xj, yj] = TAIL[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Which part of the mark a point of the 32 grid is on: "dot", "square", "bubble", or null outside it. */
export function markPart(x, y) {
  if (MARK_DOTS.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r)) return "dot";
  if (inRound(x, y, sx, sy, ss, ss, sr)) return "square";
  if (inRound(x, y, 2, 4, 28, 20, 7) || inTail(x, y)) return "bubble";
  return null;
}
