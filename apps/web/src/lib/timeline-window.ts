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

  const hasPinned = pinnedIndex !== undefined && pinnedIndex >= 0 && pinnedIndex < count;
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

  let topSpacer = 0;
  for (let i = 0; i < start; i++) topSpacer += rowHeights[i] ?? defaultHeight;
  let bottomSpacer = 0;
  for (let i = end; i < count; i++) bottomSpacer += rowHeights[i] ?? defaultHeight;

  return { start, end, topSpacer, bottomSpacer };
}
