export const DEFAULT_ROW_HEIGHT = 88;
export const VIRTUALIZE_MIN_ROWS = 60;

const TAIL_KEEP_ROWS = 10;

export interface TimelineWindowInput {
  keys: readonly string[];
  heights: ReadonlyMap<string, number>;
  defaultHeight?: number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx: number;
  pinnedIndex?: number;
  stickToBottom?: boolean;
  /** The window drawn now: kept while it still covers the viewport, so measuring rows never flips it back and forth. */
  current?: { start: number; end: number };
}

export interface TimelineWindow {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
}

/** Computes the visible `[start, end)` row window and top/bottom spacer heights for `Timeline`. */
export function computeTimelineWindow({
  keys,
  heights,
  defaultHeight = DEFAULT_ROW_HEIGHT,
  scrollTop,
  viewportHeight,
  overscanPx,
  pinnedIndex,
  stickToBottom = false,
  current,
}: TimelineWindowInput): TimelineWindow {
  const count = keys.length;
  if (viewportHeight <= 0 || count <= VIRTUALIZE_MIN_ROWS) {
    return { start: 0, end: count, topSpacer: 0, bottomSpacer: 0 };
  }

  const rowHeights = new Array<number>(count);
  let totalHeight = 0;
  for (let i = 0; i < count; i++) {
    const h = heights.get(keys[i] ?? "") ?? defaultHeight;
    rowHeights[i] = h;
    totalHeight += h;
  }

  const rangeStart = Math.max(0, scrollTop - overscanPx);
  const rangeEnd = scrollTop + viewportHeight + overscanPx;
  const hasPinned = pinnedIndex !== undefined && pinnedIndex >= 0 && pinnedIndex < count;

  let start = -1;
  let end = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    const h = rowHeights[i] ?? defaultHeight;
    const rowTop = y;
    const rowBottom = y + h;
    if (rowBottom > rangeStart && rowTop < rangeEnd) {
      if (start === -1) start = i;
      end = i + 1;
    }
    y = rowBottom;
  }

  if (start === -1) {
    if (hasPinned) {
      start = pinnedIndex;
      end = pinnedIndex + 1;
    } else if (stickToBottom || rangeStart >= totalHeight) {
      start = Math.max(0, count - TAIL_KEEP_ROWS);
      end = count;
    } else {
      start = 0;
      end = Math.min(count, TAIL_KEEP_ROWS);
    }
  } else {
    if (hasPinned) {
      if (pinnedIndex < start) start = pinnedIndex;
      if (pinnedIndex >= end) end = pinnedIndex + 1;
    }
    if (stickToBottom) {
      const tailStart = Math.max(0, count - TAIL_KEEP_ROWS);
      if (tailStart < start) start = tailStart;
      end = count;
    }
  }

  if (
    current &&
    current.end - current.start <= (end - start) * 2 + TAIL_KEEP_ROWS &&
    stillCovers(
      current,
      rowHeights,
      totalHeight,
      scrollTop,
      viewportHeight,
      overscanPx,
      stickToBottom,
      hasPinned ? pinnedIndex : undefined,
    )
  ) {
    return withSpacers(current.start, current.end, rowHeights);
  }

  return withSpacers(start, end, rowHeights);
}

function withSpacers(start: number, end: number, rowHeights: readonly number[]): TimelineWindow {
  let topSpacer = 0;
  for (let i = 0; i < start; i++) topSpacer += rowHeights[i] ?? 0;
  let bottomSpacer = 0;
  for (let i = end; i < rowHeights.length; i++) bottomSpacer += rowHeights[i] ?? 0;
  return { start, end, topSpacer, bottomSpacer };
}

/**
 * Whether the window drawn now still covers the viewport with half the overscan to spare, holds the pinned row and,
 * stuck to the bottom, the last row (the caller also refuses one far larger than a fresh window: the first,
 * unvirtualized one). Without this, a row measured at another height than its estimate (an
 * image or a preview still loading as it mounts) moved the window, which mounted other rows, which moved it again:
 * the timeline re-rendered every frame and, inside one layout pass, past React's nested-update limit.
 */
function stillCovers(
  cur: { start: number; end: number },
  rowHeights: readonly number[],
  totalHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  stickToBottom: boolean,
  pinnedIndex: number | undefined,
): boolean {
  const count = rowHeights.length;
  if (cur.start < 0 || cur.end > count || cur.start >= cur.end) return false;
  if (stickToBottom && cur.end !== count) return false;
  if (pinnedIndex !== undefined && (pinnedIndex < cur.start || pinnedIndex >= cur.end)) return false;
  let top = 0;
  for (let i = 0; i < cur.start; i++) top += rowHeights[i] ?? 0;
  let bottom = top;
  for (let i = cur.start; i < cur.end; i++) bottom += rowHeights[i] ?? 0;
  const margin = overscanPx / 2;
  return top <= Math.max(0, scrollTop - margin) && bottom >= Math.min(totalHeight, scrollTop + viewportHeight + margin);
}
