/**
 * The room under a sheet's content: 24, plus on Android the system navigation bar's height. Android's TrueSheet draws
 * under that bar and adds nothing (iOS's home indicator room is TrueSheet's own), so the last row sat under the bar until
 * the list scrolled.
 */
export const sheetBottom = (os: string, navBar: number) => (os === "android" ? 24 + navBar : 24);
