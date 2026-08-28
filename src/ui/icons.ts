/**
 * Inline SVG icons.
 *
 * NOT unicode glyphs. ⟲ / ⊞ / ♪ render inconsistently across platforms — some fonts
 * lack them, some substitute emoji, and Safari is the one browser we cannot test here.
 * An inline path renders identically everywhere, scales crisply, and inherits
 * `currentColor` so it picks up hover and disabled states for free.
 *
 * Every icon is drawn on a 24×24 grid with a 2px stroke, matching the engineering-
 * drawing line weight the rest of the UI uses (13 §4).
 */

export type IconId =
  'recenter' | 'engrave' | 'engraveOff' | 'sound' | 'muted' | 'help' | 'close' | 'trash' | 'github';

const PATHS: Record<IconId, string> = {
  // Recenter: a framing bracket around a target dot.
  recenter: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="12" r="2.5"/>',
  // Engraved face: a tile with a cut line through it.
  engrave: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 9h5M8 12.5h8M8 16h6"/>',
  // The OFF state is a bare tile — "plain face" — not a slashed one. A slash reads as
  // "forbidden"; an empty face reads as what you actually get. `text-decoration` cannot
  // express this, which is why the first attempt at an off state was invisible.
  engraveOff: '<rect x="4" y="4" width="16" height="16" rx="1.5"/>',
  sound:
    '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a4 4 0 0 1 0 5"/><path d="M18 7.5a7.5 7.5 0 0 1 0 9"/>',
  muted: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 10l5 4M21 10l-5 4"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.8.7-.8 1.3v.4"/><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  // Deliberately a bin, not an X. An X beside a readout reads as "close this panel";
  // the panel is not what the button removes.
  trash:
    '<path d="M4 7h16M9.5 7V4.5h5V7M6.6 7l.85 12.6a1 1 0 0 0 1 .9h7.1a1 1 0 0 0 1-.9L17.4 7"/><path d="M10.2 11v5.4M13.8 11v5.4"/>',
  /*
   * The one icon here that is not drawn to the house style, because it is not ours to
   * redraw: the GitHub mark is a trademark and is recognised by its exact silhouette.
   * A 2px-stroke approximation would read as a generic cat. It is the official
   * 16-grid mark, scaled onto this file's 24 grid, and filled rather than stroked.
   */
  github:
    '<g transform="scale(1.5)"><path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></g>',
};

export function icon(id: IconId, sizePx = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the button itself carries the accessible name via aria-label.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = PATHS[id];
  return svg;
}
