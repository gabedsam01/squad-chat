import { describe, expect, test } from "bun:test";
import { computeTimelineWindow, DEFAULT_ROW_HEIGHT, VIRTUALIZE_MIN_ROWS } from "@/lib/timeline-window";

function makeKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `row-${i}`);
}

function totalHeightOf(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  defaultHeight = DEFAULT_ROW_HEIGHT,
) {
  let sum = 0;
  for (const k of keys) sum += heights.get(k) ?? defaultHeight;
  return sum;
}

function sliceHeightOf(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  start: number,
  end: number,
  defaultHeight = DEFAULT_ROW_HEIGHT,
) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += heights.get(keys[i] ?? "") ?? defaultHeight;
  return sum;
}

describe("computeTimelineWindow", () => {
  test("returns full range with zero spacers for short lists (<= VIRTUALIZE_MIN_ROWS)", () => {
    const keys = makeKeys(VIRTUALIZE_MIN_ROWS);
    const heights = new Map<string, number>();
    const win = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 500,
      viewportHeight: 800,
      overscanPx: 900,
    });
    expect(win).toEqual({
      start: 0,
      end: VIRTUALIZE_MIN_ROWS,
      topSpacer: 0,
      bottomSpacer: 0,
    });
    const visibleSum = sliceHeightOf(keys, heights, win.start, win.end);
    expect(win.topSpacer + visibleSum + win.bottomSpacer).toBe(totalHeightOf(keys, heights));
  });

  test("returns full range when viewportHeight <= 0 (HappyDOM fallback)", () => {
    const keys = makeKeys(150);
    const heights = new Map<string, number>();
    const win = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 2000,
      viewportHeight: 0,
      overscanPx: 900,
    });
    expect(win).toEqual({
      start: 0,
      end: 150,
      topSpacer: 0,
      bottomSpacer: 0,
    });
  });

  test("computes middle scroll window with overscan and preserves total height invariant", () => {
    const keys = makeKeys(200);
    const heights = new Map<string, number>([
      ["row-0", 120],
      ["row-50", 200],
      ["row-99", 64],
      ["row-150", 180],
    ]);
    const scrollTop = 6000;
    const viewportHeight = 800;
    const overscanPx = 1000;

    const win = computeTimelineWindow({
      keys,
      heights,
      scrollTop,
      viewportHeight,
      overscanPx,
    });

    expect(win.start).toBeGreaterThan(0);
    expect(win.end).toBeLessThan(keys.length);
    expect(win.topSpacer).toBeGreaterThan(0);
    expect(win.bottomSpacer).toBeGreaterThan(0);

    const visibleSum = sliceHeightOf(keys, heights, win.start, win.end);
    expect(win.topSpacer + visibleSum + win.bottomSpacer).toBe(totalHeightOf(keys, heights));
  });

  test("expands window to include pinnedIndex", () => {
    const keys = makeKeys(150);
    const heights = new Map<string, number>();

    const winBefore = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 9000,
      viewportHeight: 800,
      overscanPx: 900,
      pinnedIndex: 5,
    });
    expect(winBefore.start).toBeLessThanOrEqual(5);
    expect(winBefore.end).toBeGreaterThan(5);
    expect(
      winBefore.topSpacer + sliceHeightOf(keys, heights, winBefore.start, winBefore.end) + winBefore.bottomSpacer,
    ).toBe(totalHeightOf(keys, heights));

    const winAfter = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 0,
      viewportHeight: 800,
      overscanPx: 900,
      pinnedIndex: 140,
    });
    expect(winAfter.start).toBe(0);
    expect(winAfter.end).toBeGreaterThanOrEqual(141);
    expect(
      winAfter.topSpacer + sliceHeightOf(keys, heights, winAfter.start, winAfter.end) + winAfter.bottomSpacer,
    ).toBe(totalHeightOf(keys, heights));
  });

  test("stickToBottom always includes at least the last 10 rows", () => {
    const keys = makeKeys(120);
    const heights = new Map<string, number>();

    const win = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 5000,
      viewportHeight: 800,
      overscanPx: 900,
      stickToBottom: true,
    });
    expect(win.start).toBeLessThanOrEqual(keys.length - 10);
    expect(win.end).toBe(keys.length);
    expect(win.bottomSpacer).toBe(0);
    expect(win.topSpacer + sliceHeightOf(keys, heights, win.start, win.end) + win.bottomSpacer).toBe(
      totalHeightOf(keys, heights),
    );
  });

  test("handles out-of-range scrollTop gracefully with pinnedIndex or stickToBottom", () => {
    const keys = makeKeys(100);
    const heights = new Map<string, number>();

    const pinnedOnly = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 999_999,
      viewportHeight: 800,
      overscanPx: 900,
      pinnedIndex: 12,
    });
    expect(pinnedOnly.start).toBe(12);
    expect(pinnedOnly.end).toBe(13);
    expect(
      pinnedOnly.topSpacer + sliceHeightOf(keys, heights, pinnedOnly.start, pinnedOnly.end) + pinnedOnly.bottomSpacer,
    ).toBe(totalHeightOf(keys, heights));

    const tailOnly = computeTimelineWindow({
      keys,
      heights,
      scrollTop: 999_999,
      viewportHeight: 800,
      overscanPx: 900,
      stickToBottom: true,
    });
    expect(tailOnly.start).toBe(90);
    expect(tailOnly.end).toBe(100);
    expect(tailOnly.bottomSpacer).toBe(0);
  });

  test("keeps the window drawn now while it still covers the viewport, so measured rows don't move it back and forth", () => {
    const keys = makeKeys(200);
    const heights = new Map<string, number>();
    const input = { keys, heights, scrollTop: 8000, viewportHeight: 800, overscanPx: 900 };
    const first = computeTimelineWindow(input);
    // Rows inside the window measured shorter than estimated (an image not loaded yet as they mounted).
    for (let i = first.start; i < first.end; i++) heights.set(keys[i] ?? "", 80);
    const fresh = computeTimelineWindow(input);
    const kept = computeTimelineWindow({ ...input, current: first });
    expect(fresh.start === first.start && fresh.end === first.end).toBe(false);
    expect([kept.start, kept.end]).toEqual([first.start, first.end]);
    expect(kept.topSpacer + sliceHeightOf(keys, heights, kept.start, kept.end) + kept.bottomSpacer).toBe(
      totalHeightOf(keys, heights),
    );
  });

  test("leaves the window drawn now once the viewport passes its margin, or it is the first unvirtualized one", () => {
    const keys = makeKeys(200);
    const heights = new Map<string, number>();
    const base = { keys, heights, viewportHeight: 800, overscanPx: 900 };
    const first = computeTimelineWindow({ ...base, scrollTop: 8000 });
    const moved = computeTimelineWindow({ ...base, scrollTop: 12_000, current: first });
    expect(moved).toEqual(computeTimelineWindow({ ...base, scrollTop: 12_000 }));
    const fromAll = computeTimelineWindow({ ...base, scrollTop: 8000, current: { start: 0, end: 200 } });
    expect(fromAll).toEqual(first);
    const stuck = computeTimelineWindow({ ...base, scrollTop: 8000, stickToBottom: true, current: first });
    expect(stuck.end).toBe(200);
  });

  test("keeps a window stretched to a pinned row far above the viewport", () => {
    const keys = makeKeys(200);
    const heights = new Map<string, number>();
    const input = { keys, heights, scrollTop: 8000, viewportHeight: 800, overscanPx: 900, pinnedIndex: 10 };
    const first = computeTimelineWindow(input);
    expect(first.start).toBe(10);
    heights.set(keys[95] ?? "", 120);
    const kept = computeTimelineWindow({ ...input, current: first });
    expect([kept.start, kept.end]).toEqual([first.start, first.end]);
  });
});
