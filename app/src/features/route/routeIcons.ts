/**
 * The handful of glyphs the routing UI needs, as inline SVG.
 *
 * Built with `createElementNS` and never `innerHTML`, matching the rule the
 * rest of this app follows (`panel.ts`, `historyChart.ts`, `elevationChart.ts`
 * all say the same). Inline rather than an icon font or sprite sheet because
 * four paths do not justify another asset, another request, or another origin
 * in the CSP.
 *
 * Every icon is drawn on a 24x24 viewBox and inherits `currentColor`, so a
 * button controls its own icon colour through ordinary CSS.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  /** The classic "directions" lozenge with a turn arrow inside it. */
  directions:
    "M21.71 11.29l-9-9a.996.996 0 00-1.41 0l-9 9a.996.996 0 000 1.41l9 9c.39.39 1.02.39 1.41 0l9-9a.996.996 0 000-1.41zM14 14.5V12h-4v3H8v-4c0-.55.45-1 1-1h5V7.5l3.5 3.5-3.5 3.5z",
  /** A map pin, for "pick this end on the map". */
  pin: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z",
  /** Two arrows, for swapping the endpoints. */
  swap: "M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");
  // The icon is decoration: every button carrying one also has a real text
  // label or an aria-label, so announcing the graphic as well would be noise.
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
