export declare const MARK_BUBBLE: string;
export declare const MARK_DOTS: readonly [cx: number, cy: number, r: number][];
export declare const MARK_SQUARE: { x: number; y: number; size: number; r: number };
export declare const MARK_DOT_PATHS: readonly string[];
export declare const MARK_SQUARE_PATH: string;
export type MarkPart = "dot" | "square" | "bubble";
export declare function markPart(x: number, y: number): MarkPart | null;
