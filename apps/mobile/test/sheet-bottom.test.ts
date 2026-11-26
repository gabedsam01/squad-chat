import { expect, test } from "bun:test";
import { sheetBottom } from "../src/ui/sheet-bottom";

test("a sheet clears Android's navigation bar and leaves iOS to TrueSheet", () => {
  expect(sheetBottom("android", 48)).toBe(72);
  expect(sheetBottom("ios", 34)).toBe(24);
});
