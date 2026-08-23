/* Monoline terrain glyphs, drawn in a 24x24 space and mounted once as an SVG
   sprite sheet. Everything paints in currentColor so each context picks its own ink. */

import { faceSpec } from "../terrain.js";

export const ICONS = {
  wood: `<path d="M12 3.2 16.7 10.4 7.3 10.4Z M12 8.4 18.4 17 5.6 17Z" fill="currentColor"/>
         <rect x="11" y="16" width="2" height="5" rx=".6" fill="currentColor"/>`,
  wild: `<path d="M12 2.6 14.6 9.4 21.4 12 14.6 14.6 12 21.4 9.4 14.6 2.6 12 9.4 9.4Z"
           fill="currentColor"/>`,
  wheat: `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
           <path d="M12 21V7"/><path d="M12 9.5 15.6 6.9M12 9.5 8.4 6.9"/>
           <path d="M12 13.5 15.6 10.9M12 13.5 8.4 10.9"/><path d="M12 17.5 15.6 14.9M12 17.5 8.4 14.9"/></g>`,
  wool: `<g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="7.2"/>
           <path d="M6.6 7.4c4.2 1.8 7.4 5 9 9.2"/><path d="M9.8 5.2c3.2 2.6 5.8 6 7 9.8"/>
           <path d="M4.9 11.2c3.9 1.2 7 3.8 8.9 7.2"/></g>`,
  ore: `<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
           <path d="M12 3.4 18.6 9 15.9 20.4H8.1L5.4 9Z"/>
           <path d="M5.4 9h13.2M12 3.4V9M9.6 9l1.3 11.4M14.4 9l-1.3 11.4"/></g>`,
  fish: `<ellipse cx="13.4" cy="12" rx="7" ry="4.4" fill="currentColor"/>
         <path d="M6.6 12 1.8 8v8Z" fill="currentColor"/><circle cx="16.4" cy="10.6" r="1" fill="#0B1620"/>`,
  desert: `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
           <circle cx="16.6" cy="6.6" r="2.8"/><path d="M2.6 16.4c2.6-3.6 5-3.6 7.4 0 1.9 2.8 4 2.8 6.2-.6"/>
           <path d="M4.4 20.2h15"/></g>`,
  plain: `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
           <path d="M4 19.6h16"/><path d="M7 19.6c0-3.6.8-5.8 1.8-7.6"/>
           <path d="M11.4 19.6c0-4.6 1.6-7.6 2.6-9.4"/><path d="M15.6 19.6c.8-3.4 2.4-5.4 4-6.4"/></g>`,
  mountain: `<path d="M1.8 19.4 8.8 6.6 12.6 13.4 15.4 8.8 22.2 19.4Z" fill="currentColor"/>
            <path d="M8.8 6.6 6.4 11l2.4-1.2L11 11Z" fill="#0B1620" opacity=".35"/>`,
  sea: `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
           <path d="M3 10.2c1.8-2 3.4-2 5.2 0s3.4 2 5.2 0 3.4-2 5.2 0"/>
           <path d="M3 15.4c1.8-2 3.4-2 5.2 0s3.4 2 5.2 0 3.4-2 5.2 0"/></g>`,
};

export function mountSprites(el) {
  el.innerHTML = Object.entries(ICONS)
    .map(([k, g]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${g}</symbol>`).join("");
}

/* Inline glyph for panel contexts. Pass a colour to override the terrain ink. */
export const glyph = (k, color) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${k}" style="color:${color || faceSpec(k).ink}"/></svg>`;
