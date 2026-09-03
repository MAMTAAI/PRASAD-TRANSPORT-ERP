// @ts-nocheck
// ============================================================================
// ONE RESPONSIVE SHELL FOR THE FOUR EXTERNAL APPS
//
// Owner, 3-Sep-2026: auditing these apps on a PC monitor meant staring at a
// 380 px strip in the middle of a black screen. They are phone apps — drivers,
// pump owners, truck owners, consignors — and they should stay phone apps on a
// phone. So this is a RESPONSIVE widening, not four rewrites:
//
//   phone  (default) → max-w-md, exactly as before, untouched
//   tablet (md ≥768) → max-w-2xl, and card lists go two-up
//   desktop(lg ≥1024)→ max-w-4xl, and card lists go three-up
//
// WHY NOT A SIDEBAR DASHBOARD. Two reasons. The staff preview exists to show
// what the PARTY actually sees; a desktop-only layout would make the preview a
// different app from the one being audited. And a driver in a cab has never
// opened a sidebar — the bottom nav is the whole navigation model, and it works
// at every width.
//
// THE NAV MUST TRACK THE SHELL. It is `fixed` and centred, so if the shell
// widens and the nav does not, the tab bar floats detached in the middle of a
// wide page. Both use the same three widths, which is the reason they live in
// one file instead of being typed out in four.
// ============================================================================

/** The page column. Same on a phone; grows on bigger screens.
 *
 *  THE FRAME (owner, 3-Sep evening). A phone app stays a phone app at every
 *  width — that decision from this morning stands. What was missing is the
 *  EDGE. Once the apps went dark, the column and the page behind it were the
 *  same navy with nothing between them, so a 4xl column on a 3439 px monitor
 *  read as a strip floating in blackness. That is the identical complaint the
 *  old light-grey desk used to answer, back when the app inside was light.
 *
 *  From md up the column gets a hairline and a real shadow so the eye can find
 *  where the app starts and stops. Below md none of it applies: on a phone the
 *  app IS the screen, and a border there is just a seam. */
export const APP_SHELL =
  'mx-auto flex min-h-screen w-full max-w-md md:max-w-2xl lg:max-w-4xl flex-col '
  + 'bg-slate-950 bg-deck-ground text-slate-100 '
  + 'md:border-x md:border-slate-700 '
  + 'md:shadow-[0_0_0_1px_rgba(97,130,190,0.40),0_28px_80px_rgba(2,5,16,0.8)]';

/** The fixed bottom tab bar. Widths MUST match APP_SHELL — and so must the
 *  side border, because a nav one pixel wider than its app is worse than no
 *  border at all. */
export const APP_NAV =
  'fixed bottom-0 left-1/2 z-40 w-full max-w-md md:max-w-2xl lg:max-w-4xl -translate-x-1/2 '
  + 'border-t border-slate-700 md:border-x bg-slate-900/95 backdrop-blur-md';

/** A fixed action bar above the nav (the trip screen's one big button). */
export const APP_BAR =
  'fixed bottom-0 left-1/2 z-40 w-full max-w-md md:max-w-2xl lg:max-w-4xl -translate-x-1/2 '
  + 'border-t border-slate-700 md:border-x bg-slate-900/95 backdrop-blur-md p-3';

/** Turn a column of cards into a grid on bigger screens. Applied to the list
 *  containers only — headers, segmented controls and single wide cards keep
 *  the full width, because a filter strip chopped into a column reads as a
 *  broken layout rather than a dense one. */
export const APP_GRID = 'md:grid md:grid-cols-2 md:items-start md:gap-2.5 lg:grid-cols-3';

/** Same, for lists whose rows are wide (a trip with a route on it looks wrong
 *  at one-third width, but fine at a half). */
export const APP_GRID_2 = 'md:grid md:grid-cols-2 md:items-start md:gap-2.5';
