/**
 * Procedural inline-SVG art for the HUD: worm portraits, gravestone, weapon icons, wind arrow.
 * Flat cartoon style with a dark outline, no external assets.
 */
import { hexCss, shade } from './dom';

const OUT = '#1b1f2a';

/** Round worm portrait (helmet with team band) on a team-coloured disc. 40×40 viewBox. */
export function wormPortraitSvg(teamColor: number): string {
  const bg = hexCss(teamColor);
  const bgLight = hexCss(shade(teamColor, 0.35));
  const band = hexCss(shade(teamColor, 0.1));
  return `<svg viewBox="0 0 40 40" aria-hidden="true">
<circle cx="20" cy="20" r="20" fill="${bg}"/>
<circle cx="20" cy="15" r="14" fill="${bgLight}" opacity=".55"/>
<path d="M10.5 41V24.5a9.5 9.5 0 0 1 19 0V41Z" fill="#ff8aa6" stroke="#6e2338" stroke-width="1.3"/>
<ellipse cx="20" cy="35" rx="5.2" ry="6.5" fill="#ffb3c4"/>
<ellipse cx="16.2" cy="23.2" rx="3.3" ry="3.9" fill="#fff" stroke="#3a1622" stroke-width=".9"/>
<ellipse cx="23.8" cy="23.2" rx="3.3" ry="3.9" fill="#fff" stroke="#3a1622" stroke-width=".9"/>
<circle cx="16.9" cy="24" r="1.6" fill="#15151a"/>
<circle cx="23.1" cy="24" r="1.6" fill="#15151a"/>
<path d="M16.8 30q3.2 2.4 6.4 0" fill="none" stroke="#6e2338" stroke-width="1.3" stroke-linecap="round"/>
<path d="M8.6 19.4a11.4 10.4 0 0 1 22.8 0Z" fill="#5f6d33" stroke="#252c12" stroke-width="1.1"/>
<path d="M13 12.5q3-2.6 6-2.9" fill="none" stroke="#8a9a55" stroke-width="1.4" stroke-linecap="round"/>
<rect x="7.6" y="17.6" width="24.8" height="3.4" rx="1.7" fill="${band}" stroke="#252c12" stroke-width=".9"/>
</svg>`;
}

/** Gravestone glyph for dead worms. 40×40 viewBox. */
export const GRAVESTONE_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true">
<circle cx="20" cy="20" r="20" fill="#3a3f4a"/>
<path d="M11 34V17a9 9 0 0 1 18 0v17Z" fill="#b9bec7" stroke="${OUT}" stroke-width="1.4"/>
<path d="M20 15v11M15.5 19.5h9" stroke="#6b717d" stroke-width="2.4" stroke-linecap="round"/>
<rect x="7" y="33" width="26" height="4" rx="2" fill="#5e8a3e" stroke="${OUT}" stroke-width="1"/>
</svg>`;

/** Arrow pointing up (rotated via CSS). 24×24 viewBox. */
export const WIND_ARROW_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 2 20 12h-5v10H9V12H4Z" fill="currentColor" stroke="${OUT}" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

const icon = (body: string) =>
  `<svg viewBox="0 0 48 48" aria-hidden="true" stroke="${OUT}" stroke-width="1.6" stroke-linejoin="round">${body}</svg>`;

/** Weapon icons keyed by weapon id (ids match the sim weapon registry once it exists). */
export const WEAPON_ICONS: Record<string, string> = {
  bazooka: icon(`<g transform="rotate(-32 24 24)">
<rect x="3" y="18" width="7" height="12" rx="2" fill="#4c5f25"/>
<rect x="8" y="19.5" width="33" height="9" rx="2.5" fill="#6f8a36"/>
<rect x="38" y="17" width="7" height="14" rx="2" fill="#56702a"/>
<rect x="26" y="19.5" width="3" height="9" fill="#f2c230"/>
<rect x="17" y="13.5" width="7" height="6" rx="1.5" fill="#39402a"/>
<rect x="19" y="28" width="5" height="8" rx="1.5" fill="#39402a"/>
<path d="M11 21.5h24" stroke="#94ad58" stroke-width="1.6" fill="none"/></g>`),
  grenade: icon(`<ellipse cx="23" cy="29" rx="12.5" ry="13.5" fill="#4f9a3a"/>
<path d="M11 27h24M11.5 33h23M17 17v24M29 17v24" stroke="#3a7429" stroke-width="1.4" fill="none"/>
<ellipse cx="18.5" cy="23" rx="3" ry="4" fill="#7cc35c" stroke="none"/>
<rect x="17.5" y="10" width="11" height="7.5" rx="2" fill="#b3bac4"/>
<path d="M28 12.5q8-1 8 7" fill="none" stroke="#b3bac4" stroke-width="3" stroke-linecap="round"/>
<circle cx="34" cy="9" r="4" fill="none" stroke="#e1b43a" stroke-width="2.2"/>`),
  shotgun: icon(`<g transform="rotate(-20 24 24)">
<path d="M3 26l10-4h6v8h-7l-7 4Z" fill="#9a5b2c"/>
<rect x="18" y="20" width="27" height="5" rx="1.5" fill="#8d96a3"/>
<rect x="18" y="25" width="22" height="3.5" rx="1.5" fill="#6d7581"/>
<rect x="24" y="28" width="9" height="4" rx="1.5" fill="#b0703a"/></g>`),
  dynamite: icon(`<rect x="12" y="14" width="10" height="28" rx="2.5" fill="#e0422f"/>
<rect x="24" y="14" width="10" height="28" rx="2.5" fill="#e0422f"/>
<rect x="10" y="24" width="26" height="6" rx="1.5" fill="#3b3130"/>
<path d="M23 14q0-6 6-8" fill="none" stroke="#3b3130" stroke-width="2"/>
<path d="M29 2l2 3.5 3.5-1-2 3.5 3 2-4 .3-1 3.5-1.3-3.5-4-.3 3-2-2-3.5 3.5 1Z" fill="#ffd23a" stroke="#e0762b" stroke-width="1"/>`),
  cluster: icon(`<circle cx="22" cy="27" r="12" fill="#5d6470"/>
<rect x="18" y="11" width="8" height="5" rx="1.5" fill="#8d96a3"/>
<circle cx="18" cy="23" r="3" fill="#848c99" stroke="none"/>
<circle cx="38" cy="15" r="4" fill="#f2c230"/><circle cx="40" cy="27" r="3.4" fill="#f2c230"/>
<circle cx="36" cy="37" r="3" fill="#f2c230"/>`),
  banana: icon(`<path d="M9 13q-2 22 16 27t16-8q-12 7-22-3T15 12Z" fill="#ffd93b"/>
<path d="M13 12l-2-5 5 1Z" fill="#6b4a2b"/><path d="M15 20q3 12 16 14" fill="none" stroke="#e0a91f" stroke-width="1.6"/>`),
  airstrike: icon(`<path d="M24 5l3 9v8l16 8v4l-16-4v8l5 4v3l-8-2-8 2v-3l5-4v-8L5 34v-4l16-8v-8Z" fill="#9aa4b3"/>
<path d="M24 8v28" stroke="#6d7581" stroke-width="1.4" fill="none"/>`),
  homing: icon(`<circle cx="33" cy="15" r="9" fill="none" stroke="#e0422f" stroke-width="2.4"/>
<circle cx="33" cy="15" r="3" fill="#e0422f" stroke="none"/>
<g transform="rotate(-40 18 30)"><rect x="5" y="26" width="26" height="8" rx="4" fill="#d9dde3"/>
<path d="M31 26q7 4 0 8Z" fill="#e0422f"/><path d="M6 26l-4-5h7l3 5ZM6 34l-4 5h7l3-5Z" fill="#8d96a3"/></g>`),
  sheep: icon(`<g fill="#fbfbf6"><circle cx="17" cy="22" r="7"/><circle cx="26" cy="19" r="7"/><circle cx="31" cy="27" r="7"/>
<circle cx="21" cy="30" r="7"/><circle cx="14" cy="28" r="5"/></g>
<path d="M17 36v6M28 36v6" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="38" cy="22" rx="5.5" ry="6.5" fill="#2c2c30"/>
<circle cx="39.5" cy="20.5" r="1.4" fill="#fff" stroke="none"/>`),
};

/** Fallback icon for weapons without art yet. */
export const PLACEHOLDER_ICON = icon(`<rect x="8" y="8" width="32" height="32" rx="8" fill="#4a5262"/>
<path d="M19 19q0-5 5-5t5 5q0 3-3 4.5T24 28v1" fill="none" stroke="#dfe3ea" stroke-width="3.2" stroke-linecap="round"/>
<circle cx="24" cy="34.5" r="2" fill="#dfe3ea" stroke="none"/>`);

export const weaponIcon = (id: string): string => WEAPON_ICONS[id] ?? PLACEHOLDER_ICON;
